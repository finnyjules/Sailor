/**
 * R2.6: cells and glyphs (family effects-cells,
 * server/runner/effects/core/cells.ts): Pixelate, Halftone, Kuwahara and
 * Ascii, against the real Python nodes (scripts/runner_effects_fixtures.py
 * --group cells → fixtures/runner-effects-cells.json). Every class is
 * *exact*: float32 bit for bit with Python (its sha256). Ascii draws its
 * characters from the glyph atlas the same script rendered with the node's
 * own _ascii_bitmaps (server/runner/effects/asciiGlyphs.bin, DejaVu Sans
 * Mono: controller ruling (d)); every Ascii case of the fixture was made
 * with that font too.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import {
  b64, coreOp, filesOfValue, interleaved, loadFixtures, memoryIO, paramsOf, pictureOf, pngPixels,
  runEffectCase, sha256, tensorsOf, withAssets, type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_MAX_WORK, EFFECT_PICTURES_TOO_LARGE,
  EFFECT_PICTURE_TOO_LARGE, EFFECT_TOO_MUCH_WORK, asciiGlyphsArePortable, asciiRampOf,
} from '#shared/runner/effects'
import { ASCII_DEFAULT, ASCII_GLYPH_CHARACTERS, ASCII_PRESETS } from '#shared/runner/asciiGlyphSet.generated'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import {
  ASCII_CHARACTER_UNKNOWN, ASCII_GLYPHS_MISSING, ASCII_GLYPHS_UNREADABLE, __setAsciiGlyphsFileForTests, asciiAtlasFor, asciiGlyphs, asciiPrepare,
} from '~~/server/runner/effects/asciiGlyphs'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import type { RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'

/**
 * The picture decoder, watched (as the blur spec): a refusal that came
 * before any pixel was decoded, or a plan that got past its caps and budget.
 */
const decodeWatch = vi.hoisted(() => ({ calls: 0, refuse: false }))
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

