/**
 * Task R2.10 (step 3): the Shader effect, replayed from the browser's bake
 * (family `shader-bake`, decision 9). The pure half (Python's `_aspect_size`
 * and `frame_plan`, the catalog pins, the key) against
 * fixtures/runner-effects-shader.json (scripts/runner_effects_fixtures.py
 * --group shader); eligibility; and the runner's replay through the engine.
 * No GL render is compared: the browser's bytes are the result.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, LOCAL_RENDER_TYPES, PICTURE_OUTPUTS, PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { needsEngineDescription, needsEngineReasons, nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  SHADER_ASPECTS, SHADER_CATALOG_VERSION, bakedFileHash, shaderSeedUniform, SHADER_EFFECT_IDS, SHADER_GENERATIVE_IDS, SHADER_LEGACY_EFFECT_IDS, SHADER_NEEDS_PICTURE_FIRST,
  aspectSize, canonicalJson, framePlan, parseShaderBaked, sha256HexSync, shaderBakeKey, shaderBakeKeySync, shaderBakeKeyText, shaderBakedText,
} from '#shared/runner/shaderBakeKey'
import { EFFECT_PICTURE_ANIMATED } from '#shared/runner/effects'
import { collectInputFiles } from '~~/server/runner/inputs'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import { SHADER_BAKE_CHANGED, SHADER_BAKE_UNREADABLE, SHADER_BAKE_WRONG_SIZE, bakedPngSize } from '~~/server/runner/cards/shaderEffect'
import type { RunnerValue } from '~~/server/runner/types'

interface ShaderFixture {
  catalog_version: number
  effect_options: string[]
  aspect_options: string[]
  inputs: Record<string, { io: string; optional: boolean; min?: number; max?: number; default?: unknown }>
  output_node: boolean
  generative: string[]
  legacy: Record<string, string>
  aspect_sizes: { resolution: number; aspect: string; size: [number, number] }[]
  frame_plans: { batch: number; time: number; duration: number; fps: number; frames: number; plan: [number, number][] }[]
  raises: { name: string; error: string | null }[]
  seeds: [number, number][]
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-effects-shader.json'), 'utf8')) as ShaderFixture

const SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake'])
const SHADER_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake', 'fal-edit'])
const SHADER_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

// ── Graph helpers ────────────────────────────────────────────────────────────

const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false } })
const editNode = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
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

const shaderInputs = (over: Record<string, unknown> = {}) => ({ effect: 'halftone', params: '{}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 768, aspect: '1:1', ...over })

/** A Shader effect node, baked as the browser bakes it (the key over the prompt as it will be sent). */
function baked(prompt: ApiPrompt, id: string, files: string[], sources: string[]): ApiPrompt {
  const inputs = prompt[id]!.inputs
  inputs.sailor_baked = shaderBakedText(files, shaderBakeKeySync(inputs, sources, SHADER_CATALOG_VERSION, files))
  return prompt
}

/** Image card 'src.png' → a baked Shader effect → Save image. */
/** A bake's name for these bytes, as the browser names it: the first 32 hex of their sha256. */
const bakeNameOf = (bytes: Uint8Array) => `shader_bake_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`
/** A well-formed bake name for eligibility alone (no bytes behind it). */
const FAKE_BAKE = `shader_bake_${'0'.repeat(32)}.png`
/** The bake the engine tests put in input (setUp sets it). */
let BAKE = FAKE_BAKE

function cardShader(over: Record<string, unknown> = {}, bake = BAKE): ApiPrompt {
  const p: ApiPrompt = { 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs(over) } }, s: saveImage(['fx', 0]) }
  return baked(p, 'fx', [bake], ['src.png'])
}

function put(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

/** Deterministic pixels. */
function pixels(w: number, h: number, c: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * c)
  let x = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}
async function png(px: Uint8Array, w: number, h: number, c: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: c as 3 | 4 } }).png().toBuffer())
}
async function rawOf(bytes: Uint8Array): Promise<{ w: number; h: number; c: number; px: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, c: info.channels, px: new Uint8Array(data) }
}
const rgbOf = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 !== 3)

// ── Python's pure half ───────────────────────────────────────────────────────

