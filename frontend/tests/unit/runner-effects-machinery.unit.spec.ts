/**
 * R2.1: the effects machinery (shared/runner/effects.ts, server/runner/effects/)
 * and its three pilots (Exposure, Invert, Threshold), against the real Python
 * nodes (scripts/runner_effects_fixtures.py --group machinery →
 * fixtures/runner-effects-machinery.json). The pilots are *exact*: every
 * float bit for bit.
 */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import {
  b64, coreOp, expectBand, expectExact, expectExactHash, filesOfValue, interleaved, loadFixtures, memoryIO,
  paramsOf, pictureOf, pngPixels, runEffectCase, sha256, synth, tensorsOf, withAssets, bandOf, type FxCase, type FxFile,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import { CARD_MAX_PIXELS, IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_ERROR_MESSAGES, EFFECT_PICTURES_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED,
  EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_MAX_WORK, EFFECT_PICTURE_ANIMATED, EFFECT_PREVIEW_NAME_RE, EFFECT_TOO_MUCH_WORK, effectPreviewName,
} from '#shared/runner/effects'
import { PREVIEW_NAME_RE } from '~~/server/runner/results'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { EFFECTS, type EffectSpec } from '~~/server/runner/effects/table'
import { EFFECT_IO_WORK_PER_VALUE } from '~~/server/runner/effects/plan'
import { effectCores } from '~~/server/runner/effects/cores'
import { tensorCore } from '~~/server/runner/effects/core/tensor'
import { toneCore } from '~~/server/runner/effects/core/tone'
import { pixels, pixelsCore } from '~~/server/runner/pixels/core'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'
import { maskPngFromScanlines, readMaskPng } from '~~/server/runner/compositor/keep'

/** Counts every picture decode (the caps are checked from headers alone). */
const decodes = vi.hoisted(() => ({ n: 0 }))
vi.mock('~~/server/runner/compositor/decode', async (importOriginal) => {
  const m = await importOriginal<typeof import('~~/server/runner/compositor/decode')>()
  return { ...m, decodeRaw: (...a: Parameters<typeof m.decodeRaw>) => { decodes.n++; return m.decodeRaw(...a) } }
})

interface ChainStep { class_type: string; node_id: string; widgets: Record<string, unknown>; outputs: NonNullable<FxCase['outputs']>; ui: FxCase['ui']; preview: NonNullable<FxCase['preview']> }
interface Chain { name: string; inputs: FxCase['inputs']; steps?: ChainStep[]; effect?: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame?: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
interface MachineryFx extends FxFile {
  synth: { w: number; h: number; channels: number; seed: number; sha256: string }[]
  rgba_preview: { mode: string; w: number; h: number; px: string }
  chains: Chain[]
}
const FX = withAssets(loadFixtures<MachineryFx>('machinery'))

const TONE: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone'])
const TONE_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone', 'fal-edit'])
const TONE_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const find = (name: string) => {
  const c = FX.cases.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const effect = (cls: string, from: [string, number], widgets: Record<string, unknown>) => ({ class_type: cls, inputs: { image: from, ...widgets } })
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
const put = (root: string, name: string, bytes: Uint8Array) => {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

// ── synth ────────────────────────────────────────────────────────────────────

describe('synth', () => {
  it('agrees with Python on the 10 recorded pictures', () => {
    expect(FX.synth).toHaveLength(10)
    for (const s of FX.synth) expect(sha256(synth(s.w, s.h, s.channels, s.seed)), `${s.w}×${s.h}×${s.channels} seed ${s.seed}`).toBe(s.sha256)
  })

  it('the fixtures were made by multi-threaded torch', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect(FX.band_eps).toBeLessThanOrEqual(2 ** -8)
  })
})

// ── The pilots, case by case (rule 12) ───────────────────────────────────────

/** The case's outputs from the core called in this thread, one result per batch index. */
async function coreRun(c: FxCase) {
  const op = coreOp(EFFECTS[c.class_type]!.op)
  return (await tensorsOf(c)).map(inp => op(inp, paramsOf(c)))
}

describe('the pilots against Python (exact)', () => {
  for (const c of FX.cases) {
    it(`core: ${c.name}`, async () => {
      expect(c.error).toBeUndefined()
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      expect(runs).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const t = runs[i]!.outputs[0]!
        expect([t.w, t.h, t.c]).toEqual([item.w, item.h, item.c])
        const f = interleaved(t)
        if (item.f32) expectExact(f, item.f32, `${c.name}, picture ${i}`)
        else expectExactHash(f, item.f32_sha256!, `${c.name}, picture ${i}`)
      }
    })

    it(`planEffect: ${c.name}`, async () => {
      const items = c.outputs![0]!.items
      // Read by nothing (or a provider): kept as the hand-off's round.
      const run = await runEffectCase(c, { families: TONE })
      const files = filesOfValue(run.made.values[0])
      expect(run.made.values[0]!.kind).toBe('files')
      expect(files).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(run.bytes(files[i]!))
        expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
        if (item.round8) expect(Buffer.compare(got.px, b64(item.round8)), `${c.name}, kept ${i}`).toBe(0)
        else expect(sha256(got.px), `${c.name}, kept ${i}`).toBe(item.round8_sha256)
      }
      // The live preview: the first picture, as save_live_preview writes it.
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      if (c.preview!.px) expect(Buffer.compare(pv.px, b64(c.preview!.px))).toBe(0)
      else expect(sha256(pv.px)).toBe(c.preview!.px_sha256)
      // The ui is Python's (the runner's preview lives in its own temp subfolder).
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c)
      const saved = await runEffectCase(c, { families: TONE, prompt: { ...p.prompt, save: saveImage([c.node_id, 0]) } })
      const tfiles = filesOfValue(saved.made.values[0])
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(saved.bytes(tfiles[i]!))
        if (item.trunc8) expect(Buffer.compare(got.px, b64(item.trunc8)), `${c.name}, kept trunc ${i}`).toBe(0)
        else expect(sha256(got.px), `${c.name}, kept trunc ${i}`).toBe(item.trunc8_sha256)
      }
    })
  }

  it('the band helper: each mode has its own band; a result off by one passes only inside its own mode\'s band', () => {
    const c = FX.cases.find(x => x.hashed && x.class_type === 'AdjustInvert')!
    const item = c.outputs![0]!.items[0]!
    const trunc = bandOf(item.band!, 'trunc')
    const round = bandOf(item.band!, 'round')
    expect([trunc.length, round.length]).toEqual([item.band!.trunc.count, item.band!.round.count])
    // Invert of b / 255 lands on the trunc grid everywhere and on no half: Python's bytes there are its trunc8.
    expect(trunc.length).toBe(320 * 200 * 3)
    expect(round).toHaveLength(0)
    const py = new Uint8Array(trunc.map(([, v]) => v))
    expect(sha256(py)).toBe(item.trunc8_sha256)
    const bump = (a: Uint8Array) => { const t = a.slice(); t[0] = t[0] === 255 ? 254 : t[0]! + 1; return t }
    expectBand(bump(py), py, null, trunc, FX.band_eps, 'trunc')
    const far = py.slice()
    far[0] = (far[0]! + 2) & 255
    expect(() => expectBand(far, py, null, trunc, FX.band_eps, 'trunc')).toThrow()
    // The same one-level slip in round mode, where no value is near a half: refused.
    expect(() => expectBand(bump(py), py, null, round, FX.band_eps, 'round')).toThrow()
    // And from a small case's floats: b / 255 values are near trunc's edges, not round's.
    const small = find('AdjustExposure: defaults, rgb 37×23').outputs![0]!.items[0]!
    const f32 = new Float32Array(Uint8Array.from(b64(small.f32!)).buffer)
    const r8 = b64(small.round8!)
    const t8 = b64(small.trunc8!)
    expectBand(bump(t8), t8, f32, null, FX.band_eps, 'trunc')
    expect(() => expectBand(bump(r8), r8, f32, null, FX.band_eps, 'round')).toThrow()
  })
})