interface CellsCase extends Omit<FxCase, 'outputs'> { outputs?: { kind: 'image'; items: FxItem[] }[] }
interface CellsFx extends Omit<FxFile, 'cases'> {
  cases: CellsCase[]
  /** A small output's float32 (zlib), by its sha256. */
  floats: Record<string, string>
  atlas: {
    characters: string; entries: number; file_sha256: string; file_bytes: number; raw_sha256: string
    index: { characters: string; cell_min: number; cell_max: number; font: string; font_sha256: string; pillow: string; freetype: string }
    cells: { cell: number; f32_sha256: string }[]
  }
  font: { path: string; sha256: string }
  frame: { name: string; inputs: FxCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
}
const FX = withAssets(loadFixtures('cells') as unknown as FxFile) as unknown as CellsFx

const CELLS_CLASSES = ['Pixelate', 'Halftone', 'Kuwahara', 'Ascii']
/** DejaVu Sans Mono as the fixtures used it (matplotlib's copy in the engine's .venv; controller ruling (d)). */
const DEJAVU_SHA256 = '602ec86b8948cfcd956482fe64f94c36c867770149ef2f791d4613f443bcecb3'
const ATLAS_FILE = resolve(__dirname, '../../server/runner/effects/asciiGlyphs.bin')

const CELLS: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-cells'])
const CELLS_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-cells', 'fal-edit'])
const CELLS_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-cells', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk

/** A class's widget defaults (the first case of the standard set is 'defaults'). */
function defaultsOf(cls: string): Record<string, unknown> {
  const c = FX.cases.find(x => x.class_type === cls && x.name.startsWith(`${cls}: defaults,`))
  if (!c) throw new Error(`no defaults case for ${cls}`)
  return c.widgets
}

/** A case's params as the core takes them (the table's `prepare`: Ascii's atlas). */
function coreParams(c: CellsCase): Record<string, unknown> {
  const p = paramsOf(c as FxCase)
  const spec = EFFECTS[c.class_type]!
  return spec.prepare ? spec.prepare(p) : p
}

type Op = (inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** The case's outputs from the core called in this thread, one per batch index, each told its place in the batch. */
async function coreRun(c: CellsCase, count?: number) {
  const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
  const rows = await tensorsOf(c as FxCase)
  const p = coreParams(c)
  return rows.map((inp, i) => op(inp, p, undefined, {}, i, count ?? rows.length))
}

/** An exact output: its float32's sha256; on a miss, the first value that differs from Python's (small cases keep their float). */
function expectExactItem(t: Tensor, item: FxItem, label: string): void {
  const got = interleaved(t)
  const hash = sha256(new Uint8Array(got.buffer, got.byteOffset, got.byteLength))
  if (hash === item.f32_sha256) return
  const z = FX.floats[item.f32_sha256!]
  if (z) {
    const raw = inflateSync(b64(z))
    const py = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
    let at = -1
    for (let i = 0; i < py.length; i++) if (!Object.is(py[i], got[i])) { at = i; break }
    const px = Math.floor(at / item.c)
    expect.fail(`${label}: value ${at} (x ${px % item.w}, y ${Math.floor(px / item.w)}, channel ${at % item.c}) is ${got[at]}, Python's ${py[at]}`)
  }
  expect(hash, label).toBe(item.f32_sha256)
}

/** Python's raise, as the runner's key (rule 6). */
function keyOfError(e: { type: string; message: string }): string {
  if (/^Expected 3D or 4D \(batch mode\) tensor with optional 0 dim batch size for input/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  if (/^The expanded size of the tensor \(4\) must match the existing size \(3\)|^The size of tensor a \(4\) must match the size of tensor b \(3\)/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  throw new Error(`an unmapped Python raise: ${e.type}: ${e.message}`)
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the cells fixtures', () => {
  it('cover the 4 classes, made by multi-threaded torch, with DejaVu Sans Mono', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...CELLS_CLASSES].sort())
    expect(FX.font.sha256).toBe(DEJAVU_SHA256)
    expect(FX.font.path).toMatch(/DejaVuSansMono\.ttf$/)
    expect(FX.cases.length).toBeGreaterThan(600)
  })

  it('every class is ported: in the table, in the family, with a row', () => {
    for (const cls of CELLS_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-cells', op: `cells.${cls}`, batch: 'pure' })
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-cells')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-cells')
      expect(typeof (effectCores.cells as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
    expect(RUNNER_NODE_RULES.Ascii!.inputCheck).toEqual(['effect-preview-name', 'effect-output-size', 'ascii-glyphs'])
  })

  it('a Python raise is Ascii\'s: a picture smaller than a cell, or a 4-channel picture meeting its 3-channel glyphs', () => {
    const errors = FX.cases.filter(c => c.error)
    expect(errors.length).toBeGreaterThan(100)
    const keys = new Set<string>()
    for (const c of errors) {
      expect(c.class_type, c.name).toBe('Ascii')
      expect(c.error!.type, c.name).toBe('RuntimeError')
      keys.add(keyOfError(c.error!))
    }
    expect([...keys].sort()).toEqual(['EFFECT_NEEDS_RGB', 'EFFECT_PICTURE_TOO_SMALL'])
  })

  it('Python\'s preview file is its output\'s trunc8', () => {
    for (const c of FX.cases.filter(x => !x.error)) expect(c.preview!.px_sha256, c.name).toBe(c.outputs![0]!.items[0]!.trunc8_sha256)
  })
})

// ── The glyph atlas ──────────────────────────────────────────────────────────

describe('the Ascii glyph atlas', () => {
  it('is the file the fixture script wrote: under 3 MB, every (cell 4–64, character), DejaVu Sans Mono with its Pillow and FreeType recorded', () => {
    const bytes = readFileSync(ATLAS_FILE)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FX.atlas.file_sha256)
    expect(bytes.length).toBe(FX.atlas.file_bytes)
    expect(statSync(ATLAS_FILE).size).toBeLessThan(3 * 1024 * 1024)
    const a = asciiGlyphs()
    expect(a.index.characters).toBe(FX.atlas.characters)
    expect([a.index.cell_min, a.index.cell_max]).toEqual([4, 64])
    expect(a.index.font).toBe('DejaVuSansMono.ttf')
    expect(a.index.font_sha256).toBe(DEJAVU_SHA256)
    expect(a.index.pillow).toBe(FX.atlas.index.pillow)
    expect(a.index.freetype).toBe(FX.atlas.index.freetype)
    expect(a.chars.length * 61).toBe(FX.atlas.entries)
    console.info(`ascii atlas: ${bytes.length.toLocaleString('en')} bytes, ${FX.atlas.entries} entries, Pillow ${a.index.pillow}, FreeType ${a.index.freetype}`)
  })

  it('holds the union of the eight presets and printable ASCII 32–126 (the generated set eligibility reads)', () => {
    const want = new Set<string>()
    for (let o = 32; o <= 126; o++) want.add(String.fromCharCode(o))
    for (const ramp of Object.values(ASCII_PRESETS)) for (const ch of ramp) want.add(ch)
    for (const ch of ASCII_DEFAULT) want.add(ch)
    expect([...ASCII_GLYPH_CHARACTERS].sort()).toEqual([...want].sort())
    expect(ASCII_GLYPH_CHARACTERS).toBe(FX.atlas.characters)
    expect(Object.keys(ASCII_PRESETS)).toEqual(['classic', 'blocks', 'dots', 'lines', 'letters', 'numbers', 'binary', 'braille'])
  })

  it('every (cell, character) equals Python\'s _ascii_bitmaps, float32 bit for bit (u / 255)', () => {
    const chars = [...ASCII_GLYPH_CHARACTERS]
    for (const { cell, f32_sha256 } of FX.atlas.cells) {
      const atlas = asciiAtlasFor(cell, chars)
      expect([...atlas.ramp]).toEqual(chars.map((_c, i) => i))
      const f = new Float32Array(atlas.glyphs.length)
      for (let i = 0; i < f.length; i++) f[i] = Math.fround(atlas.glyphs[i]! / 255)
      expect(sha256(new Uint8Array(f.buffer)), `cell ${cell}`).toBe(f32_sha256)
    }
    expect(FX.atlas.cells.map(c => c.cell)).toEqual(Array.from({ length: 61 }, (_x, i) => i + 4))
  })

  it('a missing atlas fails the node as missing; a corrupt one (not gzip, a bad index) or one of the wrong size as unreadable, in plain words (fix round 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ascii-atlas-'))
    const good = gunzipSync(readFileSync(ATLAS_FILE))
    const headLen = good.readUInt32LE(4)
    const files: Record<string, Uint8Array> = {
      'not gzip': new Uint8Array(Buffer.from('not an atlas at all')),
      'gzip, not an atlas': gzipSync(Buffer.from('hello')),
      'a bad index': gzipSync(Buffer.concat([good.subarray(0, 8), Buffer.from('{'.padEnd(headLen, ' ')), good.subarray(8 + headLen)])),
      'an index longer than the file': gzipSync(Buffer.concat([Buffer.from('SAG1'), Buffer.from([0xFF, 0xFF, 0xFF, 0x7F])])),
      'one byte short': gzipSync(good.subarray(0, good.length - 1)),
      'one byte long': gzipSync(Buffer.concat([good, Buffer.from([0])])),
      'deflate, not gzip': deflateSync(good),
    }
    const c = FX.cases.find(x => x.name === 'Ascii: defaults, rgb 37×23')!
    try {
      __setAsciiGlyphsFileForTests(join(dir, 'nowhere.bin'))
      expect(() => asciiGlyphs()).toThrow(ASCII_GLYPHS_MISSING)
      await expect(runEffectCase(c as FxCase, { families: CELLS })).rejects.toThrow(ASCII_GLYPHS_MISSING)
      for (const [label, bytes] of Object.entries(files)) {
        const file = join(dir, `${label}.bin`)
        writeFileSync(file, bytes)
        __setAsciiGlyphsFileForTests(file)
        expect(() => asciiGlyphs(), label).toThrow(ASCII_GLYPHS_UNREADABLE)
        await expect(runEffectCase(c as FxCase, { families: CELLS }), label).rejects.toThrow(ASCII_GLYPHS_UNREADABLE)
      }
      // The good file under another name reads, and the node runs.
      const copy = join(dir, 'copy.bin')
      writeFileSync(copy, readFileSync(ATLAS_FILE))
      __setAsciiGlyphsFileForTests(copy)
      expect(asciiGlyphs().chars.join('')).toBe(ASCII_GLYPH_CHARACTERS)
      const run = await runEffectCase(c as FxCase, { families: CELLS })
      expect(sha256((await pngPixels(run.bytes(filesOfValue(run.made.values[0])[0]!))).px)).toBe(c.outputs![0]!.items[0]!.round8_sha256)
    }
    finally { __setAsciiGlyphsFileForTests(null) }
    expect(ASCII_GLYPHS_MISSING).toMatch(/^[A-Z][^A-Z]*$/)
    expect(ASCII_GLYPHS_UNREADABLE).toMatch(/^[A-Z][^A-Z]*$/)
  })

  it('a node gets its cell\'s bitmaps for its ramp\'s distinct characters, in ramp order', () => {
    const a = asciiAtlasFor(6, [...'abca'])
    expect([...a.ramp]).toEqual([0, 1, 2, 0])
    expect(a.glyphs.length).toBe(3 * 36)
    expect(() => asciiAtlasFor(6, [...'aé'])).toThrow(ASCII_CHARACTER_UNKNOWN)
    const p = asciiPrepare({ ...defaultsOf('Ascii'), preset: 'binary', cell_size: 9 }).atlas as { cell: number; ramp: Int32Array }
    expect(p.cell).toBe(9)
    expect(p.ramp).toHaveLength(3)
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

/** A case whose Ascii ramp has a character outside the atlas: the runner leaves it to the engine (Python draws it). */
const leftToEngine = (c: CellsCase) => c.class_type === 'Ascii' && !asciiGlyphsArePortable(c.widgets)

describe('each class against Python', () => {
  for (const c of FX.cases) {
    it(`core: ${c.name}`, async () => {
      if (leftToEngine(c)) {
        expect(runnerTakesNode(pictureOf(c as FxCase).prompt, c.node_id, CELLS)).toBe(false)
        await expect(coreRun(c)).rejects.toThrow(ASCII_CHARACTER_UNKNOWN)
        return
      }
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow(keyOfError(c.error))
        return
      }
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      expect(runs).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const t = runs[i]!.outputs[0]!
        expect([t.w, t.h, t.c], `${c.name}, picture ${i}`).toEqual([item.w, item.h, item.c])
        expectExactItem(t, item, `${c.name}, picture ${i}`)
      }
    })

    it(`planEffect: ${c.name}`, async () => {
      if (leftToEngine(c)) {
        await expect(runEffectCase(c as FxCase, { families: CELLS })).rejects.toThrow(ASCII_CHARACTER_UNKNOWN)
        return
      }
      if (c.error) {
        await expect(runEffectCase(c as FxCase, { families: CELLS })).rejects.toThrow(EFFECT_ERROR_MESSAGES[keyOfError(c.error)]!)
        return
      }
      const items = c.outputs![0]!.items
      // Read by nothing (or a provider): kept as the hand-off's round.
      const run = await runEffectCase(c as FxCase, { families: CELLS })
      const files = filesOfValue(run.made.values[0])
      expect(files).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(run.bytes(files[i]!))
        expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
        expect(sha256(got.px), `${c.name}, kept ${i}`).toBe(item.round8_sha256)
      }
      // The live preview: the first picture as save_live_preview writes it.
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      expect(sha256(pv.px)).toBe(c.preview!.px_sha256)
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c as FxCase)
      const saved = await runEffectCase(c as FxCase, { families: CELLS, prompt: { ...p.prompt, save: saveImage([c.node_id, 0]) } })
      const tfiles = filesOfValue(saved.made.values[0])
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(saved.bytes(tfiles[i]!))
        expect(sha256(got.px), `${c.name}, kept trunc ${i}`).toBe(item.trunc8_sha256)
      }
    }, c.hashed ? 60_000 : 20_000)
  }
})