describe('the pure half agrees with Python', () => {
  it('pins the catalog version, the effect options, the generative effects and the aspects', () => {
    expect(SHADER_CATALOG_VERSION).toBe(FX.catalog_version)
    expect([...SHADER_EFFECT_IDS, ...Object.keys(SHADER_LEGACY_EFFECT_IDS)]).toEqual(FX.effect_options)
    expect(SHADER_LEGACY_EFFECT_IDS).toEqual(FX.legacy)
    expect([...SHADER_GENERATIVE_IDS].sort()).toEqual(FX.generative)
    expect([...SHADER_ASPECTS]).toEqual(FX.aspect_options)
  })

  it('the rule row\'s widgets are the node\'s schema (ranges, required), and the node is an output node', () => {
    const row = RUNNER_NODE_RULES.ShaderEffect!
    expect(row.family).toBe('shader-bake')
    expect(row.local).toBe('render')
    expect(row.imageInputs).toEqual(['image'])
    expect(FX.inputs.image!.optional).toBe(true)
    for (const [name, spec] of Object.entries(row.widgets!)) {
      const py = FX.inputs[name]!
      expect(spec.required, name).toBe(!py.optional)
      // `effect` is a COMBO in Python: the runner reads it as text and checks it against the catalog ('shader-bake').
      expect(spec.type, name).toBe(name === 'effect' ? 'STRING' : py.io)
      expect(spec.min, name).toBe(py.min)
      expect(spec.max, name).toBe(py.max)
    }
    expect(Object.keys(row.widgets!).sort()).toEqual(Object.keys(FX.inputs).filter(k => k !== 'image').sort())
    expect(FX.output_node).toBe(true)
    expect(RUNNER_OUTPUT_CLASSES.has('ShaderEffect')).toBe(true)
    expect(SWITCHED_CLASSES.ShaderEffect).toBe('shader-bake')
    expect(LOCAL_RENDER_TYPES.has('ShaderEffect')).toBe(true)
    expect(PROVIDER_TYPES.has('ShaderEffect')).toBe(false)
  })

  it(`aspectSize is _aspect_size (${FX.aspect_sizes.length} cases, halves to even)`, () => {
    for (const c of FX.aspect_sizes) {
      const { w, h } = aspectSize(c.resolution, c.aspect)
      expect([w, h], `${c.resolution} ${c.aspect}`).toEqual(c.size)
    }
    // 72 at 16:9 is 40.5 tall: Python's round() takes it to 40.
    expect(FX.aspect_sizes.find(c => c.resolution === 72 && c.aspect === '16:9')!.size).toEqual([72, 40])
  })

  it(`framePlan is frame_plan (${FX.frame_plans.length} cases)`, () => {
    for (const c of FX.frame_plans) {
      const plan = framePlan(c.batch, c.time, c.duration, c.fps)
      const label = `batch ${c.batch}, time ${c.time}, duration ${c.duration}, fps ${c.fps}`
      expect(plan.length, label).toBe(c.frames)
      expect([...plan.slice(0, 8), plan[plan.length - 1]!], label).toEqual(c.plan)
    }
  })

  it('u_seed is Python\'s int(seed) % 10000 (whole, fractional and negative seeds)', () => {
    expect(FX.seeds.length).toBeGreaterThanOrEqual(10)
    for (const [seed, want] of FX.seeds) expect(shaderSeedUniform(seed), String(seed)).toBe(want)
  })

  it('records the node\'s raises before any render (the runner never takes these: engine eligibility)', () => {
    const errors = Object.fromEntries(FX.raises.map(r => [r.name, r.error]))
    expect(errors['unknown effect']).toMatch(/unknown effect/)
    expect(errors['no picture for a still effect']).toMatch(/needs an image input/)
    expect(errors['too many frames']).toMatch(/max is 300/)
    expect(errors['malformed params']).toMatch(/not a valid JSON object/)
  })
})

// ── The key ─────────────────────────────────────────────────────────────────