// ── The machinery ────────────────────────────────────────────────────────────

describe('chains: an effect hands the next effect its float tensor, as Python does (fix round 1)', () => {
  for (const ch of FX.chains.filter(x => x.steps)) {
    it(ch.name, async () => {
      const [a, b] = ch.steps!
      const file = ch.inputs.image!.files[0]!
      const source = ch.inputs.image!.source
      const files: Record<string, Uint8Array> = { [file]: b64(FX.assets[file]!) }
      const prompt: ApiPrompt = {
        src: sourceNodeOf(source, file),
        [a!.node_id]: effect(a!.class_type, ['src', 0], a!.widgets),
        [b!.node_id]: effect(b!.class_type, [a!.node_id, 0], b!.widgets),
      }
      const mem = memoryIO(files, a!.node_id)
      const values: Record<string, Record<number, RunnerValue>> = {}
      const ctx = (nodeId: string) => ({
        prompt, nodeId, families: TONE, gateOpen: false, toUrl: async () => '',
        filesFrom: (l: [string, number]): OutputFile[] => l[0] === 'src' ? [{ filename: file, subfolder: '', type: 'input' }] : filesOfValue(values[l[0]]![l[1]]),
        valueFrom: (l: [string, number]) => values[l[0]]?.[l[1]],
      })
      const first = await planNode(ctx(a!.node_id)) as Extract<NodePlan, { kind: 'derive' }>
      values[a!.node_id] = (await first.derive(mem.io)).values
      // Read by an effect: the float tensor is kept beside the PNG.
      const va = values[a!.node_id]![0] as Extract<RunnerValue, { kind: 'files' }>
      expect(va.tensors).toHaveLength(1)
      expect(va.tensors![0]!.filename).toMatch(/\.bin$/)
      // As a restarted server reads it back: the record's values as JSON.
      values[a!.node_id] = JSON.parse(JSON.stringify(values[a!.node_id]))
      const second = await planNode({ ...ctx(b!.node_id) }) as Extract<NodePlan, { kind: 'derive' }>
      const made = await second.derive({ ...mem.io, nodeId: b!.node_id })
      const out = await pngPixels(mem.bytes(filesOfValue(made.values[0])[0]!))
      const item = b!.outputs[0]!.items[0]!
      expect([out.w, out.h, out.channels]).toEqual([item.w, item.h, item.c])
      if (item.round8) expect(Buffer.compare(out.px, b64(item.round8))).toBe(0)
      else expect(sha256(out.px)).toBe(item.round8_sha256)
      // Its own reader is nothing: no tensor kept for the last step.
      expect((made.values[0] as Extract<RunnerValue, { kind: 'files' }>).tensors).toBeUndefined()
      const pv = await pngPixels(mem.previews.at(-1)!.bytes)
      if (b!.preview.px) expect(Buffer.compare(pv.px, b64(b!.preview.px))).toBe(0)
      else expect(sha256(pv.px)).toBe(b!.preview.px_sha256)
    })
  }

  it('without the tensor (the 8-bit PNG alone), the chains would not match Python: the float is what makes them exact', async () => {
    const ch = FX.chains.find(x => x.name === 'Exposure 0.3 → Threshold 0.5, rgb')!
    const [a, b] = ch.steps!
    const file = ch.inputs.image!.files[0]!
    const raw = await decodeRaw(b64(FX.assets[file]!), 'rgb')
    const x = effectCores.tk.fromPicture(raw)
    const mid = effectCores.tone.AdjustExposure({ image: x }, a!.widgets).outputs[0]!
    // Through 8 bits, as a provider would get it.
    const via8 = effectCores.tk.fromPicture({ source: 'rgb', w: mid.w, h: mid.h, data: rgbaOf(effectCores.tk.quantize(mid, 'round'), 3) })
    const lossy = effectCores.tone.AdjustThreshold({ image: via8 }, b!.widgets).outputs[0]!
    const exact = effectCores.tone.AdjustThreshold({ image: mid }, b!.widgets).outputs[0]!
    const item = b!.outputs[0]!.items[0]!
    expectExactHash(interleaved(exact), item.f32_sha256!)
    expect(sha256(new Uint8Array(interleaved(lossy).buffer))).not.toBe(item.f32_sha256)
  })
})

