/**
 * Task R2.10 (step 3): the Shader effect, replayed from the browser's bake
 * (family `shader-bake`, decision 9). The pure half (Python's `_aspect_size`
 * and `frame_plan`, the catalog pins, the key) against
 * fixtures/runner-effects-shader.json (scripts/runner_effects_fixtures.py
 * --group shader); eligibility; and the runner's replay through the engine.
 * No GL render is compared: the browser's bytes are the result.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  SHADER_MAX_FRAMES, shaderMakesBatch, shaderOverCapWords, shaderPlanCount, shaderSourceOfNode, shaderSourcesOf, shaderTooManyFramesWords,
  SHADER_ENGINE_WORDS, SHADER_FRAMES_TOO_MUCH, shaderBakeProblem, shaderEngineReason, shaderFrameCount,
} from '#shared/runner/shaderBakeKey'
import { CLAIMED_MARKER, SHADER_BAKE_UNCLAIMED_MS, __resetShaderBakeSweepForTests, abandonShaderBake, bakeFolderAbandoned, bakeFolderOf, bakeFoldersOf, claimShaderBakes, releaseInactiveShaderBakes, releaseShaderBakes, sweepShaderBakes } from '~~/server/runner/shaderBakeFiles'
import { outputKind } from '#shared/runner/values'
import { LOADER_FRAMES_TOO_MUCH, pictureBatchOverCaps } from '#shared/runner/media'
import { FACE_SWAP_ONE_PICTURE } from '#shared/runner/faceSwap'
import { LOADER_APNG_WORDS, cardPictureFiles } from '~~/server/runner/cards/bakeReplay'
import { loaderFramesOf, pictureBound } from '~~/server/runner/localModelStart'
import { outputKindsFor } from '#shared/runner/eligibility'
import { frameShapes } from '~~/server/runner/video/shapes'
import { hasVideoEffect, keptBatchBound, keptPeak } from '~~/server/runner/video/start'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { EFFECT_PICTURE_ANIMATED } from '#shared/runner/effects'
import { collectInputFiles } from '~~/server/runner/inputs'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import { SHADER_BAKE_CHANGED, SHADER_BAKE_FRAMES, SHADER_BAKE_UNREADABLE, SHADER_BAKE_WRONG_SIZE, bakedPngSize } from '~~/server/runner/cards/shaderEffect'
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
    // R11.9c: several frames over a picture are an animated picture's batch, counted against its frames at the
    // node's turn (SHADER_BAKE_FRAMES there); over no picture, the count must be frame_plan's.
    const twoFrames = cardShader()
    const two = [FAKE_BAKE, `shader_bake_${'1'.repeat(32)}.png`]
    twoFrames.fx!.inputs.sailor_baked = shaderBakedText(two, shaderBakeKeySync(twoFrames.fx!.inputs, ['src.png'], SHADER_CATALOG_VERSION, two))
    expect(runnerTakesNode(twoFrames, 'fx', SHADER)).toBe(true)
    const genTwo: ApiPrompt = { fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora' }) }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(genTwo, 'fx', two, []), 'fx', SHADER)).toBe(false)
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

  it('an effect the runner doesn\'t know, or a wired setting stays on the engine (R11.9c: a duration no longer does)', () => {
    // A duration's bake of one frame is not frame_plan's 48: not taken; R11.9c's tests take the 48 (below).
    expect(runnerTakesNode(cardShader({ duration: 2 }), 'fx', SHADER)).toBe(false)
    const gen: ApiPrompt = { fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', duration: 2 }) }, s: saveImage(['fx', 0]) }
    expect(runnerTakesNode(baked(gen, 'fx', [FAKE_BAKE], []), 'fx', SHADER)).toBe(false)
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
    // With the family off, no reason: nothing of the runner's is said about it (it isn't taken with every family on either).
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
      // R11.9a (row 25): the only reasons with the family off are switched-off words.
      for (const why of needsEngineReasons(p, { runnerOn: true, families })) expect(why, `${label}, ${name}`).toMatch(/is switched off right now\.$/)
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

  it('R11.9c: an animated source baked as one frame fails plainly at its turn (its frames don\'t match); unbaked, it names no reason', async () => {
    const k = await setUp()
    const gif = await sharp(pixels(W, H * 2, 3, 9), { raw: { width: W, height: H * 2, channels: 3, pageHeight: H } as never }).gif().toBuffer()
    put(k.root, 'src.png', new Uint8Array(gif))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [cardShader()], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.fx!.error).toBe(SHADER_BAKE_FRAMES)
    // Unbaked (the browser couldn't bake it), it is named, with no reason.
    const unbaked = cardShader()
    delete unbaked.fx!.inputs.sailor_baked
    expect(nodesNeedingEngine(unbaked, { runnerOn: true, families: SHADER, titleOf: id => id })).toEqual(['fx'])
    expect(needsEngineReasons(unbaked, { runnerOn: true, families: SHADER })).toEqual([])
    // Several pictures in one source (not something an Image card hands on) are still refused at the turn.
    expect(EFFECT_PICTURE_ANIMATED).toMatch(/animated/)
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

// ── R11.9c: the animated Shader effect (USER ruling (d)) ─────────────────────

describe('R11.9c: an animated Shader effect is baked frame by frame and kept as a frame batch', () => {
  const MEDIA_SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake', 'media-video'])
  const names = (n: number) => Array.from({ length: n }, (_, i) => `shader_bake_${i.toString(16).padStart(32, '0')}.png`)
  const gen = (over: Record<string, unknown> = {}): ApiPrompt => ({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', resolution: 256, aspect: '16:9', ...over }) }, s: saveImage(['fx', 0]) })
  const loadFrames = (file: string, s: Record<string, unknown> = {}) => ({ class_type: 'LoadVideoFrames', inputs: { file, max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1, ...s } })
  const clipShader = (n: number, s: Record<string, unknown> = {}): ApiPrompt => {
    const p: ApiPrompt = { l: loadFrames('clip.mp4', s), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    return baked(p, 'fx', names(n), shaderSourcesOf(p, 'fx')!)
  }

  it('frame_plan\'s count: one for a still, duration × fps (Python\'s round) when the shader moves over time', () => {
    expect(shaderPlanCount(shaderInputs())).toBe(1)
    expect(shaderPlanCount(shaderInputs({ duration: 2, fps: 24 }))).toBe(48)
    expect(shaderPlanCount(shaderInputs({ duration: 0.5, fps: 5 }))).toBe(2)
    expect(shaderPlanCount(shaderInputs({ duration: 0.01, fps: 24 }))).toBe(1)
    expect(shaderPlanCount(shaderInputs({ duration: 'x' }))).toBeNull()
    for (const c of FX.frame_plans.filter(f => f.batch === 1)) expect(shaderPlanCount(shaderInputs({ time: c.time, duration: c.duration, fps: c.fps })), JSON.stringify(c)).toBe(c.frames)
  })

  it('takes a time-animated bake of exactly frame_plan\'s frames; its output is a frame batch read as a clip\'s frames', () => {
    const p = baked(gen({ duration: 0.25, fps: 8 }), 'fx', names(2), [])
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
    expect(runnerTakesWorkflow(p, SHADER)).toBe(true)
    expect(shaderMakesBatch(p, 'fx')).toBe(true)
    expect(outputKind(p, ['fx', 0], outputKindsFor(SHADER))).toBe('frames')
    // Off: the browser never bakes it, and a bake handed in is not taken (the workflow is not the runner's).
    expect(runnerTakesNode(p, 'fx', new Set(['cards']))).toBe(false)
    // Unbaked, it is one picture, as before R11.9c (every answer for an unbaked graph unchanged).
    const unbaked = gen({ duration: 0.25, fps: 8 })
    expect(shaderMakesBatch(unbaked, 'fx')).toBe(false)
    expect(outputKind(unbaked, ['fx', 0], outputKindsFor(SHADER))).toBe('files')
    // One frame short, or one over: not the bake of these settings.
    expect(runnerTakesNode(baked(gen({ duration: 0.25, fps: 8 }), 'fx', names(1), []), 'fx', SHADER)).toBe(false)
    expect(runnerTakesNode(baked(gen({ duration: 0.25, fps: 8 }), 'fx', names(3), []), 'fx', SHADER)).toBe(false)
    // A still stays one picture.
    const still = baked(gen(), 'fx', names(1), [])
    expect(shaderMakesBatch(still, 'fx')).toBe(false)
    expect(outputKind(still, ['fx', 0], outputKindsFor(SHADER))).toBe('files')
    // Into an effect that takes one picture: refused plainly (row 15), never the engine.
    const blur: ApiPrompt = { ...p, b: { class_type: 'Blur', inputs: { image: ['fx', 0], type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } }, s: saveImage(['b', 0]) }
    const every = new Set<RunnerFamily>([...SHADER, 'effects-blur'])
    expect(runnerTakesNode(blur, 'b', every)).toBe(false)
  })

  it('takes a clip\'s frames (Load video frames, Get video components of a file) as its source; the key covers the clip and its pick', () => {
    const p = clipShader(3)
    expect(shaderSourceOfNode(p, 'fx')).toEqual({ kind: 'clip', clip: { loader: 'LoadVideoFrames', nodeId: 'l', file: 'clip.mp4', settings: { max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } } })
    expect(runnerTakesNode(p, 'fx', MEDIA_SHADER)).toBe(true)
    expect(runnerTakesWorkflow(p, MEDIA_SHADER)).toBe(true)
    expect(outputKind(p, ['fx', 0], outputKindsFor(MEDIA_SHADER))).toBe('frames')
    expect(needsEngineReasons(p, { runnerOn: true, families: MEDIA_SHADER })).toEqual([])
    // The pick changed after the bake: not this bake.
    const changed = clipShader(3)
    changed.l!.inputs.start_frame = 1
    expect(runnerTakesNode(changed, 'fx', MEDIA_SHADER)).toBe(false)
    // Get video components of a Load video, and of a Video card's own file.
    for (const src of [{ class_type: 'LoadVideo', inputs: { file: 'clip.mp4' } }, { class_type: 'Video', inputs: { file: 'clip.mp4', export: false, filename_prefix: 'v' } }]) {
      const q: ApiPrompt = { v: src, g: { class_type: 'GetVideoComponents', inputs: { video: ['v', 0] } }, fx: { class_type: 'ShaderEffect', inputs: { image: ['g', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
      expect(shaderSourcesOf(q, 'fx')).toEqual(['clip.mp4', 'GetVideoComponents'])
      expect(runnerTakesNode(baked(q, 'fx', names(5), ['clip.mp4', 'GetVideoComponents']), 'fx', MEDIA_SHADER), src.class_type).toBe(true)
    }
    // A clip made in the run (Create video) is still named as needing its picture first.
    const made: ApiPrompt = { c: { class_type: 'CreateVideo', inputs: { images: ['l', 0], fps: 24 } }, l: loadFrames('clip.mp4'), g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } }, fx: { class_type: 'ShaderEffect', inputs: { image: ['g', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    expect(shaderSourceOfNode(made, 'fx')).toBeNull()
    expect(needsEngineReasons(made, { runnerOn: true, families: MEDIA_SHADER })).toEqual([SHADER_NEEDS_PICTURE_FIRST])
  })

  it('fix round 1 (M1): each Shader effect still left to the engine names its cause in plain words', () => {
    const reason = (p: ApiPrompt) => needsEngineReasons(p, { runnerOn: true, families: SHADER })
    const one = (over: Record<string, unknown>) => cardShader(over)
    expect(reason(one({ effect: 'mine_abc~v2' }))).toEqual([SHADER_ENGINE_WORDS.myEffect])
    expect(reason(one({ effect: 'no_such_effect' }))).toEqual([SHADER_ENGINE_WORDS.unknownEffect])
    // A setting wired from a node whose value is made in the run (a typed card's is put in as typed, R11.9a).
    expect(shaderEngineReason(one({ seed: ['9', 0] }), 'fx', SHADER)).toBe(SHADER_ENGINE_WORDS.wired)
    // Params only Python reads: the browser doesn't bake it.
    const odd = one({ params: '{"u_amount":"0.5"}' })
    delete odd.fx!.inputs.sailor_baked
    expect(reason(odd)).toEqual([SHADER_ENGINE_WORDS.oddParams])
    const changed = cardShader()
    changed.fx!.inputs.seed = 43
    expect(reason(changed)).toEqual([SHADER_ENGINE_WORDS.keyMismatch])
    // Simply not baked (its take was bound for the engine, or a still's bake failed in this browser): no reason.
    const unbaked = cardShader()
    delete unbaked.fx!.inputs.sailor_baked
    expect(shaderEngineReason(unbaked, 'fx', SHADER)).toBeNull()
    // Off: nothing is said.
    expect(shaderEngineReason(one({ effect: 'mine_abc~v2' }), 'fx', new Set(['cards']))).toBeNull()
  })

  it('the frame cap (hosted 300, locally 900) in plain words, saying what to shorten', () => {
    expect(SHADER_MAX_FRAMES).toEqual({ hosted: 300, local: 900 })
    const at = (n: number, fps: number) => baked(gen({ duration: n / fps, fps }), 'fx', names(n), [])
    expect(shaderOverCapWords(at(300, 24), 'fx', true)).toBeNull()
    expect(shaderOverCapWords(at(301, 7), 'fx', true)).toBe(shaderTooManyFramesWords(300, false))
    expect(shaderOverCapWords(at(301, 7), 'fx', false)).toBeNull()
    expect(shaderOverCapWords(at(901, 17), 'fx', false)).toBe('This shader would make too many frames here. Keep it to 900 frames or fewer: shorten its duration or lower its frame rate.')
    expect(shaderOverCapWords(clipShader(301), 'fx', true)).toBe('This shader would make too many frames here. Use a clip or animation of 300 frames or fewer.')
  })

  async function setUp(o: { hosted?: boolean } = {}) {
    await requireMediaTools()
    return makeKit({ hosted: !!o.hosted, deps: { families: () => MEDIA_SHADER } })
  }
  /** Bakes `n` frames of w × h into input, as the browser uploads them; their names and RGB. */
  async function bake(k: ReturnType<typeof makeKit>, n: number, w: number, h: number, seed = 1) {
    const files: string[] = []
    const rgb: Uint8Array[] = []
    for (let i = 0; i < n; i++) {
      const rgba = pixels(w, h, 4, seed * 1000 + i)
      const bytes = await png(rgba, w, h, 4)
      put(k.root, bakeNameOf(bytes), bytes)
      files.push(bakeNameOf(bytes))
      rgb.push(rgbOf(rgba))
    }
    return { files, rgb }
  }
  const savedFrames = (k: ReturnType<typeof makeKit>) => (readdirSync(join(k.root, 'output'), { recursive: true }) as string[]).filter(f => f.endsWith('.png')).sort()

  it('a time-animated generative shader: its frames kept as one batch, each frame its bake\'s RGB, nothing held or charged (hosted)', async () => {
    const k = await setUp({ hosted: true })
    const { w, h } = aspectSize(256, '16:9')
    const { files, rgb } = await bake(k, 3, w, h)
    const p = baked(gen({ duration: 0.375, fps: 8 }), 'fx', files, [])
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count, v.w, v.h]).toEqual(['frames', 3, w, h])
    // Save image saves every frame of the batch: the baked RGB, frame for frame.
    const saved = savedFrames(k)
    expect(saved).toHaveLength(3)
    for (const [i, f] of saved.entries()) {
      const got = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', f))))
      expect([got.w, got.h, got.c]).toEqual([w, h, 3])
      expect(Buffer.compare(Buffer.from(got.px), Buffer.from(rgb[i]!)), f).toBe(0)
    }
    // Shaders are free: the frames add nothing to what the run holds and charges (a hosted run's own floor, as the still's).
    const k1 = await setUp({ hosted: true })
    const one = await bake(k1, 1, w, h)
    const r1 = await k1.engine.startRun({ userId: k1.userId, takes: [baked(gen(), 'fx', one.files, [])], ...START })
    await k1.engine.settled(r1.runId)
    expect((await k1.store.get(r1.runId))!.status).toBe('done')
    const credits = (kk: ReturnType<typeof makeKit>) => [...kk.ledger.holds.values()].map(x => [x.credits, x.actual, x.state])
    expect(credits(k)).toEqual(credits(k1))
    expect(k.fal.submitted()).toEqual([])
    expect(k.replicate.submitted()).toEqual([])
  })

  it('an animated shader into Create video → Save video: a clip of its frames is saved', async () => {
    const k = await setUp()
    const { w, h } = aspectSize(256, '16:9')
    const { files } = await bake(k, 4, w, h, 5)
    const p: ApiPrompt = {
      fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', resolution: 256, aspect: '16:9', duration: 0.5, fps: 8 }) },
      c: { class_type: 'CreateVideo', inputs: { images: ['fx', 0], fps: 8 } },
      s: { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
    }
    baked(p, 'fx', files, [])
    expect(runnerTakesWorkflow(p, MEDIA_SHADER)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, JSON.stringify(Object.values(run.takes[0]!.nodes).map(n => n.error))).toBe('done')
    const videos = (readdirSync(join(k.root, 'output'), { recursive: true }) as string[]).filter(f => f.endsWith('.mp4'))
    expect(videos).toHaveLength(1)
  })

  it('over the cap: refused before the hold, in plain words (hosted 301, locally 901), nothing read or held', async () => {
    for (const [hosted, n] of [[true, 301], [false, 901]] as const) {
      const k = await setUp({ hosted })
      const p = baked(gen({ duration: n / 60, fps: 60 }), 'fx', names(n), [])
      const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e as Error & { data?: Record<string, unknown> })
      expect(err).toBeInstanceOf(Error)
      expect((err as { data?: Record<string, unknown> }).data?.code).toBe('too-much-work')
      expect((err as { data?: Record<string, unknown> }).data?.reason, 'never the engine').toBeUndefined()
      expect((err as Error).message).toContain(shaderTooManyFramesWords(hosted ? 300 : 900, false))
      expect(k.ledger.hold).not.toHaveBeenCalled()
    }
  })

  it('a clip\'s frames (Load video frames): baked frame for frame, kept as a batch; a count other than the clip\'s fails plainly at its turn', async () => {
    const k = await setUp()
    copyFileSync(clipPath('g_video_smooth.mp4'), join(k.root, 'input', 'clip.mp4'))
    // What the loader picks: its frames, saved.
    const plain: ApiPrompt = { l: loadFrames('clip.mp4'), s: saveImage(['l', 0]) }
    const r0 = await k.engine.startRun({ userId: k.userId, takes: [plain], ...START })
    await k.engine.settled(r0.runId)
    const picked = savedFrames(k)
    expect(picked.length).toBe(3)
    const first = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', picked[0]!))))
    for (const f of picked) rmSync(join(k.root, 'output', f))

    const { files, rgb } = await bake(k, picked.length, first.w, first.h, 2)
    const p: ApiPrompt = { l: loadFrames('clip.mp4'), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    baked(p, 'fx', files, shaderSourcesOf(p, 'fx')!)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count, v.w, v.h]).toEqual(['frames', 3, first.w, first.h])
    const saved = savedFrames(k)
    for (const [i, f] of saved.entries()) {
      const got = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', f))))
      expect(Buffer.compare(Buffer.from(got.px), Buffer.from(rgb[i]!)), f).toBe(0)
    }
    // Two frames baked for a clip of three: plain words at its turn.
    const short: ApiPrompt = { l: loadFrames('clip.mp4'), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    baked(short, 'fx', files.slice(0, 2), shaderSourcesOf(short, 'fx')!)
    const r2 = await k.engine.startRun({ userId: k.userId, takes: [short], ...START })
    await k.engine.settled(r2.runId)
    expect((await k.store.get(r2.runId))!.takes[0]!.nodes.fx!.error).toBe(SHADER_BAKE_FRAMES)
  })

  it('fix round 1 (I1): a clip of one frame with a duration makes frame_plan\'s frames from it, as Python does (the shared count)', async () => {
    const k = await setUp()
    copyFileSync(clipPath('g_video_smooth.mp4'), join(k.root, 'input', 'clip.mp4'))
    const one = { max_frames: 1 }
    const plain: ApiPrompt = { l: loadFrames('clip.mp4', one), s: saveImage(['l', 0]) }
    const r0 = await k.engine.startRun({ userId: k.userId, takes: [plain], ...START })
    await k.engine.settled(r0.runId)
    const picked = savedFrames(k)
    expect(picked.length).toBe(1)
    const first = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', picked[0]!))))
    for (const f of picked) rmSync(join(k.root, 'output', f))
    // duration 0.125 at 24 fps: round(3) = 3 frames, all from the one frame.
    expect(shaderFrameCount(1, shaderInputs({ duration: 0.125, fps: 24 }))).toBe(3)
    expect(shaderFrameCount(5, shaderInputs({ duration: 0.125, fps: 24 }))).toBe(5)
    const { files } = await bake(k, 3, first.w, first.h, 4)
    const p: ApiPrompt = { l: loadFrames('clip.mp4', one), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs({ duration: 0.125, fps: 24 }) } }, s: saveImage(['fx', 0]) }
    baked(p, 'fx', files, shaderSourcesOf(p, 'fx')!)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count]).toEqual(['frames', 3])
    expect(savedFrames(k)).toHaveLength(3)
  })

  it('fix round 1 (I2): a bake past the batch\'s pixels is refused before the hold with the browser\'s own words (hosted 300 frames of 2048²)', async () => {
    const k = await setUp({ hosted: true })
    const frame0 = await png(pixels(2048, 2048, 3, 1), 2048, 2048, 3)
    put(k.root, bakeNameOf(frame0), frame0)
    const files = [bakeNameOf(frame0), ...names(300).slice(1)]
    const p = baked(gen({ resolution: 2048, aspect: '1:1', duration: 300 / 24, fps: 24 }), 'fx', files, [])
    expect(shaderPlanCount(p.fx!.inputs)).toBe(300)
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e as Error & { data?: Record<string, unknown> })
    expect(err).toBeInstanceOf(Error)
    expect(err.data?.code).toBe('too-much-work')
    expect(err.message).toContain(SHADER_FRAMES_TOO_MUCH)
    expect(shaderBakeProblem(300, 2048, 2048, true, false)).toBe(SHADER_FRAMES_TOO_MUCH)
    expect(err.message).toMatch(new RegExp(`^“[^”]+”: ${SHADER_FRAMES_TOO_MUCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('fix round 1 (I2, I4): a bake in its own folder is claimed by the run that reads it; abandoned or old unclaimed ones are deleted', async () => {
    const k = await setUp()
    const { w, h } = aspectSize(256, '16:9')
    const folder = `shader_bake/${'ab'.repeat(16)}`
    const files: string[] = []
    for (let i = 0; i < 2; i++) {
      const bytes = await png(pixels(w, h, 4, 50 + i), w, h, 4)
      put(k.root, `${folder}/${bakeNameOf(bytes)}`, bytes)
      files.push(`${folder}/${bakeNameOf(bytes)}`)
    }
    expect(bakedFileHash(files[0]!)).not.toBeNull()
    const p = baked(gen({ duration: 0.25, fps: 8 }), 'fx', files, [])
    expect(bakeFoldersOf([p])).toEqual([folder])
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const input = join(k.root, 'input')
    // Fix round 2 (N1): the run ended (done): its claim is let go and the folder deleted.
    expect((await k.store.get(runId))!.bakeFolders).toEqual([folder])
    expect(existsSync(join(input, folder))).toBe(false)
    // A folder claimed by a run still in progress: an abandon keeps it.
    put(k.root, `${folder}/${bakeNameOf(new Uint8Array([2]))}`, new Uint8Array([2]))
    expect(await claimShaderBakes(input, [folder], 'run_live')).toEqual([folder])
    expect(readFileSync(join(input, folder, CLAIMED_MARKER), 'utf8')).toBe('run_live')
    expect(await abandonShaderBake(input, folder, async () => true)).toBe(false)
    // Unclaimed: abandoned only when every frame is the caller's; then gone.
    const other = `shader_bake/${'cd'.repeat(16)}`
    put(k.root, `${other}/${bakeNameOf(new Uint8Array([1]))}`, new Uint8Array([1]))
    expect(await abandonShaderBake(input, other, async () => false)).toBe(false)
    expect(existsSync(join(input, other))).toBe(true)
    expect(await abandonShaderBake(input, other, async () => true)).toBe(true)
    expect(existsSync(join(input, other))).toBe(false)
    // Not a bake folder: nothing.
    expect(bakeFolderOf('../shader_bake/x')).toBeNull()
    expect(await abandonShaderBake(input, '../etc', async () => true)).toBe(false)
    // The sweep: unclaimed folders older than SHADER_BAKE_UNCLAIMED_MS go; young or claimed ones stay.
    const old = `shader_bake/${'ef'.repeat(16)}`
    const young = `shader_bake/${'01'.repeat(16)}`
    put(k.root, `${old}/a.png`, new Uint8Array([1]))
    put(k.root, `${young}/a.png`, new Uint8Array([1]))
    const past = new Date(Date.now() - SHADER_BAKE_UNCLAIMED_MS - 60_000)
    utimesSync(join(input, old, 'a.png'), past, past)
    utimesSync(join(input, old), past, past)
    __resetShaderBakeSweepForTests()
    expect(await sweepShaderBakes(input)).toBe(1)
    expect([existsSync(join(input, old)), existsSync(join(input, young)), existsSync(join(input, folder))]).toEqual([false, true, true])
    // Fix round 2: claims by two runs; one ending keeps the folder for the other; a server start lets go of every
    // claim whose run is no longer in progress (as kept.keepOnly), deleting a folder left unclaimed.
    await claimShaderBakes(input, [folder], 'run_other')
    await releaseShaderBakes(input, [folder], 'run_live')
    expect(readFileSync(join(input, folder, CLAIMED_MARKER), 'utf8')).toBe('run_other')
    expect(await releaseInactiveShaderBakes(input, new Set(['run_other']))).toBe(0)
    expect(existsSync(join(input, folder))).toBe(true)
    expect(await releaseInactiveShaderBakes(input, new Set())).toBe(1)
    expect(existsSync(join(input, folder))).toBe(false)
    // Fix round 2 (N3): a folder holding a file that isn't the run's owner's is not claimed.
    const mixed = `shader_bake/${'23'.repeat(16)}`
    put(k.root, `${mixed}/x.png`, new Uint8Array([1]))
    expect(await claimShaderBakes(input, [mixed], 'run_x', async () => false)).toEqual([])
    expect(existsSync(join(input, mixed, CLAIMED_MARKER))).toBe(false)
  })

  it('fix round 2 (N1): a run paused at a Gate keeps its bake through a server restart (its still re-rendered on restart), and lets it go once it ends', async () => {
    const k = await setUp()
    const { w, h } = aspectSize(256, '16:9')
    const folder = `shader_bake/${'45'.repeat(16)}`
    const bytes = await png(pixels(w, h, 4, 77), w, h, 4)
    put(k.root, `${folder}/${bakeNameOf(bytes)}`, bytes)
    const p: ApiPrompt = {
      fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ effect: 'aurora', resolution: 256, aspect: '16:9' }) },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['fx', 0], bypass: false } },
      s: saveImage(['g', 0]),
    }
    baked(p, 'fx', [`${folder}/${bakeNameOf(bytes)}`], [])
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('paused')
    const input = join(k.root, 'input')
    expect(existsSync(join(input, folder, CLAIMED_MARKER))).toBe(true)
    // A server restart: the paused run is still in progress, so its bake stays.
    const k2 = makeKit({ dir: k.dir, root: k.root, deps: { families: () => MEDIA_SHADER } })
    await k2.engine.reattach()
    expect(existsSync(join(input, folder, CLAIMED_MARKER))).toBe(true)
    // Restart renders the shader again, from its bake.
    await k2.engine.gateAction({ userId: k2.userId, runId, gateId: 'g', action: 'restart' })
    await k2.engine.settled(runId)
    expect((await k2.store.get(runId))!.status).toBe('paused')
    expect(existsSync(join(input, folder))).toBe(true)
    // Continue: the run ends, and its bake goes.
    await k2.engine.gateAction({ userId: k2.userId, runId, gateId: 'g', action: 'continue' })
    await k2.engine.settled(runId)
    const run = (await k2.store.get(runId))!
    expect(run.status, JSON.stringify(Object.values(run.takes[0]!.nodes).map(n => n.error))).toBe('done')
    expect(savedFrames(k2)).toHaveLength(1)
    expect(existsSync(join(input, folder))).toBe(false)
  })

  it('an animated picture (a GIF of two frames on an Image card): two baked frames kept as a batch', async () => {
    const W = 23
    const H = 19
    const k = await setUp()
    const gif = await sharp(pixels(W, H * 2, 3, 9), { raw: { width: W, height: H * 2, channels: 3, pageHeight: H } as never }).gif().toBuffer()
    put(k.root, 'anim.gif', new Uint8Array(gif))
    const { files } = await bake(k, 2, W, H, 3)
    const p: ApiPrompt = { 0: card('anim.gif'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    baked(p, 'fx', files, ['anim.gif'])
    expect(shaderMakesBatch(p, 'fx')).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count]).toEqual(['frames', 2])
  })

  it('the start pass counts the batch in the run\'s kept room (a shader batch is a kept batch of its own)', async () => {
    const p = baked(gen({ duration: 0.25, fps: 8 }), 'fx', names(2), [])
    expect(hasVideoEffect(p, SHADER)).toBe(true)
    expect(hasVideoEffect(baked(gen(), 'fx', names(1), []), SHADER)).toBe(false)
    const shapes = await frameShapes(p, SHADER, async (id, cls) => (cls === 'ShaderEffect' && id === 'fx' ? { count: 2, w: 256, h: 144, exact: true } : null))
    expect(shapes.get('fx:0')).toEqual({ count: 2, w: 256, h: 144, exact: true })
    const peak = keptPeak(p, SHADER, shapes, { release: true })!
    expect(peak.at).toBe('fx')
    expect(peak.bytes).toBeGreaterThanOrEqual(keptBatchBound({ count: 2, w: 256, h: 144, exact: true }))
  })

  // ── Fix round 3 (B1, B2) ──
  const loadImageNode = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
  /** A GIF of `n` frames of w × h, each a different colour (no see-through pixels). */
  async function gifOf(n: number, w: number, h: number): Promise<Uint8Array> {
    const px = new Uint8Array(w * h * n * 3)
    for (let f = 0; f < n; f++) px.fill(40 + f * 50, f * w * h * 3, (f + 1) * w * h * 3)
    const b = new Uint8Array(await sharp(px, { raw: { width: w, height: h * n, channels: 3, pageHeight: h } as never }).gif().toBuffer())
    // sharp marks a transparent index in every frame's control block: cleared, as a GIF with no see-through parts.
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xF9 && b[i + 2] === 4) b[i + 3] = b[i + 3]! & ~1
    return b
  }

  it('fix round 3 (B1): LoadImage of a 4-frame GIF hands on 4 frames and 4 masks (Python\'s batch), and Save image saves all 4', async () => {
    const k = await setUp()
    put(k.root, 'anim4.gif', await gifOf(4, 10, 6))
    const p: ApiPrompt = { l: loadImageNode('anim4.gif'), s: saveImage(['l', 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, JSON.stringify(Object.values(run.takes[0]!.nodes).map(n => n.error))).toBe('done')
    const v = run.takes[0]!.nodes.l!.values!
    expect((v[0] as Extract<RunnerValue, { kind: 'files' }>).files).toHaveLength(4)
    expect((v[1] as Extract<RunnerValue, { kind: 'mask' }>).files).toHaveLength(4)
    const saved = savedFrames(k)
    expect(saved).toHaveLength(4)
    // Each frame its own colour, in order (sharp's decode of the GIF's palette, as PIL's), RGB at the frame's size.
    for (const [i, f] of saved.entries()) {
      const got = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', f))))
      expect([got.w, got.h, got.c, got.px[0]], f).toEqual([10, 6, 3, 40 + i * 50])
    }
    // Python's 64 × 64 zero mask for each frame with no see-through pixels: the same mask, kept once.
    expect(new Set((v[1] as Extract<RunnerValue, { kind: 'mask' }>).files.map(f => f.filename)).size).toBe(1)
  })

  it('fix round 3 (B1): the browser-check repro — LoadImage (4-frame GIF) → Shader wave → Save image — saves 4 frames', async () => {
    const k = await setUp()
    put(k.root, 'r119c_anim.gif', await gifOf(4, 16, 12))
    const { files, rgb } = await bake(k, 4, 16, 12, 9)
    const p: ApiPrompt = { l: loadImageNode('r119c_anim.gif'), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs({ effect: 'wave' }) } }, s: saveImage(['fx', 0]) }
    baked(p, 'fx', files, ['r119c_anim.gif'])
    expect(runnerTakesWorkflow(p, MEDIA_SHADER)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count, v.w, v.h]).toEqual(['frames', 4, 16, 12])
    const saved = savedFrames(k)
    expect(saved).toHaveLength(4)
    for (const [i, f] of saved.entries()) {
      const got = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', f))))
      expect(Buffer.compare(Buffer.from(got.px), Buffer.from(rgb[i]!)), f).toBe(0)
    }
  })

  it('fix round 3 (B1): a LoadImage APNG it can\'t make a batch of, read by the Shader effect, is refused before the hold', async () => {
    const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { rgb_turned: { name: string; file: string }[] }
    const apng = new Uint8Array(Buffer.from(VALUES.rgb_turned.find(c => c.name === 'a two-frame animated PNG')!.file, 'base64'))
    const k = await setUp()
    put(k.root, 'anim.png', apng)
    const p: ApiPrompt = { l: loadImageNode('anim.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
    baked(p, 'fx', names(2), ['anim.png'])
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, message: LOADER_APNG_WORDS })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('fix round 3 (B1): its frames are counted for a reader that takes them, and checked against the batch caps before the hold', async () => {
    const k = await setUp({ hosted: true })
    put(k.root, 'anim4.gif', await gifOf(4, 10, 6))
    const p: ApiPrompt = { l: loadImageNode('anim4.gif'), s: saveImage(['l', 0]) }
    const lf = await loaderFramesOf(p, async f => new Uint8Array(readFileSync(join(k.root, f.type, f.subfolder, f.filename))))
    expect(lf.get('l')).toBe(4)
    expect(pictureBound(p, ['l', 0], MEDIA_SHADER, 0, lf)).toBe(4)
    expect(pictureBound(p, ['l', 0], MEDIA_SHADER)).toBe(1)
    // Past R5's batch caps (hosted 600 frames): plain words, nothing held.
    expect(pictureBatchOverCaps(601, 2, 2, true)).toBe(true)
    expect(pictureBatchOverCaps(600, 2, 2, true)).toBe(false)
    put(k.root, 'long.gif', await gifOf(601, 2, 2))
    const q: ApiPrompt = { l: loadImageNode('long.gif'), s: saveImage(['l', 0]) }
    await expect(k.engine.startRun({ userId: k.userId, takes: [q], ...START })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(LOADER_FRAMES_TOO_MUCH) })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // Face swap takes one picture: a LoadImage's animation is refused before the hold, in its words.
    const fs: ApiPrompt = { l: loadImageNode('anim4.gif'), f: { class_type: 'FaceSwap', inputs: { source_face: ['l', 0], target_frames: ['l', 0] } } }
    expect(cardPictureFiles(fs, new Set(['cards', 'face-swap']))).toContainEqual(expect.objectContaining({ classType: 'LoadImage', oneFrame: true, animated: FACE_SWAP_ONE_PICTURE }))
  })

  it('fix round 3 (B2): an abandoned bake leaves a tombstone; a folder an upload in flight brings back is swept', async () => {
    const k = await setUp()
    const input = join(k.root, 'input')
    const folder = `shader_bake/${'67'.repeat(16)}`
    put(k.root, `${folder}/${bakeNameOf(new Uint8Array([1]))}`, new Uint8Array([1]))
    expect(await abandonShaderBake(input, folder, async () => true)).toBe(true)
    expect(await bakeFolderAbandoned(input, folder)).toBe(true)
    expect(await bakeFolderAbandoned(input, `shader_bake/${'89'.repeat(16)}`)).toBe(false)
    // The upload that was already on its way lands after the abandon: the next sweep deletes the folder.
    put(k.root, `${folder}/${bakeNameOf(new Uint8Array([2]))}`, new Uint8Array([2]))
    __resetShaderBakeSweepForTests()
    expect(await sweepShaderBakes(input)).toBe(1)
    expect(existsSync(join(input, folder))).toBe(false)
  })
})