describe('the key', () => {
  it('sha256HexSync is SHA-256 (node crypto), across the padding edges', () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70_001]) {
      const b = pixels(n, 1, 1, n + 3)
      expect(sha256HexSync(b), `${n} bytes`).toBe(createHash('sha256').update(b).digest('hex'))
    }
  })

  it('canonical JSON sorts keys at every depth and writes no spaces', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 'x', c: null }], e: undefined })).toBe('{"a":[{"c":null,"d":"x"}],"b":1,"e":null}')
  })

  it('shaderBakeKey (Web Crypto, as the browser) equals the server\'s synchronous key and node crypto', async () => {
    const inputs = shaderInputs({ params: '{"u_amount":0.25}', time: 1.5, seed: 12345 })
    const F = [FAKE_BAKE]
    const text = shaderBakeKeyText(inputs, ['a.png [input]'], 1, F)
    expect(JSON.parse(text)).toEqual({ ...inputs, source: ['a.png [input]'], catalogVersion: 1, files: F })
    const node = createHash('sha256').update(text, 'utf8').digest('hex')
    expect(await shaderBakeKey(inputs, ['a.png [input]'], 1, F)).toBe(node)
    expect(shaderBakeKeySync(inputs, ['a.png [input]'], 1, F)).toBe(node)
    // Key order in the inputs does not matter; every keyed setting does.
    expect(shaderBakeKeySync(Object.fromEntries(Object.entries(inputs).reverse()), ['a.png [input]'], 1, F)).toBe(node)
    for (const k of ['effect', 'params', 'time', 'duration', 'fps', 'seed', 'resolution', 'aspect']) {
      expect(shaderBakeKeySync({ ...inputs, [k]: 7 }, ['a.png [input]'], 1, F), k).not.toBe(node)
    }
    expect(shaderBakeKeySync(inputs, ['b.png [input]'], 1, F)).not.toBe(node)
    expect(shaderBakeKeySync(inputs, ['a.png [input]'], 2, F)).not.toBe(node)
    // The baked files are in the key: another bake's files under this key are not replayed.
    expect(shaderBakeKeySync(inputs, ['a.png [input]'], 1, [`shader_bake_${'1'.repeat(32)}.png`])).not.toBe(node)
  })

  it('parseShaderBaked reads only { files: [text…], key: 64 hex }', () => {
    const key = 'a'.repeat(64)
    expect(parseShaderBaked(shaderBakedText(['x.png'], key))).toEqual({ files: ['x.png'], key })
    for (const bad of [undefined, 3, '', '{', '[]', JSON.stringify({ files: [], key }), JSON.stringify({ files: ['x'], key: 'A'.repeat(64) }), JSON.stringify({ files: [''], key }), JSON.stringify({ files: [1], key })]) {
      expect(parseShaderBaked(bad), String(bad)).toBeNull()
    }
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('eligibility (shader-bake and cards on)', () => {
  it('takes a Shader effect on an Image card with a bake whose key agrees', () => {
    const p = cardShader()
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
    expect(isRunnerEligible(p, SHADER)).toBe(true)
    expect(runnerTakesWorkflow(p, SHADER)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: SHADER, titleOf: id => id })).toEqual([])
    // Through a Gate and an Image card fed by a wire; a LoadImage's picture; a legacy effect name.
    const q: ApiPrompt = { 0: card('src.png'), g: { class_type: 'ComfyGateNode', inputs: { data_in: ['0', 0], bypass: true } }, c: outCard('g'), fx: { class_type: 'ShaderEffect', inputs: { image: ['c', 0], ...shaderInputs({ effect: 'filament' }) } }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(q, 'fx', [FAKE_BAKE], ['src.png']), 'fx', SHADER)).toBe(true)
    const l: ApiPrompt = { 0: { class_type: 'LoadImage', inputs: { image: 'sub/l.png [input]' } }, fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(l, 'fx', [FAKE_BAKE], ['sub/l.png [input]']), 'fx', SHADER)).toBe(true)
  })

  it('a generative effect with no picture is taken; a still effect with no picture is left to the engine (Python raises)', () => {
    const gen: ApiPrompt = { fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora' }) }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(gen, 'fx', [FAKE_BAKE], []), 'fx', SHADER)).toBe(true)
    const still: ApiPrompt = { fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'halftone' }) }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(still, 'fx', [FAKE_BAKE], []), 'fx', SHADER)).toBe(false)
  })

  it('a key mismatch, or no sailor_baked, leaves the node to the engine', () => {
    const stale = cardShader()
    stale.fx!.inputs.params = '{"u_amount":0.9}'
    expect(runnerTakesNode(stale, 'fx', SHADER)).toBe(false)
    expect(nodesNeedingEngine(stale, { runnerOn: true, families: SHADER, titleOf: id => id })).toEqual(['fx'])
    const otherSource = cardShader()
    otherSource[0]!.inputs.image = 'other.png'
    expect(runnerTakesNode(otherSource, 'fx', SHADER)).toBe(false)
    const none = cardShader()
    delete none.fx!.inputs.sailor_baked
    expect(runnerTakesNode(none, 'fx', SHADER)).toBe(false)
    expect(isRunnerEligible(none, SHADER)).toBe(false)
    const handMade = cardShader()
    handMade.fx!.inputs.sailor_baked = shaderBakedText([FAKE_BAKE], 'f'.repeat(64))
    expect(runnerTakesNode(handMade, 'fx', SHADER)).toBe(false)
    const twoFrames = cardShader()
    const two = [FAKE_BAKE, `shader_bake_${'1'.repeat(32)}.png`]
    twoFrames.fx!.inputs.sailor_baked = shaderBakedText(two, shaderBakeKeySync(twoFrames.fx!.inputs, ['src.png'], SHADER_CATALOG_VERSION, two))
    expect(runnerTakesNode(twoFrames, 'fx', SHADER)).toBe(false)
    // Another bake's files swapped in under the old key.
    const swapped = cardShader()
    swapped.fx!.inputs.sailor_baked = shaderBakedText([`shader_bake_${'2'.repeat(32)}.png`], parseShaderBaked(swapped.fx!.inputs.sailor_baked)!.key)
    expect(runnerTakesNode(swapped, 'fx', SHADER)).toBe(false)
  })

  it('a baked name that isn\'t one of the bake\'s own input files is left to the engine at eligibility, key or not', () => {
    for (const name of ['../../etc/passwd', `../shader_bake_${'0'.repeat(32)}.png`, `sub//shader_bake_${'0'.repeat(32)}.png`, `shader_bake_${'0'.repeat(32)}.png [output]`, `shader_bake_${'0'.repeat(32)}.png [temp]`, 'bake.png', `shader_bake_${'A'.repeat(32)}.png`, `shader_bake_${'0'.repeat(31)}.png`]) {
      const p = cardShader({}, name)
      expect(runnerTakesNode(p, 'fx', SHADER), name).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: SHADER, titleOf: id => id }), name).toEqual(['fx'])
    }
    for (const name of [`u_1/shader_bake_${'0'.repeat(32)}.png`, `shader_bake_${'0'.repeat(32)}.png [input]`]) {
      expect(bakedFileHash(name), name).toBe('0'.repeat(32))
      expect(runnerTakesNode(cardShader({}, name), 'fx', SHADER), name).toBe(true)
    }
  })

  it('an animated still (a duration), an effect the runner doesn\'t know, or a wired setting stays on the engine', () => {
    expect(runnerTakesNode(cardShader({ duration: 2 }), 'fx', SHADER)).toBe(false)
    expect(runnerTakesNode(cardShader({ effect: 'mine_abc~v2' }), 'fx', SHADER)).toBe(false)
    expect(runnerTakesNode(cardShader({ time: ['9', 0] }), 'fx', SHADER)).toBe(false)
    expect(runnerTakesNode(cardShader({ aspect: '2:1' }), 'fx', SHADER)).toBe(false)
  })

  it('an image from Generate an image in the same run is not taken, and names the reason', () => {
    const p: ApiPrompt = {
      g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      fx: { class_type: 'ShaderEffect', inputs: { image: ['g', 0], ...shaderInputs() } },
      s: saveImage(['fx', 0]),
    }
    baked(p, 'fx', [FAKE_BAKE], [])
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(false)
    const titleOf = (id: string) => (id === 'fx' ? 'Shader effect' : id)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: SHADER, titleOf })).toEqual(['Shader effect'])
    const reasons = needsEngineReasons(p, { runnerOn: true, families: SHADER })
    expect(reasons).toEqual([SHADER_NEEDS_PICTURE_FIRST])
    expect(SHADER_NEEDS_PICTURE_FIRST).toBe('This shader needs its picture before the run. Put the picture in an Image card first.')
    expect(needsEngineDescription(['Shader effect'], reasons)).toBe(`Only the engine can run “Shader effect”. ${SHADER_NEEDS_PICTURE_FIRST}`)
    // With the family off, no reason: nothing of the runner's is said about it.
    expect(needsEngineReasons(p, { runnerOn: true, families: new Set(['cards']) })).toEqual([])
    expect(needsEngineReasons(p, { runnerOn: false, families: SHADER })).toEqual([])
    // An Image card holding no picture is not a picture made in the run: no reason (the engine gives Python's own).
    const empty: ApiPrompt = { 0: card(''), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(empty, 'fx', SHADER)).toBe(false)
    expect(needsEngineReasons(empty, { runnerOn: true, families: SHADER })).toEqual([])
    // The description without reasons is as before.
    expect(needsEngineDescription(['A', 'B'])).toBe('Only the engine can run “A” and “B”.')
  })

  it('its picture reads downstream as a picture (Save image, Edit an image, a Frame) only while the family is on', () => {
    const p = cardShader()
    expect(runnerTakesNode(p, 's', SHADER)).toBe(true)
    expect(runnerTakesNode(p, 's', new Set(['cards']))).toBe(false)
    expect(PICTURE_OUTPUTS.ShaderEffect).toBeUndefined()
    expect(IMAGE_OUTPUT_CLASSES.has('ShaderEffect')).toBe(false)
    expect(pictureSourceOf(p, ['fx', 0])).toBe('tensor')
  })
})