/** Interleaved c-channel bytes as RGBA8 (alpha 255). */
function rgbaOf(px: Uint8Array, c: number): Uint8Array {
  const n = px.length / c
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) out[i * 4 + k] = px[i * c + k]!
    if (c === 3) out[i * 4 + 3] = 255
  }
  return out
}

const sourceNodeOf = (source: string, file: string): ApiPrompt[string] => source === 'rgb' ? { class_type: 'Compositor', inputs: {} } : card(file)

describe('channels and the tensor wire source', () => {
  it('a provider picture through Adjust threshold keeps 4 channels: the kept PNG is RGBA and so is the preview, as Python writes it', async () => {
    const c = find('AdjustThreshold: defaults, provider 29×31')
    expect(c.preview!.mode).toBe('RGBA')
    const run = await runEffectCase(c, { families: TONE })
    const kept = await pngPixels(run.bytes(filesOfValue(run.made.values[0])[0]!))
    expect(kept.channels).toBe(4)
    expect((await pngPixels(run.previews[0]!.bytes)).channels).toBe(4)
    // save_live_preview itself keeps a 4-channel tensor's alpha.
    expect(FX.rgba_preview.mode).toBe('RGBA')
    const t4 = effectCores.tk.fromPicture({ source: 'provider', w: 5, h: 4, data: synth(5, 4, 4, 8) })
    expect(Buffer.compare(effectCores.tk.quantize(t4, 'trunc'), b64(FX.rgba_preview.px))).toBe(0)
  })

  it('the wire source \'tensor\': an RGBA kept PNG reads as 4 channels and an RGB one as 3, in a following pilot and in a Frame', async () => {
    const rgba = find('AdjustInvert: defaults, card 23×19 see-through')
    const rgb = find('AdjustInvert: defaults, rgb 37×23')
    for (const [c, channels] of [[rgba, 4], [rgb, 3]] as const) {
      const run = await runEffectCase(c, { families: TONE })
      const file = filesOfValue(run.made.values[0])[0]!
      const kept = run.bytes(file)
      const raw = await decodeRaw(kept, 'tensor')
      expect(raw.source).toBe(channels === 4 ? 'provider' : 'rgb')
      expect(pixels.tensorChannels(raw)).toBe(channels)
      // A following pilot (Invert again) reads the kept PNG as its tensor: the kept bytes / 255 on every channel.
      const p: ApiPrompt = { a: { class_type: 'AdjustInvert', inputs: {} }, b: effect('AdjustInvert', ['a', 0], { amount: 0 }) }
      expect(pictureSourceOf(p, ['a', 0])).toBe('tensor')
      const mem = memoryIO({}, 'b')
      mem.store.set(`kept:run_x/${file.filename}`, kept)
      const plan = await planNode({ prompt: p, nodeId: 'b', families: TONE, gateOpen: false, filesFrom: () => [file], toUrl: async () => '' }) as Extract<NodePlan, { kind: 'derive' }>
      const made = await plan.derive(mem.io)
      const again = await pngPixels(mem.bytes(filesOfValue(made.values[0])[0]!))
      expect(again.channels).toBe(channels)
      expect(Buffer.compare(again.px, (await pngPixels(kept)).px)).toBe(0)
      // A Frame reads it as it reads the same PNG from a provider (RGBA) or another Frame (RGB).
      const f: ApiPrompt = { a: { class_type: 'AdjustInvert', inputs: {} }, f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['a', 0] }) } }
      expect(pictureSourceOf(f, ['a', 0])).toBe('tensor')
    }
  })
})

