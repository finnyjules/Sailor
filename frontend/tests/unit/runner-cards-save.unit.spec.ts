/**
 * R1.5: Save image and Preview image, ported against the real Python nodes
 * (scripts/runner_cards_fixtures.py → fixtures/runner-cards.json, key
 * `save_image`), and run by the engine behind `cards`: names, subfolders and
 * counters as Python's; PNG pixels identical and its text JSON-value-equal;
 * JPEG, WebP and resized pictures within the lossy tolerance (spec Open
 * question 3). Also the Image card showing a kept picture from temp, and a
 * loader's animation refused.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore, nextCounter, counter05 } from '~~/server/runner/results'
import { SAVE_FAILED, SAVE_OUTSIDE, asciiJson, insertPngText, pyNormpath, saveImagePrefix, saveSize } from '~~/server/runner/cards/saveImage'
import { PICTURE_ANIMATED } from '~~/server/runner/pictures/pythonView'
import { LOADER_APNG_WORDS } from '~~/server/runner/cards/bakeReplay'
import { pixels } from '~~/server/runner/pixels/core'
import { inflateSync } from 'node:zlib'
import { renderFrameInWorker } from '~~/server/runner/compositor/worker'
import { decodeRaw, decodeRawMask, pngFromPreview8, type PictureSource } from '~~/server/runner/compositor/decode'
import { onlySavesRead } from '~~/server/runner/cards/utilities'
import { shortUserHash } from '~~/server/utils/userHash'
import { SAVE_TOO_LARGE } from '~~/server/runner/cards/saveImage'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

/** Open question 3: lossy files and Lanczos resizes, decoded, per channel. */
const LOSSY_TOLERANCE = { mean: 2, max: 8 }

type Via = 'provider' | 'card' | 'load'
interface Saved {
  filename: string; subfolder: string; type: string; format: string; mode: string; w: number; h: number
  text: Record<string, string>; px_sha256?: string; px?: string
}
interface SaveCase {
  name: string; via: Via; files: Record<string, string>; names: string[]
  settings: Record<string, unknown>; existing: string[]; shape: number[]; saved: Saved[]
}
interface PreviewCase { name: string; via: Via; files: Record<string, string>; names: string[]; compress_level: number; prefix_append: string; saved: Saved[] }
interface TextMaskCase { name: string; via: Via; params: string; render: string; files: Record<string, string>; names: string[]; saved: Saved[] }
interface LanczosCase { mode: 'RGB' | 'RGBA'; w: number; h: number; ow: number; oh: number; px: string; out?: string; out_sha256?: string }
interface PathCase { prefix: string; width: number; height: number; subfolder?: string; filename?: string; counter?: number; error?: true }
const FX = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as {
  save_image: { prompt: ApiPrompt; workflow: unknown; moment: number[]; save: SaveCase[]; preview: PreviewCase[]; paths: PathCase[]; lanczos: LanczosCase[]; text_mask: TextMaskCase[] }
}).save_image

