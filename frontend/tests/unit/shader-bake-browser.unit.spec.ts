/**
 * Task R2.10 (step 3): the browser's half of the Shader effect bake
 * (app/lib/runner/shaderBake.ts), with a fake renderer and a fake upload.
 * The uniform builder the node's preview uses (resolveUniforms) is checked
 * against Python's to_uniforms(resolve_params) for every catalog effect
 * (fixtures/runner-effects-shader.json); a bake's prompt is then taken by
 * the runner's eligibility and replayed byte for byte by planNode.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode } from '#shared/runner/eligibility'
import {
  SHADER_CATALOG_VERSION, SHADER_FRAMES_TOO_MUCH, SHADER_FRAME_TOO_LARGE, aspectSize, framePlan, parseShaderBaked, shaderBakeKeySync, shaderBakeProblem, shaderMakesBatch, shaderSourcesOf, shaderTooManyFramesWords,
} from '#shared/runner/shaderBakeKey'
import { loadFramesPick } from '~~/server/runner/media/frameNodes'
import { catalogPayload } from '~~/server/native/shaderCatalog'
import { planNode, type DeriveIO, type NodePlan } from '~~/server/runner/executors'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import {
  SHADER_BAKE_ENV_WORDS, SHADER_SOURCE_UNREADABLE, bakeShaderEffects, bakeShaderTakes, bakeUniforms, loadFramesPickOf, newBakeFolder, paramsPortable, pictureIsAnimated, shaderBakeKey, stopShaderBakes, takeWantsShaderBake, viewUrlOf,
  type BakeFramesSource, type ShaderBakeContext, type ShaderBakeRunContext,
} from '~/lib/runner/shaderBake'
import { parseParams, resolveUniforms } from '~/lib/shaderfx/params'
import type { ShaderPass } from '~/lib/shaderfx/renderer'
import type { EffectDef, ShaderFxCatalog } from '~/lib/shaderfx/types'

interface UniformCase { effect: string; case: string; params: string; uniforms?: Record<string, number | number[]>; error?: string }
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-effects-shader.json'), 'utf8')) as { uniforms: UniformCase[] }
const CATALOG = catalogPayload(resolve(__dirname, '../../../shader_effects')) as unknown as ShaderFxCatalog
const defOf = (id: string) => CATALOG.effects.find(e => e.id === id)!
const SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake'])

describe('the browser\'s uniform builder is Python\'s to_uniforms(resolve_params)', () => {
  it(`for every catalog effect: its defaults, blank params and one non-default set (${FX.uniforms.length} cases)`, () => {
    let checked = 0
    for (const c of FX.uniforms.filter(x => ['default', 'blank', 'custom'].includes(x.case))) {
      const def = defOf(c.effect)
      expect(def, c.effect).toBeDefined()
      expect(paramsPortable(def, c.params), `${c.effect} ${c.case}`).toBe(true)
      const js = resolveUniforms(def, parseParams(c.params))
      expect(js, `${c.effect} ${c.case}`).toEqual(c.uniforms)
      checked++
    }
    expect(checked).toBe(CATALOG.effects.length * 3)
  })

  it('params Python reads differently from the browser, or can\'t read, are not portable (the bake leaves them to the engine)', () => {
    let differ = 0
    for (const c of FX.uniforms.filter(x => x.case === 'nonportable' || x.case === 'malformed')) {
      const def = defOf(c.effect)
      expect(paramsPortable(def, c.params), `${c.effect} ${c.case}`).toBe(false)
      if (c.case === 'malformed') expect(c.error, c.effect).toMatch(/not a valid JSON object/)
      else if (JSON.stringify(resolveUniforms(def, parseParams(c.params))) !== JSON.stringify(c.uniforms)) differ++
    }
    // The refusal is needed: most effects would render other values than Python's.
    expect(differ).toBeGreaterThan(CATALOG.effects.length / 2)
    const halftone = defOf('halftone')
    for (const bad of ['{"u_x":NaN}', '[]', '"{}"', '{"u_scale":"3"}', '{"u_scale":1e400}']) {
      const text = bad.replace('u_x', halftone.params[0]!.uniform).replace('u_scale', halftone.params[0]!.uniform)
      expect(paramsPortable(halftone, text), text).toBe(false)
    }
    expect(paramsPortable(halftone, `{"${halftone.params[0]!.uniform}":null}`)).toBe(true)
    // Colours: 4 digits (the browser reads black, Python #aabbcc), spaces or two '#' (the browser trims, Python refuses).
    const chrome = defOf('chrome')
    const tint = chrome.params.find(q => q.type === 'color')!.uniform
    for (const bad of ['#abcd', ' #abc', '##abc', 'abcde']) expect(paramsPortable(chrome, JSON.stringify({ [tint]: bad })), bad).toBe(false)
    for (const good of ['#abc', 'abc', '#a1B2c3', '#a1b2c3d4']) expect(paramsPortable(chrome, JSON.stringify({ [tint]: good })), good).toBe(true)
    // Ramps: a list of stops with number positions and portable colours; as text (Python: the default) or a text position, not.
    const heat = defOf('heatmap')
    const ramp = heat.params.find(q => q.type === 'gradient')!.uniform
    const stops = [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }]
    expect(paramsPortable(heat, JSON.stringify({ [ramp]: stops }))).toBe(true)
    expect(paramsPortable(heat, JSON.stringify({ [ramp]: JSON.stringify(stops) }))).toBe(false)
    expect(paramsPortable(heat, JSON.stringify({ [ramp]: [{ pos: '0', color: '#000' }, { pos: 1, color: '#fff' }] }))).toBe(false)
    expect(paramsPortable(heat, JSON.stringify({ [ramp]: [{ pos: 0, color: '#0000' }, { pos: 1, color: '#fff' }] }))).toBe(false)
    expect(paramsPortable(halftone, 3)).toBe(false)
  })

  it('bakeUniforms adds the textures\' extraUniforms, then u_time, u_seed (seed % 10000) and u_hasInput, as Python', () => {
    const ascii = defOf('ascii_dither')
    const u = bakeUniforms(ascii, '{}', { time: 1.25, seed: 123_456, hasInput: true })
    for (const [k, v] of Object.entries(ascii.textures[0]!.extraUniforms ?? {})) expect(u[k], k).toBe(v)
    expect([u.u_time, u.u_seed, u.u_hasInput]).toEqual([1.25, 3456, 1])
    // int(seed) first, as Python: 5.5 renders as 5.
    expect(bakeUniforms(ascii, '{}', { time: 0, seed: 5.5, hasInput: true }).u_seed).toBe(5)
    expect(bakeUniforms(defOf('aurora'), '{}', { time: 0, seed: 42, hasInput: false }).u_hasInput).toBe(0)
  })
})

// ── The bake ─────────────────────────────────────────────────────────────────

const shaderInputs = (over: Record<string, unknown> = {}) => ({ effect: 'halftone', params: '{}', time: 0.5, duration: 0, fps: 24, seed: 12_345, resolution: 256, aspect: '16:9', ...over })
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false } })

function pixels(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24 }
  return out
}

/** A fake page: the renderer records what it is asked; readPixels gives pixels made from the size (alpha not 255). */
function fakePage(o: {
  failRender?: (passes: ShaderPass[]) => boolean; animated?: boolean; clamp?: boolean
  /** R11.9c: the frames an animated picture or a clip holds (its count, and how many it yields). */
  frames?: number; count?: number; width?: number; height?: number; failUpload?: boolean
  onRender?: (n: number) => void; onUpload?: (n: number) => void
} = {}) {
  const renders: { passes: ShaderPass[]; base: unknown; w: number; h: number }[] = []
  const uploads: { bytes: Uint8Array; name: string }[] = []
  const read: Uint8Array[] = []
  const sources: string[] = []
  const opened: BakeFramesSource[] = []
  const events: string[] = []
  const subfolders: (string | undefined)[] = []
  const abandoned: string[] = []
  let closed = 0
  const ctx: ShaderBakeContext = {
    catalog: CATALOG,
    renderer: {
      render(passes, base, w, h) {
        if (o.failRender?.(passes)) throw new Error('WebGL2 unavailable')
        renders.push({ passes, base, w, h })
        events.push('render')
        o.onRender?.(renders.length)
        return { w, h } as unknown as HTMLCanvasElement
      },
    },
    async upload(bytes, name, signal, subfolder) {
      if (signal?.aborted) throw new Error('aborted')
      if (o.failUpload) throw new Error('403')
      uploads.push({ bytes, name }); subfolders.push(subfolder); events.push('upload'); o.onUpload?.(uploads.length); return `u_x/${name}`
    },
    async abandon(folder) { abandoned.push(folder) },
    async sourceFile(file) { sources.push(file); return { image: { src: file } as unknown as TexImageSource, width: 23, height: 19, ...(o.animated ? { animated: true } : {}) } },
    async sourceFrames(src) {
      opened.push(src)
      const n = o.frames ?? 2
      async function* frames(): AsyncIterable<TexImageSource> { for (let i = 0; i < n; i++) yield { frame: i } as unknown as TexImageSource }
      return { count: o.count ?? n, width: o.width ?? 17, height: o.height ?? 11, frames: frames(), close() { closed++ } }
    },
    async texture(_def, t) { return { texture: t.file } as unknown as TexImageSource },
    blank(w, h) { return { blank: [w, h] } as unknown as TexImageSource },
    readPixels(_canvas, w, h) {
      if (o.clamp) throw new Error('The picture is too large for this browser to render the shader')
      const px = pixels(w * h * 4, w * 31 + h); read.push(px.slice()); return px },
    async encodePng(rgba, w, h) { return new Uint8Array(await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()) },
  }
  return { ctx, renders, uploads, read, sources, opened, events, subfolders, abandoned, closed: () => closed }
}