// ── Details the cases pin ────────────────────────────────────────────────────

describe('what the cases pin', () => {
  const find = (name: string) => {
    const c = FX.cases.find(x => x.name === name)
    if (!c) throw new Error(`no case ${name}`)
    return c
  }

  it('Pixelate at a size bigger than the picture is a mean (an area resize to 1 × 1); a batch of two is worked as a batch of two', async () => {
    const pair = find('Pixelate: size 64, a batch of two rgb 120×90')
    const runs = await coreRun(pair)
    pair.outputs![0]!.items.forEach((item, i) => expectExactItem(runs[i]!.outputs[0]!, item, `picture ${i}`))
    // Every pixel is the picture's mean.
    const t = runs[0]!.outputs[0]!
    for (let c = 0; c < t.c; c++) {
      const plane = t.data.subarray(c * t.w * t.h, (c + 1) * t.w * t.h)
      expect(new Set(plane).size).toBe(1)
    }
    // Through planEffect, each picture of the batch is told the batch's size.
    const run = await runEffectCase(pair as FxCase, { families: CELLS, prompt: { ...pictureOf(pair as FxCase).prompt, next: effect('AdjustInvert', [pair.node_id, 0], { amount: 0 }) } })
    const value = run.made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    expect(value.tensors).toHaveLength(2)
    for (const [i, item] of pair.outputs![0]!.items.entries()) expectExactItem(tk.fromTensorFile(run.bytes(value.tensors![i]!)), item, `picture ${i}, its float`)
  })

  it('Kuwahara at an odd radius makes a picture one pixel larger each way, and the table says so before decoding', () => {
    for (let r = 1; r <= 12; r++) {
      const c = find(`Kuwahara: radius ${r}, rgb 37×23`)
      const item = c.outputs![0]!.items[0]!
      const grow = r % 2 === 1 ? 1 : 0
      expect([item.w, item.h], `radius ${r}`).toEqual([37 + grow, 23 + grow])
      expect(EFFECTS.Kuwahara!.outSize!({ radius: r }, { w: 37, h: 23 })).toEqual({ w: 37 + grow, h: 23 + grow })
    }
  })

  it('Ascii in monochrome on a 4-channel picture of whole cells, normal and unmixed, comes out RGB', () => {
    const c = find('Ascii: monochrome, background True, invert False, normal, mix 1.0, provider 40×30')
    expect(c.outputs![0]!.items[0]!.c).toBe(3)
    expect(c.preview!.mode).toBe('RGB')
  })

  it('a custom ramp with a character the atlas hasn\'t (U+2800, braille blank) is among the cases, and is left to the engine', () => {
    const left = FX.cases.filter(leftToEngine)
    expect(left.map(c => c.name)).toEqual(['Ascii: custom 6 (2 characters), rgb 37×23', 'Ascii: custom 6 (2 characters), rgb 40×30'])
    for (const c of left) expect(c.outputs, c.name).toBeDefined()
  })

  it('Ascii\'s custom text: under two characters falls back to the default ramp; a long one is its own', async () => {
    const short = find('Ascii: custom 0 (1 characters), rgb 37×23')
    const dflt = find('Ascii: custom 1 (0 characters), rgb 37×23')
    expect(short.outputs![0]!.items[0]!.f32_sha256).toBe(dflt.outputs![0]!.items[0]!.f32_sha256)
    expect(asciiRampOf('custom', 'x')).toEqual([...ASCII_DEFAULT])
    expect(asciiRampOf('custom', '')).toEqual([...ASCII_DEFAULT])
    expect(asciiRampOf('custom', 'ab')).toEqual(['a', 'b'])
    expect(asciiRampOf('blocks', 'é!')).toEqual([...ASCII_PRESETS.blocks!])
    expect(asciiRampOf('custom', 12)).toBeNull()
  })
})