const NO: ReadonlySet<RunnerFamily> = new Set()
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`
const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const emptyImage = (over: Record<string, unknown> = {}) => ({ class_type: 'EmptyImage', inputs: { width: 40, height: 24, batch_size: 1, color: 0x336699, ...over } })
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: [string, number], over: Record<string, unknown> = {}) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS, ...over } })
const previewImage = (from: [string, number]) => ({ class_type: 'PreviewImage', inputs: { images: from } })
const sourceNode = (via: Via, name: string) => via === 'provider' ? generate() : via === 'card' ? card(name) : loadImage(name)

/** A PNG's tEXt chunks, keyword → text (Latin-1). */
function pngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  for (let o = 8; o + 12 <= png.length;) {
    const len = view.getUint32(o)
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8))
    if (type === 'tEXt') {
      const body = png.subarray(o + 8, o + 8 + len)
      const nul = body.indexOf(0)
      out[String.fromCharCode(...body.subarray(0, nul))] = Buffer.from(body.subarray(nul + 1)).toString('latin1')
    }
    o += 12 + len
  }
  return out
}

/** The zlib header's FLEVEL of a PNG's first IDAT: 0 at level 0–1, 1 at 2–5, 2 at 6, 3 at 7–9. */
function zlibLevel(png: Uint8Array): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  for (let o = 8; o + 12 <= png.length;) {
    const len = view.getUint32(o)
    if (String.fromCharCode(...png.subarray(o + 4, o + 8)) === 'IDAT') return png[o + 9]! >> 6
    o += 12 + len
  }
  throw new Error('no IDAT')
}

async function decode(bytes: Uint8Array): Promise<{ w: number; h: number; channels: number; px: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, channels: info.channels, px: new Uint8Array(data) }
}

/** Per channel, the mean and largest difference between two decoded pictures. */
function diff(a: Uint8Array, b: Uint8Array, channels: number): { mean: number; max: number } {
  expect(a.length).toBe(b.length)
  let mean = 0
  let max = 0
  for (let k = 0; k < channels; k++) {
    let sum = 0
    for (let i = k; i < a.length; i += channels) {
      const d = Math.abs(a[i]! - b[i]!)
      sum += d
      if (d > max) max = d
    }
    mean = Math.max(mean, sum / (a.length / channels))
  }
  return { mean, max }
}

/** Runs a node's derive plan with a real result store in a fresh folder; `src` is the node at the end of its picture wire. */
async function derived(prompt: ApiPrompt, nodeId: string, files: Record<string, Uint8Array>, srcFiles: string[], o: { existing?: string[]; value?: RunnerValue } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runner-save-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  for (const e of o.existing ?? []) writeFileSync(join(root, 'output', e), '')
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => false })
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([name, b]) => [`input:${name}`, b]))
  const plan: NodePlan = await planNode({
    prompt, nodeId, families: CARDS, gateOpen: false,
    filesFrom: link => link[0] === 'src' ? srcFiles.map(inputFile) : [],
    ...(o.value ? { valueFrom: (link: [string, number]) => link[0] === 'src' ? o.value : undefined } : {}),
    toUrl: async () => '',
  })
  expect(plan.kind).toBe('derive')
  const assets: OutputFile[] = []
  const io: DeriveIO = {
    read: async (f) => {
      const b = store.get(keyOf(f))
      if (b) return b
      return results.read(f)
    },
    keep: async () => { throw new Error('no kept bytes') },
    saveAsset: async (bytes, a) => {
      const f = await results.save(bytes, { userId: null, prefix: a.prefix, ext: a.ext, ...(a.subfolder !== undefined ? { subfolder: a.subfolder } : {}), ...(a.folder ? { folder: a.folder } : {}), ...(a.counter ? { counter: a.counter } : {}) })
      assets.push(f)
      return f
    },
    savePreview: async () => { throw new Error('no live previews') },
    savePreviewAs: (bytes, a) => results.savePreviewAs(bytes, { filename: a.filename, userId: null }),
    hosted: false, signal: new AbortController().signal, nodeId, runWorkflow: FX.workflow, runPrompt: FX.prompt,
  }
  const made: Derived = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)
  return { made, assets, root, read: (f: OutputFile) => results.read(f) }
}

async function expectSaved(bytes: Uint8Array, file: OutputFile, want: Saved, label: string): Promise<void> {
  expect([file.filename, file.subfolder, file.type], label).toEqual([want.filename, want.subfolder, want.type])
  const got = await decode(bytes)
  expect([got.w, got.h, got.channels], label).toEqual([want.w, want.h, want.mode.length])
  if (want.px_sha256) expect(sha256(got.px), label).toBe(want.px_sha256)
  // A resized PNG: Pillow's Lanczos is ported, so its pixels are Python's exactly.
  else if (want.format === 'PNG') expect(Buffer.compare(got.px, b64(want.px!)), label).toBe(0)
  else {
    const d = diff(got.px, b64(want.px!), got.channels)
    expect(d.mean, `${label}: mean difference`).toBeLessThanOrEqual(LOSSY_TOLERANCE.mean)
    expect(d.max, `${label}: largest difference`).toBeLessThanOrEqual(LOSSY_TOLERANCE.max)
  }
  if (want.format === 'PNG') {
    const text = pngText(bytes)
    expect(Object.keys(text).sort(), label).toEqual(Object.keys(want.text).sort())
    for (const [k, v] of Object.entries(text)) {
      expect(/^[\x20-\x7e\n\r\t]*$/.test(v), `${label}: ${k} is ASCII`).toBe(true)
      expect(JSON.parse(v), `${label}: ${k}`).toEqual(JSON.parse(want.text[k]!))
    }
  }
}

afterEach(() => { vi.restoreAllMocks() })

// ── The fixtures ─────────────────────────────────────────────────────────────

describe('Save image (nodes.py SaveImage.save_images)', () => {
  it('the fixtures cover every format, the resizes, the prefix, the counter and a batch', () => {
    expect(FX.save.length).toBeGreaterThanOrEqual(20)
    expect(new Set(FX.save.map(c => c.settings.format))).toEqual(new Set(['png', 'jpeg', 'webp']))
  })
  for (const c of FX.save.filter(x => x.via !== 'load' || !x.names[0]!.endsWith('.gif'))) {
    it(`matches Python: ${c.name}`, async () => {
      const files = Object.fromEntries(Object.entries(c.files).map(([n, d]) => [n, b64(d)]))
      const prompt: ApiPrompt = { src: sourceNode(c.via, c.names[0]!), s: saveImage(['src', 0], c.settings) }
      const { made, assets, read } = await derived(prompt, 's', files, c.names, { existing: c.existing })
      expect(made.values).toEqual({})
      expect(assets).toHaveLength(c.saved.length)
      expect(made.ui).toEqual({ images: c.saved.map(s => ({ filename: s.filename, subfolder: s.subfolder, type: s.type })) })
      for (let i = 0; i < assets.length; i++) await expectSaved(await read(assets[i]!), assets[i]!, c.saved[i]!, `${c.name} #${i}`)
    })
  }

  it('PNG compression is the widget’s level (the zlib header says so)', async () => {
    for (const [level, flevel] of [[1, 0], [4, 1], [9, 3]] as const) {
      const c = FX.save.find(x => x.via === 'load' && !x.names[0]!.endsWith('.gif'))!
      const prompt: ApiPrompt = { src: loadImage(c.names[0]!), s: saveImage(['src', 0], { png_compression: level }) }
      const { assets, read } = await derived(prompt, 's', { [c.names[0]!]: b64(c.files[c.names[0]!]!) }, c.names)
      expect(zlibLevel(await read(assets[0]!)), `level ${level}`).toBe(flevel)
    }
  })

  it('Python saves each frame of a LoadImage’s two-frame GIF (a batch of two): the runner refuses it', () => {
    const c = FX.save.find(x => x.names[0]!.endsWith('.gif'))!
    expect(c.saved).toHaveLength(2)
  })

  it('a list value is saved item by item, each sized on its own, the ui one list', async () => {
    const c = FX.save.find(x => x.name.startsWith('two images in one batch'))!
    const small = await sharp({ create: { width: 10, height: 6, channels: 3, background: '#123456' } }).png().toBuffer()
    const files = { [c.names[0]!]: b64(c.files[c.names[0]!]!), 'small.png': new Uint8Array(small) }
    const value: RunnerValue = { kind: 'files', files: [inputFile(c.names[0]!), inputFile('small.png')], list: true }
    const prompt: ApiPrompt = { src: generate(), s: saveImage(['src', 0], { filename_prefix: '%width%', scale: 0.5 }) }
    const { made, assets, read } = await derived(prompt, 's', files, [], { value })
    expect(assets.map(a => a.filename)).toEqual(['20_00001_.png', '5_00001_.png'])
    expect((made.ui as { images: unknown[] }).images).toHaveLength(2)
    expect((await decode(await read(assets[1]!))).w).toBe(5)
  })
})