describe('masks', () => {
  it('a mask kept by the runner (16-bit) reads back into a tensor as u / 65535, as Python\'s mask loader reads it', async () => {
    const tk = effectCores.tk
    const t = tk.tensor(1, 3, 5)
    t.data.set([0, 1, 0.5, 0.25, 1 / 3, 0.999, 1e-6, 0.75, 0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8].map(Math.fround))
    const png = await maskPngFromScanlines(tk.mask16(t), 5, 3)
    const back = await readMaskPng(png)
    const r = tk.fromMask16(back.scanlines, back.w, back.h)
    expect([r.c, r.h, r.w]).toEqual([1, 3, 5])
    for (let i = 0; i < 15; i++) expect(r.data[i]).toBe(Math.fround(Math.floor(t.data[i]! * 65535 + 0.5) / 65535))
  })
})

describe('batches', () => {
  it('two files and a repeat give three results in order, the repeat worked on once; a 1×1 blank gives Python\'s 1×1 result', async () => {
    const c = find('AdjustExposure: a batch of two files and a repeat')
    const posted = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      const run = await runEffectCase(c, { families: TONE })
      const ops = posted.mock.calls.map(([m]) => (m as { op?: string }).op)
      expect(ops.filter(o => o === 'fx.run')).toHaveLength(2)
      expect(ops.filter(o => o === 'fx.begin')).toHaveLength(1)
      expect(ops.filter(o => o === 'fx.end')).toHaveLength(1)
      const files = filesOfValue(run.made.values[0])
      expect(files).toHaveLength(3)
      expect(files[0]).toEqual(files[2])
      expect(files[1]).not.toEqual(files[0])
      expect(run.kept()).toBe(2)
    }
    finally { posted.mockRestore() }
    const blank = find('AdjustInvert: the 1×1 blank')
    const run = await runEffectCase(blank, { families: TONE })
    const got = await pngPixels(run.bytes(filesOfValue(run.made.values[0])[0]!))
    expect([got.w, got.h, got.channels]).toEqual([1, 1, 3])
    expect(Buffer.compare(got.px, b64(blank.outputs![0]!.items[0]!.round8!))).toBe(0)
  })

  it('inputs batched together must come in equal numbers or one of them 1 (rule 5)', () => {
    expect(EFFECT_ERROR_MESSAGES.EFFECT_BATCHES_DIFFER).toBe('The pictures this effect combines come in different numbers')
    expect(EFFECT_ERROR_MESSAGES.EFFECT_NEEDS_RGB).toBe('This effect can’t work on a picture with see-through parts')
    expect(EFFECT_ERROR_MESSAGES.EFFECT_PICTURE_TOO_SMALL).toBe('This picture is too small for this setting. Lower the setting or use a larger picture.')
  })
})

describe('each file is read once (fix round 1)', () => {
  it('a batch of two files and a repeat reads each file once: its header for the caps, its bytes for the decode', async () => {
    const c = find('AdjustExposure: a batch of two files and a repeat')
    const p = pictureOf(c)
    const mem = memoryIO(p.files, c.node_id)
    const reads = new Map<string, number>()
    const read = mem.io.read
    mem.io.read = async (f) => { reads.set(f.filename, (reads.get(f.filename) ?? 0) + 1); return read(f) }
    const plan = await planNode({ prompt: p.prompt, nodeId: c.node_id, families: TONE, gateOpen: false, filesFrom: p.filesOf, toUrl: async () => '' }) as Extract<NodePlan, { kind: 'derive' }>
    await plan.derive(mem.io)
    expect(Object.fromEntries(reads)).toEqual(Object.fromEntries([...new Set(c.inputs.image!.files)].map(f => [f, 1])))
  })
})