describe('bakeShaderEffects (a fake renderer and upload)', () => {
  it('renders a Shader effect on an Image card at the picture\'s size with Python\'s uniforms, uploads its PNG under its content hash and writes sailor_baked', async () => {
    const page = fakePage()
    const p: ApiPrompt = { 0: card('pics/src.png [input]'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r).toEqual({ baked: ['fx'], failed: [] })
    expect(page.sources).toEqual(['pics/src.png [input]'])
    expect(page.renders).toHaveLength(1)
    const { passes, base, w, h } = page.renders[0]!
    expect([w, h]).toEqual([23, 19])
    expect(base).toEqual({ src: 'pics/src.png [input]' })
    const def = defOf('halftone')
    expect(passes).toHaveLength(def.passes ?? 1)
    expect(passes[0]!.source).toBe(def.source)
    expect(passes[0]!.uniforms).toEqual({ ...bakeUniforms(def, '{}', { time: 0.5, seed: 12_345, hasInput: true }), u_pass: 0, u_passCount: def.passes ?? 1 })
    // The PNG: the RGB read back, alpha dropped (255).
    expect(page.uploads).toHaveLength(1)
    const up = page.uploads[0]!
    expect(up.name).toBe(`shader_bake_${createHash('sha256').update(up.bytes).digest('hex').slice(0, 32)}.png`)
    const { data, info } = await sharp(up.bytes).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels]).toEqual([23, 19, 4])
    const want = page.read[0]!
    for (let i = 3; i < want.length; i += 4) want[i] = 255
    expect(Buffer.compare(data, Buffer.from(want))).toBe(0)
    // sailor_baked: the stored name, and the key the runner works out from the prompt as sent.
    const baked = parseShaderBaked(p.fx!.inputs.sailor_baked)!
    expect(baked.files).toEqual([`u_x/${up.name}`])
    expect(baked.key).toBe(await shaderBakeKey(p.fx!.inputs, ['pics/src.png [input]'], CATALOG.version, baked.files))
    expect(baked.key).toBe(shaderBakeKeySync(p.fx!.inputs, ['pics/src.png [input]'], SHADER_CATALOG_VERSION, baked.files))
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
  })

  it('a generative effect with no picture renders on a black base at _aspect_size; a textured or multi-pass effect gets its textures and passes', async () => {
    const page = fakePage()
    const p: ApiPrompt = {
      a: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora' }) },
      t: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ effect: 'ascii_dither' }) } },
      b: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ effect: 'bloom' }) } },
      0: card('src.png'),
    }
    expect((await bakeShaderEffects(p, page.ctx)).baked.sort()).toEqual(['a', 'b', 't'])
    const byId = (id: string) => page.renders.find(r => r.passes[0]!.id === id)!
    const { w, h } = aspectSize(256, '16:9')
    expect([byId('aurora').w, byId('aurora').h]).toEqual([w, h])
    expect(byId('aurora').base).toEqual({ blank: [w, h] })
    expect(byId('aurora').passes[0]!.uniforms.u_hasInput).toBe(0)
    expect(byId('ascii_dither').passes[0]!.textures).toEqual({ [defOf('ascii_dither').textures[0]!.uniform]: { texture: defOf('ascii_dither').textures[0]!.file } })
    expect(byId('bloom').passes).toHaveLength(defOf('bloom').passes)
    for (const id of ['a', 't', 'b']) expect(runnerTakesNode(p, id, SHADER), id).toBe(true)
  })

  it('the same picture baked twice uploads under one name (content hash: repeats dedupe)', async () => {
    const page = fakePage()
    const p: ApiPrompt = {
      0: card('src.png'),
      x: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } },
      y: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ seed: 7 }) } },
    }
    await bakeShaderEffects(p, page.ctx)
    expect(page.uploads.map(u => u.name)[0]).toBe(page.uploads.map(u => u.name)[1])
    expect(parseShaderBaked(p.x!.inputs.sailor_baked)!.key).not.toBe(parseShaderBaked(p.y!.inputs.sailor_baked)!.key)
  })

  it('leaves to the engine (no bake, no render) what the runner doesn\'t replay', async () => {
    const page = fakePage()
    const gen = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
    const p: ApiPrompt = {
      0: card('src.png'),
      g: gen,
      made: { class_type: 'ShaderEffect', inputs: { image: ['g', 0], ...shaderInputs() } },
      mine: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ effect: 'mine_abc~v1' }) } },
      junk: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ params: '{"u_x": "0.5"}'.replace('u_x', defOf('halftone').params[0]!.uniform) }) } },
      still: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'halftone' }) },
      wired: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ seed: ['9', 0] }) } },
    }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r).toEqual({ baked: [], failed: [] })
    expect(page.renders).toHaveLength(0)
    for (const id of ['made', 'mine', 'junk', 'still', 'wired']) expect(p[id]!.inputs.sailor_baked, id).toBeUndefined()
  })

  it('a render that fails leaves that node without a bake and reports it; the others still bake', async () => {
    const page = fakePage({ failRender: passes => passes[0]!.id === 'bloom' })
    const p: ApiPrompt = {
      0: card('src.png'),
      ok: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } },
      bad: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ effect: 'bloom' }), sailor_baked: 'stale' } },
    }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r.baked).toEqual(['ok'])
    // Fix round 1 (I3): this browser's failure, in words saying what to do.
    expect(r.failed).toEqual([{ nodeId: 'bad', error: SHADER_BAKE_ENV_WORDS.webgl, cause: 'environment' }])
    expect(p.bad!.inputs.sailor_baked).toBeUndefined()
    expect(runnerTakesNode(p, 'bad', SHADER)).toBe(false)
    expect(runnerTakesNode(p, 'ok', SHADER)).toBe(true)
  })

  it('the runner replays the uploaded bytes: the kept PNG\'s pixels are the uploaded RGB', async () => {
    const page = fakePage()
    const p: ApiPrompt = { 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    await bakeShaderEffects(p, page.ctx)
    const src = new Uint8Array(await sharp(pixels(23 * 19 * 3, 1), { raw: { width: 23, height: 19, channels: 3 } }).png().toBuffer())
    const store = new Map<string, Uint8Array>([['input:/src.png', src], [`input:u_x/${page.uploads[0]!.name}`, page.uploads[0]!.bytes]])
    const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}/${f.filename}`
    let seq = 0
    const io: DeriveIO = {
      read: async (f) => { const b = store.get(keyOf(f)); if (!b) throw new Error(`no ${keyOf(f)}`); return b },
      keep: async (bytes, ext) => { const f: OutputFile = { filename: `k${++seq}.${ext}`, subfolder: 'run', type: 'kept' }; store.set(keyOf(f), bytes); return f },
      saveAsset: async () => { throw new Error('no assets') },
      savePreview: async (bytes, o) => { const f: OutputFile = { filename: `live_preview_${o.nodeId}_00001.png`, subfolder: '', type: 'temp' }; store.set(keyOf(f), bytes); return f },
      savePreviewAs: async () => { throw new Error('no fixed previews') },
      hosted: false, signal: new AbortController().signal, nodeId: 'fx', runWorkflow: null, runPrompt: p,
    }
    const plan: NodePlan = await planNode({
      prompt: p, nodeId: 'fx', families: SHADER, gateOpen: false,
      filesFrom: ([id]) => (id === '0' ? [{ filename: 'src.png', subfolder: '', type: 'input' }] : []), toUrl: async () => '',
    })
    const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)
    const v = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    const { data, info } = await sharp(store.get(keyOf(v.files[0]!))!).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels]).toEqual([23, 19, 3])
    const rgb = page.read[0]!.filter((_, i) => i % 4 !== 3)
    expect(Buffer.compare(data, Buffer.from(rgb))).toBe(0)
    expect(made.ui).toEqual({ images: [{ filename: 'live_preview_fx_00001.png', subfolder: '', type: 'temp' }], animated: [false] })
  })

  it('R11.9c: an animated picture is baked frame by frame (u_time stepped by 1 / fps), its frames uploaded after every render, and taken', async () => {
    const page = fakePage({ animated: true, frames: 3 })
    const p: ApiPrompt = { 0: card('anim.gif'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ fps: 8 }) } }, s: saveImage(['fx', 0]) }
    expect(await bakeShaderEffects(p, page.ctx)).toEqual({ baked: ['fx'], failed: [] })
    expect(page.opened).toEqual([{ kind: 'picture', file: 'anim.gif' }])
    expect(page.renders.map(r => r.base)).toEqual([{ frame: 0 }, { frame: 1 }, { frame: 2 }])
    expect(page.renders.map(r => [r.w, r.h])).toEqual([[17, 11], [17, 11], [17, 11]])
    expect(page.renders.map(r => r.passes[0]!.uniforms.u_time)).toEqual([0.5, 0.625, 0.75])
    expect(page.renders.every(r => r.passes[0]!.uniforms.u_hasInput === 1)).toBe(true)
    // Fix round 1 (I2): each frame uploaded as soon as it is drawn.
    expect(page.events).toEqual(['render', 'upload', 'render', 'upload', 'render', 'upload'])
    expect(page.closed()).toBe(1)
    expect(parseShaderBaked(p.fx!.inputs.sailor_baked)!.files).toHaveLength(3)
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
    expect(shaderMakesBatch(p, 'fx')).toBe(true)
  })

  it('a drawing buffer the browser clamped is not uploaded; the node goes to the engine', async () => {
    const page = fakePage({ clamp: true })
    const p: ApiPrompt = { 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } } }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r.failed.map(f => f.nodeId)).toEqual(['fx'])
    expect(page.uploads).toHaveLength(0)
    expect(p.fx!.inputs.sailor_baked).toBeUndefined()
  })

  it('viewUrlOf turns a card\'s widget text into its /view link', () => {
    expect(viewUrlOf('a.png')).toBe('/view?filename=a.png&subfolder=&type=input')
    expect(viewUrlOf('u_1/sub/a b.png [output]')).toBe('/view?filename=a+b.png&subfolder=u_1%2Fsub&type=output')
  })
})

// The EffectDef type is the catalog payload's: keep the fixture's catalog honest about it.
const _typed: EffectDef[] = CATALOG.effects
void _typed

// ── A run's takes (fix round 1) ──────────────────────────────────────────────

describe('bakeShaderTakes: only takes going to the runner, one context per run, released', () => {
  const runnerTake = (): ApiPrompt => ({ 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) })
  const engineTake = (): ApiPrompt => ({ ...runnerTake(), k: { class_type: 'KSampler', inputs: { seed: 0 } } })

  function runContext(o: Parameters<typeof fakePage>[0] = {}) {
    const page = fakePage(o)
    let made = 0
    let released = 0
    const make = async (): Promise<ShaderBakeRunContext> => { made++; return { ...page.ctx, release: () => { released++ } } }
    return { page, make, counts: () => ({ made, released }) }
  }

  it('a take going to the engine is not baked: no context, no render, no upload', async () => {
    const run = runContext()
    const p = engineTake()
    expect(takeWantsShaderBake(p, SHADER)).toBe(false)
    expect(await bakeShaderTakes([p, null], SHADER, run.make)).toEqual({ baked: [], failed: [] })
    expect(run.counts()).toEqual({ made: 0, released: 0 })
    expect(run.page.renders).toHaveLength(0)
    expect(run.page.uploads).toHaveLength(0)
    expect(p.fx!.inputs.sailor_baked).toBeUndefined()
    // With the family off, not even a runner take is baked.
    expect(takeWantsShaderBake(runnerTake(), new Set(['cards']))).toBe(false)
  })

  it('bakes only the takes going to the runner, with one context for the run, released once', async () => {
    const run = runContext()
    const a = runnerTake()
    const b = engineTake()
    const c = runnerTake()
    c.fx!.inputs.seed = 7
    const r = await bakeShaderTakes([a, b, c], SHADER, run.make)
    expect(r.baked).toEqual(['fx', 'fx'])
    expect(run.counts()).toEqual({ made: 1, released: 1 })
    expect(a.fx!.inputs.sailor_baked).toBeDefined()
    expect(b.fx!.inputs.sailor_baked).toBeUndefined()
    expect(runnerTakesNode(a, 'fx', SHADER) && runnerTakesNode(c, 'fx', SHADER)).toBe(true)
  })

  it('the context is released when a render fails, and when making it fails nothing is left behind', async () => {
    const run = runContext({ failRender: () => true })
    const r = await bakeShaderTakes([runnerTake()], SHADER, run.make)
    expect(r.failed).toHaveLength(1)
    expect(run.counts()).toEqual({ made: 1, released: 1 })
    const broken = await bakeShaderTakes([runnerTake()], SHADER, async () => { throw new Error('WebGL2 unavailable') })
    expect(broken).toEqual({ baked: [], failed: [{ nodeId: 'fx', error: SHADER_BAKE_ENV_WORDS.webgl, cause: 'environment' }] })
  })
})

describe('pictureIsAnimated (R11.9c: an animated source is baked frame by frame)', () => {
  it('a GIF of two frames, an APNG and an animated WebP are animated; single frames are not', async () => {
    const two = new Uint8Array(await sharp(pixels(8 * 16 * 3, 1), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } as never }).gif().toBuffer())
    const one = new Uint8Array(await sharp(pixels(8 * 8 * 3, 1), { raw: { width: 8, height: 8, channels: 3 } }).gif().toBuffer())
    const webpAnim = new Uint8Array(await sharp(pixels(8 * 16 * 3, 1), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } as never }).webp().toBuffer())
    const webp = new Uint8Array(await sharp(pixels(8 * 8 * 3, 1), { raw: { width: 8, height: 8, channels: 3 } }).webp().toBuffer())
    const png = new Uint8Array(await sharp(pixels(8 * 8 * 3, 1), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer())
    // An APNG: an acTL chunk right after IHDR (8-byte signature + 25-byte IHDR chunk).
    const actl = new Uint8Array([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])
    const apng = new Uint8Array(png.length + actl.length)
    apng.set(png.subarray(0, 33)); apng.set(actl, 33); apng.set(png.subarray(33), 33 + actl.length)
    expect([pictureIsAnimated(two), pictureIsAnimated(apng), pictureIsAnimated(webpAnim)]).toEqual([true, true, true])
    expect([pictureIsAnimated(one), pictureIsAnimated(webp), pictureIsAnimated(png), pictureIsAnimated(new Uint8Array(3))]).toEqual([false, false, false, false])
  })
})

// ── R11.9c: the animated Shader effect (USER ruling (d)) ─────────────────────

describe('R11.9c: an animated Shader effect, every frame baked in the browser', () => {
  const gen = (over: Record<string, unknown> = {}): ApiPrompt => ({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', ...over }) }, s: saveImage(['fx', 0]) })
  const loadFrames = { class_type: 'LoadVideoFrames', inputs: { file: 'clip.mp4', max_seconds: 10, max_frames: 600, max_size: 720, start_frame: 2, stride: 3 } }
  const MEDIA_SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake', 'media-video'])

  it('a time-animated shader renders frame_plan\'s frames on one base, u_time stepped as the node steps it', async () => {
    const page = fakePage()
    const p = gen({ time: 1, duration: 0.5, fps: 6 })
    expect(await bakeShaderEffects(p, page.ctx)).toEqual({ baked: ['fx'], failed: [] })
    const plan = framePlan(1, 1, 0.5, 6)
    expect(plan.map(([, t]) => t)).toEqual([1, 1 + 1 / 6, 1 + 2 / 6])
    expect(page.renders.map(r => r.passes[0]!.uniforms.u_time)).toEqual(plan.map(([, t]) => t))
    const { w, h } = aspectSize(256, '16:9')
    expect(page.renders.every(r => r.w === w && r.h === h && JSON.stringify(r.base) === JSON.stringify({ blank: [w, h] }))).toBe(true)
    // Fix round 1 (I2): each frame uploaded as soon as it is drawn; one PNG a frame, named by its content.
    expect(page.events).toEqual(['render', 'upload', 'render', 'upload', 'render', 'upload'])
    const baked = parseShaderBaked(p.fx!.inputs.sailor_baked)!
    expect(baked.files).toEqual(page.uploads.map(u => `u_x/${u.name}`))
    expect(baked.key).toBe(shaderBakeKeySync(p.fx!.inputs, [], SHADER_CATALOG_VERSION, baked.files))
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
    // The same graph as a still: one frame.
    const still = fakePage()
    await bakeShaderEffects(gen({ time: 1 }), still.ctx)
    expect(still.renders).toHaveLength(1)
  })

  it('a clip\'s frames (Load video frames): each frame rendered at time + i / fps; a clip of one frame gives frame_plan\'s frames from it', async () => {
    const page = fakePage({ frames: 4 })
    const p: ApiPrompt = { l: loadFrames, fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs({ duration: 3 }) } }, s: saveImage(['fx', 0]) }
    expect(await bakeShaderEffects(p, page.ctx)).toEqual({ baked: ['fx'], failed: [] })
    expect(page.opened).toEqual([{ kind: 'clip', clip: { loader: 'LoadVideoFrames', nodeId: 'l', file: 'clip.mp4', settings: { max_seconds: 10, max_frames: 600, max_size: 720, start_frame: 2, stride: 3 } } }])
    // A batch: its own frames (the duration is ignored, as frame_plan ignores it).
    expect(page.renders.map(r => r.passes[0]!.uniforms.u_time)).toEqual([0.5, 0.5 + 1 / 24, 0.5 + 2 / 24, 0.5 + 3 / 24])
    expect(page.renders.map(r => r.base)).toEqual([0, 1, 2, 3].map(frame => ({ frame })))
    const baked = parseShaderBaked(p.fx!.inputs.sailor_baked)!
    expect(baked.key).toBe(shaderBakeKeySync(p.fx!.inputs, shaderSourcesOf(p, 'fx')!, SHADER_CATALOG_VERSION, baked.files))
    expect(runnerTakesNode(p, 'fx', MEDIA_SHADER)).toBe(true)

    const one = fakePage({ frames: 1 })
    const q: ApiPrompt = { l: loadFrames, fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs({ duration: 0.125, fps: 24 }) } }, s: saveImage(['fx', 0]) }
    await bakeShaderEffects(q, one.ctx)
    expect(one.renders.map(r => r.base)).toEqual([0, 0, 0].map(frame => ({ frame })))
    expect(one.renders.map(r => r.passes[0]!.uniforms.u_time)).toEqual(framePlan(1, 0.5, 0.125, 24).map(([, t]) => t))
  })

  it('over the frame cap (hosted 300, locally 900): refused before any render or upload, in plain words, marked animated', async () => {
    const local = fakePage()
    const p = gen({ duration: 60, fps: 60 })
    const r = await bakeShaderEffects(p, local.ctx)
    expect(r).toEqual({ baked: [], failed: [{ nodeId: 'fx', error: shaderTooManyFramesWords(900, false), cause: 'graph', animated: true }] })
    expect([local.renders.length, local.uploads.length]).toEqual([0, 0])
    expect(p.fx!.inputs.sailor_baked).toBeUndefined()
    // 301 frames: within locally's 900, past hosted's 300.
    const hosted = fakePage()
    const q = gen({ duration: 301 / 7, fps: 7 })
    expect(framePlan(1, 0.5, 301 / 7, 7)).toHaveLength(301)
    expect((await bakeShaderEffects(q, hosted.ctx, { hosted: true })).failed).toEqual([{ nodeId: 'fx', error: shaderTooManyFramesWords(300, false), cause: 'graph', animated: true }])
    expect(hosted.renders).toHaveLength(0)
    // A clip past it, from its count before any frame is decoded: the clip words.
    const clip = fakePage({ count: 301, frames: 0 })
    const c: ApiPrompt = { l: loadFrames, fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } } }
    expect((await bakeShaderEffects(c, clip.ctx, { hosted: true })).failed).toEqual([{ nodeId: 'fx', error: shaderTooManyFramesWords(300, true), cause: 'graph', animated: true }])
    expect(clip.closed()).toBe(1)
  })

  it('fix round 1 (I2): the pixel caps the runner enforces, checked before anything is drawn, with the same shared check', async () => {
    // Hosted: 300 frames of a 4K clip pass the frame cap but not the batch's pixels (600 · 1920 · 1080).
    const big = fakePage({ count: 300, frames: 300, width: 3840, height: 2160 })
    const c: ApiPrompt = { l: loadFrames, fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } } }
    const r = await bakeShaderEffects(c, big.ctx, { hosted: true })
    expect(r.failed).toEqual([{ nodeId: 'fx', error: SHADER_FRAMES_TOO_MUCH, cause: 'graph', animated: true }])
    expect(shaderBakeProblem(300, 3840, 2160, true, true)).toBe(SHADER_FRAMES_TOO_MUCH)
    expect([big.renders.length, big.uploads.length]).toEqual([0, 0])
    // Locally the same clip is within the caps.
    expect(shaderBakeProblem(300, 3840, 2160, false, true)).toBeNull()
    // A frame past the place's largest (hosted 4096²), or a side past 8192: the frame words, even for a still.
    expect(shaderBakeProblem(1, 5000, 4000, true, false)).toBe(SHADER_FRAME_TOO_LARGE)
    expect(shaderBakeProblem(1, 9000, 100, false, false)).toBe(SHADER_FRAME_TOO_LARGE)
    expect(shaderBakeProblem(1, 4096, 4096, true, false)).toBeNull()
    // 900 generative frames at 2048² locally: 3.8 Gpx, within the local caps (10 000 · 8192²); hosted, the frame cap first.
    expect(shaderBakeProblem(900, 2048, 2048, false, false)).toBeNull()
    expect(shaderBakeProblem(900, 2048, 2048, true, false)).toBe(shaderTooManyFramesWords(300, false))
  })

  it('a failed animated bake is marked animated (the run is refused in plain words, never the engine); a still\'s is not', async () => {
    const page = fakePage({ failRender: () => true })
    const p: ApiPrompt = { ...gen({ duration: 1, fps: 2 }), st: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora' }) } }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r.failed).toEqual([
      { nodeId: 'fx', error: SHADER_BAKE_ENV_WORDS.webgl, cause: 'environment', animated: true },
      { nodeId: 'st', error: SHADER_BAKE_ENV_WORDS.webgl, cause: 'environment' },
    ])
    // An upload that fails: this browser's or connection's, in plain words.
    const up = fakePage({ failUpload: true })
    expect((await bakeShaderEffects(gen({ duration: 1, fps: 2 }), up.ctx)).failed).toEqual([{ nodeId: 'fx', error: SHADER_BAKE_ENV_WORDS.upload, cause: 'environment', animated: true }])
    // A source that can't be read is the graph's.
    const bad = fakePage()
    bad.ctx.sourceFile = async () => { throw new Error('404') }
    const q: ApiPrompt = { 0: card('gone.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } } }
    expect((await bakeShaderEffects(q, bad.ctx)).failed).toEqual([{ nodeId: 'fx', error: SHADER_SOURCE_UNREADABLE, cause: 'graph' }])
  })

  it('Stop keeps nothing: no more frames are drawn or uploaded, no bake is written, the bake\'s folder is abandoned (fix round 1, I2)', async () => {
    const take = () => gen({ duration: 1, fps: 4 })
    const drawing = fakePage({ onRender: n => { if (n === 2) stopShaderBakes() } })
    const p = take()
    const r = await bakeShaderTakes([p], SHADER, async () => ({ ...drawing.ctx, release: () => {} }))
    expect(r).toEqual({ baked: [], failed: [], stopped: true })
    expect(drawing.renders).toHaveLength(2)
    // Frame 1 was uploaded as it was drawn; frame 2 was drawn, then Stop: not uploaded.
    expect(drawing.uploads).toHaveLength(1)
    expect(p.fx!.inputs.sailor_baked).toBeUndefined()
    expect(drawing.abandoned).toEqual([drawing.subfolders[0]])

    const uploading = fakePage({ onUpload: n => { if (n === 1) stopShaderBakes() } })
    const q = take()
    const r2 = await bakeShaderTakes([q], SHADER, async () => ({ ...uploading.ctx, release: () => {} }))
    expect(r2.stopped).toBe(true)
    expect(uploading.renders).toHaveLength(1)
    expect(uploading.uploads).toHaveLength(1)
    expect(q.fx!.inputs.sailor_baked).toBeUndefined()
    expect(uploading.abandoned).toHaveLength(1)
    // A failure gives the bake up too.
    const failing = fakePage({ failRender: () => true })
    await bakeShaderTakes([take()], SHADER, async () => ({ ...failing.ctx, release: () => {} }))
    expect(failing.abandoned).toHaveLength(1)
    // A later run is not stopped by an earlier Stop.
    const after = fakePage()
    expect((await bakeShaderTakes([take()], SHADER, async () => ({ ...after.ctx, release: () => {} }))).baked).toEqual(['fx'])
    expect(after.abandoned).toEqual([])
  })

  it('fix round 1 (m1): Stop reaches only its own tab\'s bake', async () => {
    let stopped = false
    const other = fakePage({ onRender: n => { if (n === 1) { stopShaderBakes('tab-B'); stopped = true } } })
    const r = await bakeShaderTakes([gen({ duration: 1, fps: 4 })], SHADER, async () => ({ ...other.ctx, release: () => {} }), { tabId: 'tab-A' })
    expect(stopped).toBe(true)
    expect(r.baked).toEqual(['fx'])
    const own = fakePage({ onRender: n => { if (n === 1) stopShaderBakes('tab-A') } })
    expect((await bakeShaderTakes([gen({ duration: 1, fps: 4 })], SHADER, async () => ({ ...own.ctx, release: () => {} }), { tabId: 'tab-A' })).stopped).toBe(true)
  })

  it('fix round 1 (I4): every bake\'s frames go into a folder of its own (shader_bake/<32 random hex>), so accounts never share a name; names still read', async () => {
    const a = fakePage()
    const b = fakePage()
    await bakeShaderTakes([gen({ duration: 0.5, fps: 4 })], SHADER, async () => ({ ...a.ctx, release: () => {} }))
    await bakeShaderTakes([gen({ duration: 0.5, fps: 4 })], SHADER, async () => ({ ...b.ctx, release: () => {} }))
    expect(new Set(a.subfolders).size).toBe(1)
    expect(a.subfolders[0]).toMatch(/^shader_bake\/[0-9a-f]{32}$/)
    expect(b.subfolders[0]).toMatch(/^shader_bake\/[0-9a-f]{32}$/)
    expect(a.subfolders[0]).not.toBe(b.subfolders[0])
    // Same frames, same content names, different folders.
    expect(a.uploads.map(u => u.name)).toEqual(b.uploads.map(u => u.name))
    expect(newBakeFolder()).not.toBe(newBakeFolder())
  })

  it('a take whose reader needs the frames (Create video) is judged as the bake will leave it, and baked', async () => {
    const video = (from: ApiPrompt) => ({ ...from, c: { class_type: 'CreateVideo', inputs: { images: ['fx', 0], fps: 8 } }, v: { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } } })
    const moving = video({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', duration: 0.5, fps: 8 }) } })
    expect(takeWantsShaderBake(moving, MEDIA_SHADER)).toBe(true)
    const page = fakePage()
    const r = await bakeShaderTakes([moving], MEDIA_SHADER, async () => ({ ...page.ctx, release: () => {} }))
    expect(r.baked).toEqual(['fx'])
    expect(page.renders).toHaveLength(4)
    expect(runnerTakesNode(moving, 'c', MEDIA_SHADER)).toBe(true)
    // An Image card's picture into Create video: baked in case it is animated (known once read).
    expect(takeWantsShaderBake(video({ 0: card('anim.gif'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } } }), MEDIA_SHADER)).toBe(true)
    // Still bound for the engine (a class the runner doesn't run): not baked.
    expect(takeWantsShaderBake({ ...moving, k: { class_type: 'KSampler', inputs: { seed: 0 } } }, MEDIA_SHADER)).toBe(false)
  })

  it('loadFramesPickOf is the server\'s Load video frames pick (size, start, stride, count)', () => {
    const cases: [number, number, number | null, Record<string, number>][] = [
      [1920, 1080, 30, { max_seconds: 10, max_frames: 600, max_size: 720, start_frame: 0, stride: 1 }],
      [1280, 720, 24, { max_seconds: 2.5, max_frames: 600, max_size: 720, start_frame: 3, stride: 2 }],
      [641, 361, 29.97, { max_seconds: 0, max_frames: 77, max_size: 64, start_frame: 0, stride: 5 }],
      [100, 50, null, { max_seconds: 1, max_frames: 600, max_size: 2048, start_frame: 0, stride: 1 }],
      [333, 999, 60, { max_seconds: 0.01, max_frames: 600, max_size: 333, start_frame: 0, stride: 7 }],
    ]
    for (const [w, h, fps, s] of cases) {
      const server = loadFramesPick({ w, h, rate: fps ? { num: Math.round(fps * 1000), den: 1000 } : null }, s as never)
      const browser = loadFramesPickOf({ w, h, fps: fps ? Math.round(fps * 1000) / 1000 : null }, s)
      expect(browser, JSON.stringify([w, h, fps, s])).toEqual({ tw: server.tw, th: server.th, start: server.start, stride: server.stride, count: server.count })
    }
  })
})