describe('follow-up: pictures made in float, saved', () => {
  interface FrameCase { name: string; links: Record<string, [string, string]>; inputs: Record<string, unknown>; width: number; height: number; image8: string }
  const COMP = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-compositor.json'), 'utf8')) as { assets: Record<string, string>; cases: FrameCase[] }
  const asset = (name: string) => new Uint8Array(Buffer.from(COMP.assets[name]!, 'base64'))

  // The Frame hands on trunc(f32(255·x)) (its image8, which the Frame's own spec
  // proves); save_images writes the same float the same way: Frame → Save is exact.
  for (const c of COMP.cases.slice(0, 6)) {
    it(`Frame → Save image is Python's image8 exactly: ${c.name}`, async () => {
      const raw = (name: string, via: string) => via === 'load_mask' ? decodeRawMask(asset(name)) : decodeRaw(asset(name), via as PictureSource)
      const lazy = (link: [string, string] | undefined) => (link ? () => raw(link[0], link[1]) : null)
      const r = await renderFrameInWorker(c.inputs, {
        layers: Array.from({ length: 16 }, (_, i) => lazy(c.links[`layer${i + 1}`])),
        masks: Array.from({ length: 16 }, (_, i) => lazy(c.links[`layer${i + 1}_mask`])),
        overlay: lazy(c.links.overlay),
        overlayMask: lazy(c.links.overlay_mask),
      })
      const frame = await pngFromPreview8(r.px, r.w, r.h)
      const prompt: ApiPrompt = { src: { class_type: 'Compositor', inputs: {} }, s: saveImage(['src', 0]) }
      const { assets, read } = await derived(prompt, 's', { 'frame.png': new Uint8Array(frame) }, ['frame.png'])
      const got = await decode(await read(assets[0]!))
      expect([got.w, got.h, got.channels]).toEqual([c.width, c.height, 3])
      expect(Buffer.compare(Buffer.from(got.px), inflateSync(Buffer.from(c.image8, 'base64')))).toBe(0)
    })
  }

  for (const c of FX.text_mask) {
    it(`Text mask with a source → Save image matches Python exactly: ${c.name}`, async () => {
      const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
      for (const [n, d] of Object.entries(c.files)) put(k.root, n, b64(d))
      put(k.root, (JSON.parse(c.params) as { rendered: string }).rendered, b64(c.render))
      const p: ApiPrompt = {
        0: c.via === 'card' ? card(c.names[0]!) : loadImage(c.names[0]!),
        t: { class_type: 'TextMask', inputs: { params: c.params, source: ['0', 0] } },
        s: saveImage(['t', 0]),
      }
      const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
      await k.engine.settled(runId)
      expect((await k.store.get(runId))!.status).toBe('done')
      const got = await decode(new Uint8Array(readFileSync(join(k.root, 'output', c.saved[0]!.filename))))
      expect([got.w, got.h, got.channels]).toEqual([c.saved[0]!.w, c.saved[0]!.h, c.saved[0]!.mode.length])
      expect(sha256(got.px)).toBe(c.saved[0]!.px_sha256)
    })
  }

  it('Text mask keeps the truncated picture only when Save image / Preview image alone read it', () => {
    const t = { class_type: 'TextMask', inputs: { params: '{}', source: ['0', 0] } }
    expect(onlySavesRead({ t, s: saveImage(['t', 0]) }, 't', 0)).toBe(true)
    expect(onlySavesRead({ t, s: saveImage(['t', 0]), p: previewImage(['t', 0]) }, 't', 0)).toBe(true)
    expect(onlySavesRead({ t, c: outCard('t'), g: { class_type: 'ComfyGateNode', inputs: { data_in: ['c', 0] } }, s: saveImage(['g', 0]) }, 't', 0)).toBe(true)
    expect(onlySavesRead({ t, s: saveImage(['t', 0]), e: edit(['t', 0]) }, 't', 0)).toBe(false)
    expect(onlySavesRead({ t, c: outCard('t'), s: saveImage(['c', 0]), e: edit(['c', 0]) }, 't', 0)).toBe(false)
    expect(onlySavesRead({ t, m: { class_type: 'ImageToMask', inputs: { image: ['t', 0], channel: 'red' } } }, 't', 0)).toBe(false)
    expect(onlySavesRead({ t }, 't', 0)).toBe(false)
    expect(onlySavesRead({ t, s: saveImage(['t', 1]) }, 't', 0)).toBe(false)
  })

  it('the too-large message states the cap it enforces', () => {
    expect(SAVE_TOO_LARGE).toContain(`${Math.floor(CARD_MAX_PIXELS / 1_000_000)} million pixels`)
  })
})