// ── Eligibility and families (rule 12) ───────────────────────────────────────

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
function put(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('families', () => {
  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const cls of CELLS_CLASSES) {
      const p: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)) }
      expect(runnerTakesWorkflow(p, CELLS), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: CELLS, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur', 'effects-tone']), new Set<RunnerFamily>(['effects-cells'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toEqual(['fx'])
      }
    }
  })

  it('node by node: each class, its source card and its reader, with cards and the family on and off', () => {
    for (const cls of CELLS_CLASSES) {
      const q: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      expect(take(['cards', 'effects-cells', 'fal-edit']), cls).toEqual({ 0: true, fx: true, e: true, o: true })
      expect(isRunnerEligible(q, CELLS_EDIT), cls).toBe(true)
      for (const fam of [['effects-cells', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-tone', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam), `${cls} ${fam}`).toEqual({ 0: true, fx: false, e: true, o: true })
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('widgets ComfyUI would refuse leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: effect(cls, ['0', 0], { ...defaultsOf(cls), ...over }) }, 'fx', CELLS)
    expect(take('Pixelate', { size: 64 })).toBe(true)
    expect(take('Pixelate', { size: 65 })).toBe(false)
    expect(take('Halftone', { cell_size: 1 })).toBe(false)
    expect(take('Kuwahara', { radius: 13 })).toBe(false)
    expect(take('Ascii', { cell_size: 3 })).toBe(false)
    expect(take('Ascii', { preset: 'emoji' })).toBe(false)
    expect(take('Ascii', { blend_mode: 'lighten' })).toBe(false)
    expect(take('Ascii', { pos_x: 33 })).toBe(false)
  })

  it('a custom Ascii character outside the glyph atlas leaves the node to the engine; the text is read only when the preset is custom', () => {
    const take = (over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: effect('Ascii', ['0', 0], { ...defaultsOf('Ascii'), ...over }) }, 'fx', CELLS)
    expect(take({ preset: 'custom', characters: ' .:oO@' })).toBe(true)
    expect(take({ preset: 'custom', characters: ' ░▒▓█⠿' })).toBe(true)
    expect(take({ preset: 'custom', characters: ' .é' })).toBe(false)
    expect(take({ preset: 'custom', characters: ' .\u{1F600}' })).toBe(false)
    expect(take({ preset: 'custom', characters: ' .\t' })).toBe(false)
    // Under two characters the node draws its default ramp, whatever the one character is.
    expect(take({ preset: 'custom', characters: 'é' })).toBe(true)
    // Not a string: str() of it is Python's to write.
    expect(take({ preset: 'custom', characters: 12 })).toBe(false)
    // Another preset: the text is not read.
    expect(take({ preset: 'dots', characters: 'é€' })).toBe(true)
    expect(asciiGlyphsArePortable({ preset: 'braille', characters: '' })).toBe(true)
    // Through planEffect a ramp with a character the atlas hasn't fails in plain words (eligibility keeps it from getting there).
    expect(() => asciiPrepare({ ...defaultsOf('Ascii'), preset: 'custom', characters: 'aé' })).toThrow(ASCII_CHARACTER_UNKNOWN)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/** The graph with an effect of class `cls` (its defaults) spliced in after every picture output. */
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
      out[fx] = effect(cls, [id, slot], defaultsOf(cls))
      count++
    }
  }
  return { prompt: out, count }
}

/** The prompt as the runner read it before R2.1: each effect class one it had never heard of. */
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
    for (const cls of CELLS_CLASSES) {
      const w = defaultsOf(cls)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w) }, `${cls} alone`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), e: editNode(['fx', 0]), o: outCard('e') }, `${cls} → edit`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), s: saveImage(['fx', 0]) }, `${cls} → save`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }, `${cls} → Frame`)
      sameAsBefore({ g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, fx: effect(cls, ['g', 0], w) }, `generate → ${cls}`)
    }
    // An Ascii whose custom text the atlas can't draw: as before too.
    sameAsBefore({ 0: card('a.png'), fx: effect('Ascii', ['0', 0], { ...defaultsOf('Ascii'), preset: 'custom', characters: ' é' }) }, 'Ascii with é')
  })

  // The saved projects are this machine's own data: with the folder missing the check is skipped, visibly.
  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, each with one of the 4 classes (in turn) spliced in after every picture', async () => {
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
        const cls = CELLS_CLASSES[graphs % CELLS_CLASSES.length]!
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
    expect([...used].sort()).toEqual([...CELLS_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`cells families-off invariant: ${graphs} saved graphs, ${spliced} with a cells class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-cells on)', () => {
  const c = FX.cases.find(x => x.name === 'Ascii: texture, background True, invert False, overlay, mix 0.5, card 23×19 see-through')!
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CELLS_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, CELLS_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[c.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await pngPixels(uploads[0]![0])
    expect(sent.channels).toBe(4)
    expect(sha256(sent.px)).toBe(item.round8_sha256)
  })

  it('an effect → Save image saves the trunc picture', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CELLS } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(item.trunc8_sha256)
  })

  it('an effect → Frame: the Frame reads the effect\'s float tensor (Kuwahara radius 3: one pixel larger) and renders Python\'s picture exactly', async () => {
    const ch = FX.frame
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => CELLS_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, CELLS_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame.w, ch.frame.h, 3])
    expect(Buffer.compare(frame.px, b64(ch.frame.image8))).toBe(0)
  })
})

// ── Work (rule 7) ────────────────────────────────────────────────────────────

/** A picture file as a Frame (source 'rgb') would keep it (listed `count` times in the batch), run through planEffect on the real worker. */
async function runBig(cls: string, widgets: Record<string, unknown>, png: Uint8Array, o: { count?: number; hosted?: boolean } = {}) {
  const c = { name: cls, class_type: cls, node_id: 'fx', widgets, inputs: { image: { source: 'rgb' as const, files: Array.from({ length: o.count ?? 1 }, () => 'big.png') } } }
  const pic = pictureOf(c as FxCase)
  const mem = memoryIO({ 'big.png': png }, 'fx', { hosted: o.hosted })
  const plan: NodePlan = await planNode({ prompt: pic.prompt, nodeId: 'fx', families: CELLS, gateOpen: false, hosted: o.hosted, filesFrom: pic.filesOf, toUrl: async () => '' })
  return { mem, derive: () => (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io) }
}

const solids = new Map<number, Promise<Uint8Array>>()
function solidPng(side: number): Promise<Uint8Array> {
  if (!solids.has(side)) {
    solids.set(side, sharp({ create: { width: side, height: side, channels: 3, background: { r: 90, g: 120, b: 200 } }, limitInputPixels: false })
      .png({ compressionLevel: 1 }).toBuffer().then(b => new Uint8Array(b)))
  }
  return solids.get(side)!
}

/** What planEffect's caps and budget make of this node on a side × side picture, the decoder refusing to run ('accepted': it got to the decode). */
async function gate(cls: string, widgets: Record<string, unknown>, side: number, o: { count?: number; hosted?: boolean } = {}): Promise<string> {
  const { mem, derive } = await runBig(cls, widgets, await solidPng(side), o)
  const before = decodeWatch.calls
  decodeWatch.refuse = true
  try {
    await derive()
    throw new Error('the decoder was not reached')
  }
  catch (e) {
    const decoded = decodeWatch.calls - before
    if (decoded > 0) return 'accepted'
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
    return (e as Error).message
  }
  finally { decodeWatch.refuse = false }
}

describe('work', () => {
  it('Halftone at cell 48 on 8192² is over the budget and fails before any pixel is decoded; its defaults are not', async () => {
    expect(EFFECTS.Halftone!.work!({ cell_size: 48, angle: 15 }, { w: 8192, h: 8192 })).toBeGreaterThan(EFFECT_MAX_WORK)
    expect(await gate('Halftone', { ...defaultsOf('Halftone'), cell_size: 48 }, 8192)).toBe(EFFECT_TOO_MUCH_WORK)
    expect(await gate('Halftone', defaultsOf('Halftone'), 8192)).toBe('accepted')
  }, 60_000)

  it('every class\'s defaults are accepted at 4096² and its heaviest setting is accepted or refused before decoding', async () => {
    const heaviest: Record<string, Record<string, unknown>> = {
      Pixelate: { size: 2 }, Halftone: { cell_size: 48 }, Kuwahara: { radius: 12 }, Ascii: { color_mode: 'texture', blend_mode: 'overlay', mix: 0.5, cell_size: 4 },
    }
    const report: string[] = []
    for (const cls of CELLS_CLASSES) {
      expect(await gate(cls, defaultsOf(cls), 4096), `${cls} defaults at 4096²`).toBe('accepted')
      const h4 = await gate(cls, { ...defaultsOf(cls), ...heaviest[cls] }, 4096)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} heaviest at 4096²`).toContain(h4)
      const d8 = await gate(cls, defaultsOf(cls), 8192)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} defaults at 8192²`).toContain(d8)
      report.push(`${cls} ${h4 === 'accepted' ? 'ok' : 'over'}/${d8 === 'accepted' ? 'ok' : 'over'}`)
    }
    console.info(`cells budget through plan.ts (heaviest at 4096² / defaults at 8192²): ${report.join(', ')}`)
  }, 120_000)

  it('time check: Kuwahara at radius 12 on a 2048² rgb picture, on the worker (decode, work, encode, keep)', async () => {
    const side = 2048
    const png = new Uint8Array(await sharp({ create: { width: side, height: side, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } }, limitInputPixels: false }).png({ compressionLevel: 1 }).toBuffer())
    const widgets = { radius: 12 }
    const work = EFFECTS.Kuwahara!.work!(widgets, { w: side, h: side })
    expect(work).toBeLessThan(EFFECT_MAX_WORK)
    const { derive } = await runBig('Kuwahara', widgets, png)
    const t0 = performance.now()
    const made = await derive()
    const s = (performance.now() - t0) / 1000
    expect(filesOfValue(made.values[0])).toHaveLength(1)
    console.info(`time check: Kuwahara r12 on 2048² rgb on the worker: ${s.toFixed(1)} s; work ${(work / 1e9).toFixed(1)} × 10⁹ (the budget's rate: ${(work / 0.37e9).toFixed(1)} s)`)
    // Alone, it takes about half the budget's rate (10.8 s, R2.6 report); under a loaded suite about the rate itself.
    expect(s).toBeLessThan(60)
  }, 180_000)

  it('Kuwahara\'s larger output counts toward the caps, refused before decoding', async () => {
    // One 8192² picture at an odd radius makes 8193², over the one-picture cap; at an even radius it doesn't.
    expect(await gate('Kuwahara', { radius: 1 }, 8192)).toBe(EFFECT_PICTURE_TOO_LARGE)
    expect(await gate('Kuwahara', { radius: 2 }, 8192)).not.toBe(EFFECT_PICTURE_TOO_LARGE)
    // A batch of sixteen 4096²: 16 × 4097² = 268.6 M pixels made, over the 268,435,456 cap; 16 × 4096² is exactly the cap.
    expect(await gate('Kuwahara', { radius: 1 }, 4096, { count: 16 })).toBe(EFFECT_PICTURES_TOO_LARGE)
    expect(await gate('Kuwahara', { radius: 2 }, 4096, { count: 16 })).not.toBe(EFFECT_PICTURES_TOO_LARGE)
  }, 60_000)
})