describe('caps, from the headers, before any picture is decoded (rule 7)', () => {
  const blankPng = async (w: number, h: number) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: '#000' } }).png().toBuffer())
  const caseWith = (file: string, count = 1): FxCase => ({
    name: 'cap', class_type: 'AdjustInvert', node_id: 'fx', widgets: { amount: 1 }, inputs: { image: { source: 'provider', files: Array.from({ length: count }, (_, i) => `${i}_${file}`) } },
  })
  const run = (c: FxCase, files: Record<string, Uint8Array>, hosted = false) => runEffectCase(c, { families: TONE, hosted, files })

  it('a picture over 8192² fails with the plain message before any fx.run; hosted, over 4096²', async () => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      const before = decodes.n
      const big = await blankPng(8193, 8192)
      await expect(run(caseWith('big.png'), { '0_big.png': big })).rejects.toThrow(EFFECT_PICTURE_TOO_LARGE)
      const mid = await blankPng(4097, 4096)
      await expect(run(caseWith('mid.png'), { '0_mid.png': mid }, true)).rejects.toThrow(EFFECT_PICTURE_TOO_LARGE_HOSTED)
      expect(decodes.n).toBe(before)
      expect(posted.mock.calls.map(([m]) => (m as { op?: string }).op).filter(o => o === 'fx.run')).toHaveLength(0)
    }
    finally { posted.mockRestore() }
  }, 60_000)

  it('work a class declares over EFFECT_MAX_WORK fails before any fx.run', async () => {
    const table = EFFECTS as Record<string, EffectSpec>
    const spec = table.AdjustInvert!
    const seen: [unknown, unknown][] = []
    table.AdjustInvert = { ...spec, work: (w, size) => { seen.push([w, size]); return EFFECT_MAX_WORK + 1 } }
    const posted = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      const c = find('AdjustInvert: amount between (0.37), provider 29×31')
      await expect(runEffectCase(c, { families: TONE })).rejects.toThrow(EFFECT_TOO_MUCH_WORK)
      expect(seen).toEqual([[{ amount: 0.37 }, { w: 29, h: 31 }]])
      expect(posted.mock.calls.map(([m]) => (m as { op?: string }).op).filter(o => o === 'fx.run')).toHaveLength(0)
      // Reading and writing the picture counts too (fix round 1): 29 × 31 pixels in and out, 4 values each.
      table.AdjustInvert = { ...spec, work: () => EFFECT_MAX_WORK - EFFECT_IO_WORK_PER_VALUE * 4 * 2 * 29 * 31 }
      await expect(runEffectCase(c, { families: TONE })).resolves.toBeTruthy()
      table.AdjustInvert = { ...spec, work: () => EFFECT_MAX_WORK - EFFECT_IO_WORK_PER_VALUE * 4 * 2 * 29 * 31 + 1 }
      await expect(runEffectCase(c, { families: TONE })).rejects.toThrow(EFFECT_TOO_MUCH_WORK)
    }
    finally {
      table.AdjustInvert = spec
      posted.mockRestore()
    }
  })

  it('the total over CARD_MAX_PIXELS fails, before any picture is decoded', async () => {
    const big = await blankPng(8192, 8192)
    const c = caseWith('p.png', 5)
    const files = Object.fromEntries(c.inputs.image!.files.map(f => [f, big]))
    const before = decodes.n
    expect(5 * 8192 * 8192).toBeGreaterThan(CARD_MAX_PIXELS)
    await expect(run(c, files)).rejects.toThrow(EFFECT_PICTURES_TOO_LARGE)
    expect(decodes.n).toBe(before)
  }, 60_000)
})

describe('Stop', () => {
  it('the core stops within one 64-row block', () => {
    const tk = effectCores.tk
    const x = tk.tensor(3, 256, 4)
    let calls = 0
    const stop = () => ++calls >= 2
    expect(() => effectCores.tone.AdjustInvert({ image: x }, { amount: 1 }, stop)).toThrow('Stopped')
    // Checked at row 0 (go on) and row 64 (stop): the first block of 64 rows was the only work done.
    expect(calls).toBe(2)
  })

  it('reading a picture into a tensor, quantising it and its luma stop within one 64-row block too', () => {
    const tk = effectCores.tk
    const picture = { source: 'provider', w: 4, h: 256, data: new Uint8Array(4 * 256 * 4) }
    const x = tk.tensor(3, 256, 4)
    for (const [label, run] of [
      ['fromPicture', (stop: () => boolean) => tk.fromPicture(picture, stop)],
      ['quantize', (stop: () => boolean) => tk.quantize(x, 'round', stop)],
      ['luma709', (stop: () => boolean) => tk.luma709(x, stop)],
    ] as const) {
      let calls = 0
      expect(() => run(() => ++calls >= 2), label).toThrow('Stopped')
      expect(calls, label).toBe(2)
    }
  })

  it('stopped mid-batch: nothing is written after Stop', async () => {
    const c = find('AdjustExposure: a batch of two files and a repeat')
    const p = pictureOf(c)
    const stop = new AbortController()
    const mem = memoryIO(p.files, c.node_id, { signal: stop.signal })
    const keep = mem.io.keep
    let kept = 0
    mem.io.keep = async (bytes, ext) => {
      kept++
      const f = await keep(bytes, ext)
      stop.abort()
      return f
    }
    const plan = await planNode({ prompt: p.prompt, nodeId: c.node_id, families: TONE, gateOpen: false, filesFrom: p.filesOf, toUrl: async () => '' }) as Extract<NodePlan, { kind: 'derive' }>
    await expect(plan.derive(mem.io)).rejects.toThrow('Stopped')
    expect(kept).toBe(1)
    expect(mem.previews).toHaveLength(0)
  })
})