describe('Pillow’s Image.resize(LANCZOS) (pixels/core.ts)', () => {
  for (const c of FX.lanczos) {
    it(`matches Pillow exactly: ${c.mode} ${c.w}×${c.h} → ${c.ow}×${c.oh}`, () => {
      const src = b64(c.px)
      let got: Uint8Array
      if (c.mode === 'RGB') got = pixels.pilResize(src, c.w, c.h, 3, c.ow, c.oh)
      else {
        // RGBA through save_images' path (premultiplied, divided back): a provider picture's tensor is its bytes.
        const out = pixels.savePixels({ source: 'provider', w: c.w, h: c.h, data: src }, c.ow, c.oh, false)
        expect(out.channels).toBe(4)
        got = out.px
      }
      if (c.out_sha256) expect(sha256(got)).toBe(c.out_sha256)
      else expect(Buffer.compare(got, b64(c.out!))).toBe(0)
    })
  }
})

describe('Preview image (nodes.py PreviewImage)', () => {
  for (const c of FX.preview) {
    it(`matches Python: ${c.name}`, async () => {
      expect([c.compress_level, c.prefix_append]).toEqual([1, '_temp_aaaaa'])
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const files = Object.fromEntries(Object.entries(c.files).map(([n, d]) => [n, b64(d)]))
      const prompt: ApiPrompt = { src: sourceNode(c.via, c.names[0]!), p: previewImage(['src', 0]) }
      const { made, assets, read } = await derived(prompt, 'p', files, c.names)
      expect(made.values).toEqual({})
      expect(made.ui).toEqual({ images: c.saved.map(s => ({ filename: s.filename, subfolder: s.subfolder, type: s.type })) })
      const bytes = await read(assets[0]!)
      await expectSaved(bytes, assets[0]!, c.saved[0]!, c.name)
      expect(zlibLevel(bytes)).toBe(0)
    })
  }

  it('its five letters come from nodes.py’s alphabet (the last is z: it has no w)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const x = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer())
    const { made } = await derived({ src: generate(), p: previewImage(['src', 0]) }, 'p', { 'x.png': x }, ['x.png'])
    expect((made.ui as { images: OutputFile[] }).images[0]!.filename).toBe('ComfyUI_temp_zzzzz_00001_.png')
  })
})

