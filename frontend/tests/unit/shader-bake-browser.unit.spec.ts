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
import { SHADER_CATALOG_VERSION, aspectSize, parseShaderBaked, shaderBakeKeySync } from '#shared/runner/shaderBakeKey'
import { catalogPayload } from '~~/server/native/shaderCatalog'
import { planNode, type DeriveIO, type NodePlan } from '~~/server/runner/executors'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { bakeShaderEffects, bakeUniforms, paramsPortable, shaderBakeKey, viewUrlOf, type ShaderBakeContext } from '~/lib/runner/shaderBake'
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
function fakePage(o: { failRender?: (passes: ShaderPass[]) => boolean } = {}) {
  const renders: { passes: ShaderPass[]; base: unknown; w: number; h: number }[] = []
  const uploads: { bytes: Uint8Array; name: string }[] = []
  const read: Uint8Array[] = []
  const sources: string[] = []
  const ctx: ShaderBakeContext = {
    catalog: CATALOG,
    renderer: {
      render(passes, base, w, h) {
        if (o.failRender?.(passes)) throw new Error('WebGL2 unavailable')
        renders.push({ passes, base, w, h })
        return { w, h } as unknown as HTMLCanvasElement
      },
    },
    async upload(bytes, name) { uploads.push({ bytes, name }); return `u_x/${name}` },
    async sourceFile(file) { sources.push(file); return { image: { src: file } as unknown as TexImageSource, width: 23, height: 19 } },
    async texture(_def, t) { return { texture: t.file } as unknown as TexImageSource },
    blank(w, h) { return { blank: [w, h] } as unknown as TexImageSource },
    readPixels(_canvas, w, h) { const px = pixels(w * h * 4, w * 31 + h); read.push(px.slice()); return px },
    async encodePng(rgba, w, h) { return new Uint8Array(await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()) },
  }
  return { ctx, renders, uploads, read, sources }
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
    expect(baked.key).toBe(await shaderBakeKey(p.fx!.inputs, ['pics/src.png [input]'], CATALOG.version))
    expect(baked.key).toBe(shaderBakeKeySync(p.fx!.inputs, ['pics/src.png [input]'], SHADER_CATALOG_VERSION))
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
      animated: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ duration: 2 }) } },
      mine: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ effect: 'mine_abc~v1' }) } },
      junk: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ params: '{"u_x": "0.5"}'.replace('u_x', defOf('halftone').params[0]!.uniform) }) } },
      still: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'halftone' }) },
      wired: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs({ seed: ['9', 0] }) } },
    }
    const r = await bakeShaderEffects(p, page.ctx)
    expect(r).toEqual({ baked: [], failed: [] })
    expect(page.renders).toHaveLength(0)
    for (const id of ['made', 'animated', 'mine', 'junk', 'still', 'wired']) expect(p[id]!.inputs.sailor_baked, id).toBeUndefined()
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
    expect(r.failed).toEqual([{ nodeId: 'bad', error: 'WebGL2 unavailable' }])
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

  it('viewUrlOf turns a card\'s widget text into its /view link', () => {
    expect(viewUrlOf('a.png')).toBe('/view?filename=a.png&subfolder=&type=input')
    expect(viewUrlOf('u_1/sub/a b.png [output]')).toBe('/view?filename=a+b.png&subfolder=u_1%2Fsub&type=output')
  })
})

// The EffectDef type is the catalog payload's: keep the fixture's catalog honest about it.
const _typed: EffectDef[] = CATALOG.effects
void _typed