// ── The esbuild guard: the cells core with the kernels, built as Nitro builds server code ──

describe('esbuild guard: the cells core survives Nitro’s build, with its kernels', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'cells-esbuild-'))
  // Ascii (the atlas handed as a param) on a see-through card, textured.
  const c = FX.cases.find(x => x.name === 'Ascii: texture, background True, invert False, overlay, mix 0.5, card 23×19 see-through')!

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
        const cm = await build('effects/core/cells.ts', 'cells')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const cellsB = new Function('k', 'kn', `return (${cm.cellsCore!.toString()})(k, kn)`)(tkB, knB) as Record<string, Op>
        const [inp] = await tensorsOf(c as FxCase)
        const item = c.outputs![0]!.items[0]!
        expectExactItem(cellsB.Ascii!(inp!, coreParams(c), undefined, {}, 0, 1).outputs[0]!, item, 'built in this thread')
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'cells', fn: cm.cellsCore as never, args: ['tk', 'kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(c as FxCase)
          const raw = await decodeRaw(files[c.inputs.image!.files[0]!]!, 'card')
          expect((await reply({ id: 1, op: 'fx.begin', cls: c.class_type, fn: 'cells.Ascii', params: coreParams(c), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(sha256(r.value.outputs[0].round8)).toBe(item.round8_sha256)
          expect(sha256(r.value.preview.px)).toBe(c.preview!.px_sha256)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  const PATHS: [string, Record<string, unknown>][] = [
    ['Pixelate', {}], ['Pixelate', { size: 1 }], ['Pixelate', { size: 64 }],
    ['Halftone', {}], ['Kuwahara', {}], ['Kuwahara', { radius: 5 }],
    ['Ascii', {}], ['Ascii', { color_mode: 'texture', gamma: 0.5, blend_mode: 'overlay', mix: 0.5, pos_x: 3 }],
  ]
  const x = tk.tensor(3, 256, 40)
  for (let i = 0; i < x.data.length; i++) x.data[i] = (i % 97) / 97

  for (const [cls, over] of PATHS) {
    it(`${cls} ${JSON.stringify(over)}: every Stop check along the run stops it`, () => {
      const op = coreOp(EFFECTS[cls]!.op) as unknown as Op
      const spec = EFFECTS[cls]!
      const w = { ...defaultsOf(cls), ...over }
      const p = spec.prepare ? spec.prepare(w) : w
      let total = 0
      op({ image: x }, p, () => { total++; return false })
      expect(total, 'checks in a whole run').toBeGreaterThanOrEqual(4)
      for (const at of [1, 2, Math.ceil(total / 2), total - 1, total]) {
        let calls = 0
        expect(() => op({ image: x }, p, () => ++calls >= at), `stopped at check ${at} of ${total}`).toThrow('Stopped')
        expect(calls).toBe(at)
      }
    })
  }
})