describe('folder_paths.get_save_image_path', () => {
  const [y, mo, d, h, mi, s] = FX.moment as [number, number, number, number, number, number]
  const now = new Date(y, mo - 1, d, h, mi, s)
  for (const c of FX.paths) {
    it(`matches Python: ${JSON.stringify(c.prefix)}`, () => {
      if (c.error) expect(() => saveImagePrefix(c.prefix, c.width, c.height, now)).toThrow(SAVE_OUTSIDE)
      else expect(saveImagePrefix(c.prefix, c.width, c.height, now)).toEqual({ subfolder: c.subfolder, filename: c.filename })
    })
  }

  it('posixpath.normpath, the counter and its format', () => {
    expect(['', '.', '//a', '///a', 'a/./b/', '../../a', '/..', 'a/..'].map(pyNormpath)).toEqual(['.', '.', '//a', '/a', 'a/b', '../../a', '/', '.'])
    expect(nextCounter(['x_00002_.png', 'x_00010_.jpg', 'x_ 12_.png', 'xy_00050_.png', 'x_abc_.png'], 'x')).toBe(13)
    expect(nextCounter(['x_abc_.png'], 'x')).toBe(1)
    expect(nextCounter([], 'x')).toBe(1)
    expect([counter05(7), counter05(123456), counter05(-4)]).toEqual(['00007', '123456', '-0004'])
    expect(saveSize(40, 28, 0.5, 0)).toEqual({ w: 20, h: 14 })
    expect(saveSize(5, 3, 0.5, 0)).toEqual({ w: 2, h: 2 }) // round(2.5) = 2, round(1.5) = 2
    expect(saveSize(40, 28, 1, 30)).toEqual({ w: 30, h: 21 })
  })
})