describe('with shader-bake off, a Shader effect is exactly an unknown class (as before R2.10)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards', ['cards']],
    ['every family but shader-bake', RUNNER_FAMILIES.filter(f => f !== 'shader-bake')],
    ['every family but cards', RUNNER_FAMILIES.filter(f => f !== 'cards')],
  ]
  const unknown = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === 'ShaderEffect' ? { ...n, class_type: 'ShaderEffect__unknown' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = unknown(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(needsEngineReasons(p, { runnerOn: true, families }), `${label}, ${name}`).toEqual([])
      expect(runnerTakesWorkflow(p, families), `${label}, ${name}`).toBe(runnerTakesWorkflow(old, families))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
    }
  }

  it('over synthetic graphs', () => {
    sameAsBefore(cardShader(), 'card → shader → save')
    sameAsBefore({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora' }) }, s: saveImage(['fx', 0]) }, 'generative → save')
    sameAsBefore({ 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, e: editNode(['fx', 0]), o: outCard('e') }, 'card → shader → edit')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, with a baked Shader effect spliced in after every picture', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let spliced = 0
    let withOwn = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        if (Object.values(p).some(n => n.class_type === 'ShaderEffect')) { withOwn++; sameAsBefore(p, uuid) }
        const out: ApiPrompt = JSON.parse(JSON.stringify(p))
        let count = 0
        for (const [id, n] of Object.entries(p)) {
          const slots = Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, n.class_type) ? PICTURE_OUTPUTS[n.class_type]! : IMAGE_OUTPUT_CLASSES.has(n.class_type) ? [0] : []
          for (const slot of slots) {
            const fx = `sfx_${id}_${slot}`
            for (const r of Object.values(out)) {
              for (const [name, v] of Object.entries(r.inputs ?? {})) {
                if (Array.isArray(v) && v.length === 2 && v[0] === id && v[1] === slot) r.inputs[name] = [fx, 0]
              }
            }
            out[fx] = { class_type: 'ShaderEffect', inputs: { image: [id, slot], ...shaderInputs() } }
            const src = n.class_type === 'Image' && typeof n.inputs.image === 'string' && n.inputs.image && !Array.isArray(n.inputs.images) ? [n.inputs.image] : []
            baked(out, fx, [FAKE_BAKE], src)
            count++
          }
        }
        if (!count) continue
        spliced++
        sameAsBefore(out, `${uuid} spliced`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(spliced).toBeGreaterThanOrEqual(400)
    console.info(`shader-bake off invariant: ${graphs} saved graphs (${withOwn} with a Shader effect of their own), ${spliced} with one spliced in`)
  }, 300_000)
})