// ── Eligibility and families ─────────────────────────────────────────────────

describe('families', () => {
  const p: ApiPrompt = { 0: card('a.png'), fx: effect('AdjustExposure', ['0', 0], { exposure: 0.5 }) }

  it('with effects-tone on and cards off, parseFamilies drops effects-tone, and the workflow is left to the engine', () => {
    const f = parseFamilies('effects-tone,fal-edit')
    expect([...f]).toEqual(['fal-edit'])
    expect([...parseFamilies('effects-tone,cards')].sort()).toEqual(['cards', 'effects-tone'])
    expect(runnerTakesWorkflow(p, f)).toBe(false)
    // Built by hand (not parsed), the rule still wants cards.
    expect(runnerTakesWorkflow(p, new Set<RunnerFamily>(['effects-tone']))).toBe(false)
    expect(runnerTakesWorkflow(p, TONE)).toBe(true)
  })

  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur'])]) {
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toEqual(['fx'])
    }
    expect(nodesNeedingEngine(p, { runnerOn: true, families: TONE, titleOf: id => id })).toEqual([])
  })

  it('an effect counts as work; its picture feeds a provider or a Frame only while its family is on', () => {
    expect(isRunnerEligible(p, TONE)).toBe(true)
    const q: ApiPrompt = { ...p, e: editNode(['fx', 0]), o: outCard('e') }
    expect(isRunnerEligible(q, TONE_EDIT)).toBe(true)
    expect(isRunnerEligible(q, new Set<RunnerFamily>(['cards', 'fal-edit']))).toBe(false)
    const f: ApiPrompt = { ...p, f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }
    expect(isRunnerEligible(f, TONE_FRAME)).toBe(true)
    expect(isRunnerEligible(f, new Set<RunnerFamily>(['cards', 'frame']))).toBe(false)
  })

  it('widgets ComfyUI would refuse, a wired widget, or a node id the preview can\'t be named after leave it to the engine', () => {
    const take = (inputs: Record<string, unknown>, id = 'fx') => runnerTakesNode({ 0: card('a.png'), [id]: { class_type: 'AdjustExposure', inputs: { image: ['0', 0], ...inputs } } }, id, TONE)
    expect(take({ exposure: 3 })).toBe(true)
    expect(take({ exposure: 3.01 })).toBe(false)
    expect(take({ exposure: 'x' })).toBe(false)
    expect(take({ exposure: ['0', 0] })).toBe(false)
    expect(take({})).toBe(false)
    expect(take({ exposure: 1 }, '12:3')).toBe(false)
    expect(take({ exposure: 1 }, 'Größe_7')).toBe(true)
    expect(runnerTakesNode({ fx: { class_type: 'AdjustExposure', inputs: { exposure: 1 } } }, 'fx', TONE)).toBe(false)
    expect(effectPreviewName('12:3')).toBeNull()
    expect(effectPreviewName('7')).toBe('live_preview_7.png')
    expect(EFFECT_PREVIEW_NAME_RE.source).toBe(PREVIEW_NAME_RE.source)
    expect(EFFECT_PREVIEW_NAME_RE.flags).toBe(PREVIEW_NAME_RE.flags)
  })

  it('node by node: each pilot, its source card and its reader, with cards on and off', () => {
    for (const cls of Object.keys(EFFECTS)) {
      const w = cls === 'AdjustExposure' ? { exposure: 1 } : cls === 'AdjustInvert' ? { amount: 1 } : { threshold: 0.5 }
      const q: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], w), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      // Cards and the family on: every node.
      expect(take(['cards', 'effects-tone', 'fal-edit']), cls).toEqual({ 0: true, fx: true, e: true, o: true })
      // Cards off, or the family off: only the effect is refused (the edit's own row checks no
      // picture source), and so the workflow goes to the engine whole.
      for (const fam of [['effects-tone', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-blur', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam), `${cls} ${fam}`).toEqual({ 0: true, fx: false, e: true, o: true })
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('a mask or a video is not a picture for an effect', () => {
    const take = (from: ApiPrompt[string]) => runnerTakesNode({ s: from, fx: effect('AdjustInvert', ['s', 0], { amount: 1 }) }, 'fx', TONE)
    expect(take({ class_type: 'Video', inputs: { file: 'a.mp4' } })).toBe(false)
    expect(runnerTakesNode({ s: { class_type: 'ImageToMask', inputs: { image: ['c', 0], channel: 'red' } }, c: card('a.png'), fx: effect('AdjustInvert', ['s', 0], { amount: 1 }) }, 'fx', TONE)).toBe(false)
    expect(take(card('a.png'))).toBe(true)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/**
 * The graph with an effect of class `cls` spliced in after every picture
 * output (slot 0 of an image class, or a PICTURE_OUTPUTS slot): its readers
 * read the effect instead.
 */
function spliceAfterPictures(p: ApiPrompt, cls: string): { prompt: ApiPrompt; count: number } {
  const out: ApiPrompt = JSON.parse(JSON.stringify(p))
  const w = cls === 'AdjustExposure' ? { exposure: 1 } : cls === 'AdjustInvert' ? { amount: 1 } : { threshold: 0.5 }
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
      out[fx] = effect(cls, [id, slot], w)
      count++
    }
  }
  return { prompt: out, count }
}

/**
 * The prompt as the runner read it before R2.1: no effect class had a row, so
 * each read as a class it had never heard of (nothing in the runner named
 * one). A renamed class stands in for that.
 */
function withoutEffects(p: ApiPrompt): ApiPrompt {
  return Object.fromEntries(Object.entries(p).map(([id, n]) => [id, Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, n.class_type) ? { ...n, class_type: `${n.class_type}__unknown` } : n]))
}
const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['cards, frame, fal-edit', ['cards', 'frame', 'fal-edit']],
  ['every family but the effects', RUNNER_FAMILIES.filter(f => !(EFFECT_FAMILIES as readonly string[]).includes(f))],
  ['every family but cards', ['fal-edit', 'frame', 'effects-tone', 'effects-blur']],
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
  it('over synthetic graphs with each pilot in each place', () => {
    for (const cls of Object.keys(EFFECTS)) {
      const w = cls === 'AdjustExposure' ? { exposure: 1 } : cls === 'AdjustInvert' ? { amount: 1 } : { threshold: 0.5 }
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w) }, `${cls} alone`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), e: editNode(['fx', 0]), o: outCard('e') }, `${cls} → edit`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), s: saveImage(['fx', 0]) }, `${cls} → save`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }, `${cls} → Frame`)
      sameAsBefore({ g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, fx: effect(cls, ['g', 0], w) }, `generate → ${cls}`)
      sameAsBefore({ fx: effect(cls, ['9', 0], w) }, `${cls} reading outside`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], { ...w, exposure: 99, amount: 9, threshold: 9 }), o: outCard('0') }, `${cls} invalid beside a card`)
    }
  })

  // The saved projects are this machine's own data (no other checkout has them): with the
  // folder missing the check is skipped, visibly, and the synthetic graphs above stay the guard.
  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (user/sailor/projects), and each with every pilot spliced in after every picture', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let spliced = 0
    let pictures = 0
    let changedWhenOn = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        sameAsBefore(p, uuid)
        graphs++
        for (const cls of Object.keys(EFFECTS)) {
          const s = spliceAfterPictures(p, cls)
          if (!s.count) continue
          sameAsBefore(s.prompt, `${uuid} with ${cls}`)
          // With the effects on, the pilots are taken: the same graphs read differently (the guard has teeth).
          const on = new Set<RunnerFamily>(RUNNER_FAMILIES)
          if (JSON.stringify(nodesNeedingEngine(s.prompt, { runnerOn: true, families: on, titleOf: id => id })) !== JSON.stringify(nodesNeedingEngine(withoutEffects(s.prompt), { runnerOn: true, families: on, titleOf: id => id }))) changedWhenOn++
          spliced++
          pictures += s.count
        }
      }
    }
    // Lower bounds, not exact counts: the folder is live data (every save changes it).
    // On 2026-09-26: 866 graphs, 1,827 graphs with a pilot spliced in, 3,849 pilots.
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(spliced).toBeGreaterThanOrEqual(1500)
    expect(pictures).toBeGreaterThanOrEqual(3000)
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`families-off invariant: ${graphs} saved graphs, ${spliced} with a pilot spliced in, ${pictures} pilots, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-tone on)', () => {
  const c = find('AdjustInvert: amount between (0.37), card 23×19 see-through')
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an Image card whose file is 16-bit is refused at the start of the take, before the hold', async () => {
    const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { refused: { name: string; file: string }[] }
    const k = makeKit({ hosted: true, deps: { families: () => TONE } })
    put(k.root, 'deep.png', b64(VALUES.refused.find(x => x.name === 'a 16-bit greyscale PNG')!.file))
    const p: ApiPrompt = { 0: card('deep.png'), fx: effect('AdjustInvert', ['0', 0], { amount: 1 }) }
    expect(isRunnerEligible(p, TONE)).toBe(true)
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }))
      .rejects.toMatchObject({ statusCode: 400, message: 'This picture is 16-bit. Save it as an 8-bit picture and load it again.' })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a loader\'s animation behind an effect (Python makes a batch of its frames) is refused at the start, before the hold', async () => {
    const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { rgb_turned: { name: string; file: string }[] }
    const loadImage = (n: string) => ({ class_type: 'LoadImage', inputs: { image: n, upload: 'image' } })
    for (const name of ['a two-frame GIF', 'a two-frame animated PNG']) {
      for (const make of [loadImage, card]) {
        const k = makeKit({ hosted: true, deps: { families: () => TONE } })
        put(k.root, 'anim.bin', b64(VALUES.rgb_turned.find(x => x.name === name)!.file))
        // Straight in, and through an Image card fed by the loader.
        for (const p of [
          { 0: make('anim.bin'), fx: effect('AdjustInvert', ['0', 0], { amount: 1 }) },
          { 0: make('anim.bin'), 1: outCard('0'), fx: effect('AdjustInvert', ['1', 0], { amount: 1 }) },
        ] as ApiPrompt[]) {
          expect(isRunnerEligible(p, TONE)).toBe(true)
          await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), `${name} ${make('x').class_type}`)
            .rejects.toMatchObject({ statusCode: 400, message: EFFECT_PICTURE_ANIMATED })
        }
        expect(k.ledger.hold).not.toHaveBeenCalled()
      }
    }
    // The node's own check is the backstop (a picture that arrives some other way).
    const c: FxCase = { name: 'anim', class_type: 'AdjustInvert', node_id: 'fx', widgets: { amount: 1 }, inputs: { image: { source: 'card', files: ['anim.bin'] } } }
    await expect(runEffectCase(c, { families: TONE, files: { 'anim.bin': b64(VALUES.rgb_turned.find(x => x.name === 'a two-frame GIF')!.file) } }))
      .rejects.toThrow(EFFECT_PICTURE_ANIMATED)
  })

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => TONE_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect('AdjustInvert', ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, TONE_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[c.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.files[0]!.type).toBe('kept')
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await pngPixels(uploads[0]![0])
    expect(sent.channels).toBe(4)
    expect(Buffer.compare(sent.px, b64(item.round8!))).toBe(0)
    // Its live preview is in temp, as Python names it.
    const shown = k.seen.filter(m => m.type === 'executed' && (m as unknown as { data: { node: string } }).data.node === c.node_id)
    expect(shown).toHaveLength(1)
    const images = (shown[0] as unknown as { data: { output: { images: OutputFile[] } } }).data.output.images
    expect(images.map(i => [i.filename, i.type])).toEqual([[`live_preview_${c.node_id}.png`, 'temp']])
    const preview = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'temp', images[0]!.subfolder, images[0]!.filename))))
    expect(Buffer.compare(preview.px, b64(c.preview!.px!))).toBe(0)
  })

  it('an effect → Save image saves the trunc picture', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => TONE } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect('AdjustInvert', ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(Buffer.compare(saved.px, b64(item.trunc8!))).toBe(0)
  })

  it('an effect → Frame: the Frame gets the effect\'s float tensor, and renders Python\'s picture exactly', async () => {
    const ch = FX.chains.find(x => x.frame)!
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => TONE_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect!
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame!.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, TONE_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame!.w, ch.frame!.h, 3])
    expect(Buffer.compare(frame.px, b64(ch.frame!.image8))).toBe(0)
  })
})

// ── The esbuild guard: the effect cores built as Nitro builds server code ────

describe('esbuild guard: the effect cores survive Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'effects-esbuild-'))
  const c = find('AdjustThreshold: threshold between (0.37), card 23×19 see-through')

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
          // The type-only imports are gone; any other import would break the source-text contract.
          const file = join(dir, `${name}-${minify}.mjs`)
          writeFileSync(file, code)
          return await import(`${pathToFileURL(file).href}?${Math.random()}`) as Record<string, (...a: unknown[]) => unknown>
        }
        const px = await build('pixels/core.ts', 'pixels')
        const tk = await build('effects/core/tensor.ts', 'tensor')
        const tone = await build('effects/core/tone.ts', 'tone')
        // Rebuilt from their own source text, with nothing in scope.
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tk.tensorCore!.toString()})(px)`)(pxB)
        const toneB = new Function('k', `return (${tone.toneCore!.toString()})(k)`)(tkB) as ReturnType<typeof toneCore>
        const [inp] = await tensorsOf(c)
        const out = toneB.AdjustThreshold(inp!, paramsOf(c)).outputs[0]!
        expectExact(interleaved(out), c.outputs![0]!.items[0]!.f32!, 'built in this thread')
        // And as the worker's own script.
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'tone', fn: tone.toneCore as never, args: ['tk'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(c)
          const raw = await decodeRaw(files[c.inputs.image!.files[0]!]!, 'card')
          expect((await reply({ id: 1, op: 'fx.begin', cls: c.class_type, fn: 'tone.AdjustThreshold', params: paramsOf(c), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(Buffer.compare(r.value.outputs[0].round8, b64(c.outputs![0]!.items[0]!.round8!))).toBe(0)
          expect(Buffer.compare(r.value.preview.px, b64(c.preview!.px!))).toBe(0)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }

  it('the in-thread cores are built as the worker builds them', () => {
    const tk = tensorCore(pixelsCore())
    const tone = toneCore(tk)
    expect(Object.keys(tone)).toEqual(Object.keys(effectCores.tone))
  })
})