describe('PNG text', () => {
  it('tEXt chunks go before IEND with a good CRC; sharp still reads the picture', async () => {
    const png = new Uint8Array(await sharp({ create: { width: 3, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer())
    const withText = insertPngText(png, [['prompt', '{"a":1}'], ['workflow', 'caf\\u00e9']])
    expect(pngText(withText)).toEqual({ prompt: '{"a":1}', workflow: 'caf\\u00e9' })
    expect(Buffer.from(withText.subarray(-12)).toString('latin1').slice(4, 8)).toBe('IEND')
    const { data } = await sharp(withText).raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)]).toEqual([0xAB, 0xCD, 0xEF])
    expect(() => insertPngText(png, [['k', '☕']])).toThrow()
  })

  it('JSON is ASCII as json.dumps writes it, and reads back the same', () => {
    const v = { 10: 'x', 3: { t: 'café ☕ 🦊\n"q"\u007f' } }
    const s = asciiJson(v)
    expect(/^[\x20-\x7e]*$/.test(s)).toBe(true)
    expect(JSON.parse(s)).toEqual(v)
  })
})

// ── The result store ─────────────────────────────────────────────────────────

describe('the result store', () => {
  const store = (hosted: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'runner-save-store-'))
    return { root, results: createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted }) }
  }
  const png = new Uint8Array([1, 2, 3])

  it('saves under a subfolder of the user’s folder, in output or temp; refuses one that leaves it', async () => {
    const { root, results } = store(true)
    const f = await results.save(png, { userId: 'user_1', prefix: 'x', ext: 'png', subfolder: 'a/b' })
    const u = `u_${shortUserHash('user_1')}`
    expect(f).toEqual({ filename: 'x_00001_.png', subfolder: `${u}/a/b`, type: 'output' })
    expect(existsSync(join(root, 'output', u, 'a', 'b', 'x_00001_.png'))).toBe(true)
    const t = await results.save(png, { userId: 'user_1', prefix: 'x', ext: 'png', folder: 'temp' })
    expect(t).toEqual({ filename: 'x_00001_.png', subfolder: u, type: 'temp' })
    for (const subfolder of ['..', '../x', 'a/../../b', '/abs', 'a\0b']) {
      await expect(results.save(png, { userId: 'user_1', prefix: 'x', ext: 'png', subfolder }), subfolder).rejects.toThrow(SAVE_OUTSIDE)
    }
    await expect(results.save(png, { userId: 'user_1', prefix: 'a/x', ext: 'png' })).rejects.toThrow(SAVE_OUTSIDE)
  })

  it('%batch_num%: the counter is read over the prefix as typed and moved on per picture', async () => {
    const { results } = store(false)
    const a = await results.save(png, { userId: null, prefix: 'f0', ext: 'png', counter: { prefix: 'f%batch_num%', offset: 0 } })
    const b = await results.save(png, { userId: null, prefix: 'f1', ext: 'png', counter: { prefix: 'f%batch_num%', offset: 1 } })
    expect([a.filename, b.filename]).toEqual(['f0_00001_.png', 'f1_00002_.png'])
  })

  it('savePreviewAs writes a plain name into temp (the runner’s folder locally, the user’s hosted), overwriting', async () => {
    const local = store(false)
    const f = await local.results.savePreviewAs(png, { filename: 'sailor_ab.png', userId: null })
    expect(f).toEqual({ filename: 'sailor_ab.png', subfolder: 'sailor_runner', type: 'temp' })
    await local.results.savePreviewAs(new Uint8Array([9]), { filename: 'sailor_ab.png', userId: null })
    expect([...readFileSync(join(local.root, 'temp', 'sailor_runner', 'sailor_ab.png'))]).toEqual([9])
    const hosted = store(true)
    expect((await hosted.results.savePreviewAs(png, { filename: 'p.png', userId: 'user_1' })).subfolder).toBe(`u_${shortUserHash('user_1')}`)
    for (const filename of ['../x.png', 'a/b.png', '', '..', 'x y.png']) {
      await expect(local.results.savePreviewAs(png, { filename, userId: null }), filename).rejects.toThrow()
    }
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('eligibility', () => {
  it('Save image and Preview image count as work: cards and a Save image alone run in the runner', () => {
    expect(isRunnerEligible({ e: emptyImage(), s: saveImage(['e', 0]) }, CARDS)).toBe(true)
    expect(isRunnerEligible({ e: emptyImage(), p: previewImage(['e', 0]) }, CARDS)).toBe(true)
    expect(runnerTakesWorkflow({ e: emptyImage(), s: saveImage(['e', 0]) }, CARDS)).toBe(true)
  })

  it('with cards off, both are left to the engine, and the needs-the-engine list is unchanged', () => {
    const p: ApiPrompt = { 0: card('a.png'), 2: edit(['0', 0]), 3: outCard('2'), s: saveImage(['2', 0]), p: previewImage(['2', 0]) }
    for (const fam of [NO, EDIT]) {
      expect(isRunnerEligible(p, fam)).toBe(false)
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(isRunnerEligible({ e: emptyImage(), s: saveImage(['e', 0]) }, fam)).toBe(false)
    }
    // As before R1.5: the two classes are unknown to the runner, so they are what needs the engine.
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT, titleOf: id => id })).toEqual(['s', 'p'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual([])
    expect(isRunnerEligible(p, EDIT_CARDS)).toBe(true)
  })

  it('widgets as ComfyUI validates them; a Preview image read by anything, or a video, is left to the engine', () => {
    for (const over of [{ format: 'gif' }, { quality: 0 }, { quality: 101 }, { png_compression: 10 }, { scale: 0.05 }, { scale: 4.5 }, { max_dimension: 16385 }, { filename_prefix: ['x', 0] }]) {
      expect(isRunnerEligible({ e: emptyImage(), s: saveImage(['e', 0], over) }, CARDS), JSON.stringify(over)).toBe(false)
    }
    expect(isRunnerEligible({ e: emptyImage(), p: previewImage(['e', 0]), s: saveImage(['p', 0]) }, CARDS)).toBe(false)
    const video = { class_type: 'Video', inputs: { file: 'v.mp4', export: false, filename_prefix: 'video/ComfyUI' } }
    expect(isRunnerEligible({ v: video, s: saveImage(['v', 0]) }, CARDS)).toBe(false)
  })
})

// ── The engine ───────────────────────────────────────────────────────────────

const put = (root: string, name: string, bytes: Uint8Array) => {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('the engine (cards on)', () => {
  it('hosted: a Save image’s file is in the user’s folder, owned by the user, recorded as the run’s output, with the take’s prompt and workflow', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), s: saveImage(['e', 0], { filename_prefix: 'shots/%width%' }) }
    const workflow = { nodes: [{ id: 1, type: 'EmptyImage' }], note: 'café' }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START, workflow })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const rec = run.takes[0]!.nodes.s!
    expect(rec.credits).toBe(0)
    const u = `u_${shortUserHash(k.userId!)}`
    const file: OutputFile = { filename: '40_00001_.png', subfolder: `${u}/shots`, type: 'output' }
    expect(rec.outputs).toEqual([file])
    expect(k.graphRuns.appendOutput).toHaveBeenCalledWith(expect.any(String), `output:${u}/shots:40_00001_.png`)
    expect(k.records.write).toHaveBeenCalledTimes(1)
    expect((k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0].outputs).toEqual([file])
    const bytes = new Uint8Array(readFileSync(join(k.root, 'output', u, 'shots', '40_00001_.png')))
    const text = pngText(bytes)
    expect(JSON.parse(text.prompt!)).toEqual(p)
    expect(JSON.parse(text.workflow!)).toEqual(workflow)
    const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 's')!
    expect((shown.data as { output: unknown }).output).toEqual({ images: [file] })
    // The card costs nothing; the take pays the one render credit, as the ComfyUI path charges a graph with an output node.
    expect(k.ledger.settle.mock.calls.map(([, actual]) => actual)).toEqual([BASE_RENDER_CREDITS])
  })

  it('a prefix that would save outside the output folder fails the node in plain words', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), s: saveImage(['e', 0], { filename_prefix: '../escape/x' }) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.s!.error).toBe(SAVE_OUTSIDE)
    expect(existsSync(join(k.root, 'escape'))).toBe(false)
  })

  it('a file name the file system refuses fails the node without the server’s folders in the words', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), s: saveImage(['e', 0], { filename_prefix: 'x'.repeat(300) }) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.s!.error).toBe(SAVE_FAILED)
  })

  it('a failed take where only a Save image finished charges no render credit', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), s: saveImage(['e', 0]), bad: saveImage(['e', 0], { filename_prefix: '../x' }) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.bad!.status).toBe('error')
    expect(run.takes[0]!.nodes.s!.status).toBe('done')
    // The runner: the hold of one render credit is let go, nothing charged.
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(k.ledger.settle.mock.calls.filter(([, actual]) => actual > 0)).toEqual([])
  })


  it('Preview image writes to temp and is not an output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), p: previewImage(['e', 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes.p!.outputs).toEqual([])
    const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 'p')!
    const [img] = (shown.data as { output: { images: OutputFile[] } }).output.images
    expect(img!.type).toBe('temp')
    expect(img!.filename).toMatch(/^ComfyUI_temp_[a-z]{5}_00001_\.png$/)
    expect(existsSync(join(k.root, 'temp', img!.subfolder, img!.filename))).toBe(true)
    expect(k.graphRuns.appendOutput).not.toHaveBeenCalled()
    expect(k.records.write).not.toHaveBeenCalled()
  })

  it('an Image card fed a kept picture shows a copy /view serves, and hands the kept file on', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(), c: outCard('e'), s: saveImage(['c', 0]) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const kept = (run.takes[0]!.nodes.e!.values![0] as Extract<RunnerValue, { kind: 'files' }>).files[0]!
    expect(kept.type).toBe('kept')
    expect((run.takes[0]!.nodes.c!.values![0] as Extract<RunnerValue, { kind: 'files' }>).files).toEqual([kept])
    const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 'c')!
    const [img] = (shown.data as { output: { images: OutputFile[] } }).output.images
    expect(img).toEqual({ filename: `sailor_${kept.filename}`, subfolder: 'sailor_runner', type: 'temp' })
    const copy = new Uint8Array(readFileSync(join(k.root, 'temp', 'sailor_runner', img!.filename)))
    expect(sha256(copy)).toBe(kept.filename.replace(/\.png$/, ''))
    // The Save image downstream saved the picture (40 × 24).
    expect((await decode(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))).w).toBe(40)
  })

  it('a loader’s animation (Python saves each frame) is refused at the start, before any hold, where the runner can\'t make it a batch (an Image card\'s file; a LoadImage\'s APNG)', async () => {
    const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { rgb_turned: { name: string; file: string }[] }
    for (const name of ['a two-frame GIF', 'a two-frame animated PNG']) {
      const file = b64(VALUES.rgb_turned.find(c => c.name === name)!.file)
      // R11.9c fix round 3 (B1): LoadImage hands on a GIF's frames as its batch (saved frame by frame, below).
      const makers = name === 'a two-frame GIF' ? [(n: string) => card(n)] : [(n: string) => loadImage(n), (n: string) => card(n)]
      for (const make of makers) {
        const k = makeKit({ hosted: true, deps: { families: () => EDIT_CARDS } })
        put(k.root, 'anim.bin', file)
        for (const reader of [saveImage(['0', 0]), previewImage(['0', 0])]) {
          const p: ApiPrompt = { 0: make('anim.bin'), 1: outCard('0'), s: reader, 2: edit(['0', 0]), 3: outCard('2') }
          await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), `${name} ${make('x').class_type} ${reader.class_type}`)
            // R11.9c fix round 5 (M4): a LoadImage APNG in the words every reader of its batch uses.
            .rejects.toMatchObject({ statusCode: 400, message: make('x').class_type === 'LoadImage' ? LOADER_APNG_WORDS : PICTURE_ANIMATED })
        }
        expect(k.ledger.hold).not.toHaveBeenCalled()
        expect(k.fal.client.submit).not.toHaveBeenCalled()
      }
    }
  })

  it('a single-frame picture behind the same wires is saved', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const png = new Uint8Array(await sharp({ create: { width: 6, height: 4, channels: 3, background: '#102030' } }).png().toBuffer())
    put(k.root, 'still.png', png)
    const p: ApiPrompt = { 0: loadImage('still.png'), s: saveImage(['0', 0]) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const got = await decode(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect([got.w, got.h, got.channels, ...got.px.subarray(0, 3)]).toEqual([6, 4, 3, 0x10, 0x20, 0x30])
  })
})