// ── The replay ───────────────────────────────────────────────────────────────

describe('the runner replays the bake (the engine, cards and shader-bake on)', () => {
  const W = 23
  const H = 19
  const bakeRgba = pixels(W, H, 4, 7)

  async function setUp(o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; bakeW?: number; bakeBytes?: Uint8Array } = {}) {
    const k = makeKit({ hosted: !!o.hosted, deps: { families: () => o.families ?? SHADER } })
    put(k.root, 'src.png', await png(pixels(W, H, 3, 3), W, H, 3))
    const bytes = o.bakeBytes ?? await png(o.bakeW ? pixels(o.bakeW, H, 4, 7) : bakeRgba, o.bakeW ?? W, H, 4)
    BAKE = bakeNameOf(bytes)
    put(k.root, BAKE, bytes)
    return k
  }

  it('keeps the uploaded RGB as an 8-bit RGB PNG, shows it as a unique live preview, and Save image saves the same pixels', async () => {
    const k = await setUp()
    const names: string[] = []
    for (let i = 0; i < 2; i++) {
      k.seen.length = 0
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      const rec = run.takes[0]!.nodes.fx!
      const v = rec.values![0] as Extract<RunnerValue, { kind: 'files' }>
      expect(v.kind).toBe('files')
      expect(v.files).toHaveLength(1)
      expect(v.tensors).toBeUndefined()
      const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 'fx')!
      const ui = (shown.data as { output: unknown }).output as { images: { filename: string; subfolder: string; type: string }[]; animated: boolean[] }
      expect(ui.animated).toEqual([false])
      expect(ui.images[0]!.type).toBe('temp')
      names.push(ui.images[0]!.filename)
      const preview = await rawOf(new Uint8Array(readFileSync(join(k.root, 'temp', ui.images[0]!.subfolder, ui.images[0]!.filename))))
      expect([preview.w, preview.h, preview.c]).toEqual([W, H, 3])
      expect(Buffer.compare(Buffer.from(preview.px), Buffer.from(rgbOf(bakeRgba)))).toBe(0)
      const saved = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', `ComfyUI_0000${i + 1}_.png`))))
      expect([saved.w, saved.h, saved.c]).toEqual([W, H, 3])
      expect(Buffer.compare(Buffer.from(saved.px), Buffer.from(rgbOf(bakeRgba)))).toBe(0)
    }
    // save_live_preview(unique=True): a new name every run.
    expect(names[0]).toMatch(/^live_preview_fx_\d{5}\.png$/)
    expect(names[1]).not.toBe(names[0])
  })

  it('an RGB bake is kept as it is; a generative effect replays at _aspect_size', async () => {
    const rgb = pixels(W, H, 3, 11)
    const k = await setUp({ bakeBytes: await png(rgb, W, H, 3) })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const saved = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(Buffer.compare(Buffer.from(saved.px), Buffer.from(rgb))).toBe(0)

    const { w, h } = aspectSize(256, '16:9')
    const genBytes = await png(pixels(w, h, 4, 5), w, h, 4)
    put(k.root, bakeNameOf(genBytes), genBytes)
    const gen = baked({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', resolution: 256, aspect: '16:9' }) }, s: saveImage(['fx', 0]) }, 'fx', [bakeNameOf(genBytes)], [])
    const r2 = await k.engine.startRun({ userId: k.userId, takes: [gen], ...START })
    await k.engine.settled(r2.runId)
    expect((await k.store.get(r2.runId))!.status).toBe('done')
    const g = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00002_.png'))))
    expect([g.w, g.h]).toEqual([256, 144])
  })

  it('a baked file of the wrong size, or not an 8-bit RGB(A) PNG, fails plainly', async () => {
    const k = await setUp({ bakeW: W + 1 })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(run.takes[0]!.nodes.fx!.error).toBe(SHADER_BAKE_WRONG_SIZE)

    const grey = await sharp(pixels(W, H, 1, 1), { raw: { width: W, height: H, channels: 1 } }).toColourspace('b-w').png().toBuffer()
    const jpeg = await sharp(pixels(W, H, 3, 1), { raw: { width: W, height: H, channels: 3 } }).jpeg().toBuffer()
    const deep = await sharp(pixels(W, H, 3, 1), { raw: { width: W, height: H, channels: 3 } }).png().toColourspace('rgb16').toBuffer()
    expect(bakedPngSize(new Uint8Array(grey))).toBeNull()
    expect(bakedPngSize(new Uint8Array(jpeg))).toBeNull()
    expect(bakedPngSize(new Uint8Array(deep))).toBeNull()
    expect(bakedPngSize(await png(bakeRgba, W, H, 4))).toEqual({ w: W, h: H })
    put(k.root, bakeNameOf(new Uint8Array(grey)), new Uint8Array(grey))
    const r2 = await k.engine.startRun({ userId: k.userId, takes: [cardShader({}, bakeNameOf(new Uint8Array(grey)))], ...START })
    await k.engine.settled(r2.runId)
    expect((await k.store.get(r2.runId))!.takes[0]!.nodes.fx!.error).toBe(SHADER_BAKE_UNREADABLE)
    // Bytes that aren't the ones the name hashes (overwritten after the bake) are not replayed.
    put(k.root, BAKE, await png(pixels(W, H, 4, 99), W, H, 4))
    const r3 = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
    await k.engine.settled(r3.runId)
    expect((await k.store.get(r3.runId))!.takes[0]!.nodes.fx!.error).toBe(SHADER_BAKE_CHANGED)
    // IHDR must be the first chunk: IHDR-like bytes in another first chunk are refused from the header.
    const good = await png(bakeRgba, W, H, 4)
    const fake = new Uint8Array(good)
    fake.set([0x74, 0x45, 0x58, 0x74], 12) // IHDR → tEXt
    expect(bakedPngSize(fake)).toBeNull()
  })

  it('a key mismatch is refused by the server as not the runner\'s (the browser then runs it on the engine)', async () => {
    const k = await setUp()
    const p = cardShader()
    p.fx!.inputs.seed = 43
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400 })
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a baked file owned by someone else is refused 403 before the hold (hosted)', async () => {
    const k = await setUp({ hosted: true })
    const owned: string[] = []
    k.deps.ownership.ownsInput = async (_u, f) => { owned.push(f.filename); return f.filename !== BAKE }
    expect(collectInputFiles(cardShader()).map(f => f.filename)).toEqual(['src.png', BAKE])
    await expect(k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })).rejects.toMatchObject({ message: 'This workflow uses a file that isn’t one of yours', statusCode: 403 })
    expect(owned).toContain(BAKE)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an animated source is not refused at the start of the take (the browser leaves it unbaked, to the engine); a hand-made bake of one fails plainly at its turn', async () => {
    const k = await setUp()
    const gif = await sharp(pixels(W, H * 2, 3, 9), { raw: { width: W, height: H * 2, channels: 3, pageHeight: H } as never }).gif().toBuffer()
    put(k.root, 'src.png', new Uint8Array(gif))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.fx!.error).toBe(EFFECT_PICTURE_ANIMATED)
    // Unbaked (as the browser leaves it), it is simply the engine's: named, with no refusal and no reason.
    const unbaked = cardShader()
    delete unbaked.fx!.inputs.sailor_baked
    expect(nodesNeedingEngine(unbaked, { runnerOn: true, families: SHADER, titleOf: id => id })).toEqual(['fx'])
    expect(needsEngineReasons(unbaked, { runnerOn: true, families: SHADER })).toEqual([])
  })

  it('a Shader effect feeding Edit an image hands off its kept PNG', async () => {
    const k = await setUp({ families: SHADER_EDIT })
    const p: ApiPrompt = { ...cardShader(), e: editNode(['fx', 0]), o: outCard('e') }
    delete p.s
    expect(isRunnerEligible(p, SHADER_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await rawOf(uploads[0]![0])
    expect(sent.c).toBe(3)
    expect(Buffer.compare(Buffer.from(sent.px), Buffer.from(rgbOf(bakeRgba)))).toBe(0)
  })

  it('a Shader effect → Frame renders as if the Frame read the kept PNG', async () => {
    const k = await setUp({ families: SHADER_FRAME })
    const p: ApiPrompt = { ...cardShader(), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }
    delete p.s
    expect(isRunnerEligible(p, SHADER_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await rawOf(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h]).toEqual([W, H])
    // Read as the tensor it is (bytes / 255, RGB): the same render as a Frame over an Image card of the kept RGB PNG.
    put(k.root, 'same.png', await png(rgbOf(bakeRgba), W, H, 3))
    const q: ApiPrompt = { 0: card('same.png'), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['0', 0] }) } }
    const r2 = await k.engine.startRun({ userId: k.userId, takes: [q], ...START })
    await k.engine.settled(r2.runId)
    const run2 = (await k.store.get(r2.runId))!
    expect(run2.status).toBe('done')
    const f2 = run2.takes[0]!.nodes.f!.outputs[0]!
    const other = await rawOf(new Uint8Array(readFileSync(join(k.root, f2.type, f2.subfolder, f2.filename))))
    expect([frame.c, other.c]).toEqual([3, 3])
    expect(Buffer.compare(Buffer.from(frame.px), Buffer.from(other.px))).toBe(0)
  })
})
