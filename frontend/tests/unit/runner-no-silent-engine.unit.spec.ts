/**
 * Step 3, R10.2: the canvas never falls back silently. A run the runner
 * didn't take (declined, or skipped because the browser knows it won't) goes
 * to the local engine only when this is local, the engine is up, and every
 * node the runner refuses is one of decision 4's local-only classes
 * (shared/runner/localOnly.ts). Otherwise it is refused in plain words,
 * naming each node (shared/runner/needsEngine.ts `engineRoute`).
 *
 * Also the guard over the local-only list (held to the committed catalogue)
 * and over layouts/default.vue's run route: the refusal returns before any
 * /prompt, and no "It will run on the local engine instead" is left.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, type RunnerFamily } from '#shared/runner/families'
import { FILM_SHOT_DIRECTED_MODEL_WORDS, FILM_SHOT_MODEL_WORDS, FILM_SHOT_SOUND_WORDS, RUNNER_NODE_RULES, RUNNER_NODE_TYPES, SWITCHED_CLASSES, runnerRuleFor } from '#shared/runner/eligibility'
import { C4_RETIRED_CLASSES, RETIRED_CLASSES, retiredAdviceOf } from '#shared/runner/retired'
import { LOCAL_ONLY_CLASSES, NEEDS_LOCAL_ENGINE, NEEDS_LOCAL_ENGINE_SHADER_CASES, isLocalOnlyClass } from '#shared/runner/localOnly'
import { NOT_TAKEN_NODE_WORDS, oddSettingWords, switchedOffWords, wiredSettingWords } from '#shared/runner/messages'
import { SHADER_ENGINE_WORDS, SHADER_NEEDS_PICTURE_FIRST, shaderBakedText } from '#shared/runner/shaderBakeKey'
import { CUSTOM_NODE_WORDS, MISSING_OUTPUT_WORDS, RUNNER_OFF_WORDS, WORKFLOW_CANT_RUN_WORDS, blockedRunRefusal, engineRoute, engineRunPrompt, isCustomClass, leftOutNotice, localOnlyHostedWords, needsEngineDescription, type EngineRoute } from '~/lib/runner/needsEngine'
import { NO_OUTPUTS_MESSAGE, NO_VALID_OUTPUTS_MESSAGE, runnerTakesWorkflow } from '#shared/runner/validate'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, { output?: string[]; output_node?: boolean; input?: { required?: Record<string, unknown> } }>
const EVERY: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
type Link = [string, number]

/**
 * Sailor's own classes in the catalogue that the runner doesn't take as a class: refused in words, never the
 * engine. Step 4, C4: Preview video is ported (a rule row), and the other seven of NEEDS_LOCAL_ENGINE's classes
 * retired; Film a shot is taken for its settings (filmShotTaken) and refused by name otherwise.
 */
const SAILOR_NOT_TAKEN = ['Timeline', 'FilmShotNode']

const runnerTakesClass = (ct: string) => RUNNER_NODE_TYPES.has(ct) || !!runnerRuleFor(ct, {}, EVERY) || ct in RUNNER_NODE_RULES || ct in SWITCHED_CLASSES

const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: Link) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const blur = (from: Link) => ({ class_type: 'Blur', inputs: { image: from, type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } })
const loadImage = () => ({ class_type: 'LoadImage', inputs: { image: 'p.png', upload: 'image' } })

/** Stock local diffusion: checkpoint → prompts → KSampler → VAE decode → (Blur →) Save image. */
const kSampler = (tail: ApiPrompt = { s: saveImage(['d', 0]) }): ApiPrompt => ({
  ck: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  p: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['ck', 1] } },
  n: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['ck', 1] } },
  e: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  k: { class_type: 'KSampler', inputs: { model: ['ck', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['e', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['ck', 2] } },
  ...tail,
})
const TITLES: Record<string, string> = {
  ck: 'Load checkpoint', p: 'Prompt', n: 'Negative', e: 'Empty latent', k: 'KSampler', d: 'VAE decode', s: 'Save', b: 'Soft blur', fx: 'Halftone', r: 'Poster type', v: 'Save clip', c: 'My node', lay: 'Layout', u: 'Upscale',
}
const titleOf = (id: string) => TITLES[id] ?? `Node ${id}`
const LOCAL_TITLES = ['Load checkpoint', 'Prompt', 'Negative', 'Empty latent', 'KSampler', 'VAE decode']

const shader = (over: Record<string, unknown>, image: Link = ['0', 0]): ApiPrompt => ({
  0: { class_type: 'Image', inputs: { image: 'src.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
  fx: { class_type: 'ShaderEffect', inputs: { image, effect: 'halftone', params: '{}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 768, aspect: '1:1', ...over } },
  s: saveImage(['fx', 0]),
})

const LOCAL_UP = { runnerOn: true, families: EVERY, hosted: false, engineUp: true, catalog: CATALOG }
const route = (prompt: ApiPrompt, over: Partial<Parameters<typeof engineRoute>[1]> = {}): EngineRoute =>
  engineRoute([{ prompt, titleOf }], { ...LOCAL_UP, ...over })

describe('the local-only set (decision 4) is held to the node catalogue', () => {
  it('every listed class is in the catalogue, not retired, and not one the runner takes', () => {
    expect(LOCAL_ONLY_CLASSES.size).toBe(445)
    for (const ct of LOCAL_ONLY_CLASSES) {
      expect(CATALOG[ct], ct).toBeDefined()
      expect(RETIRED_CLASSES.has(ct), ct).toBe(false)
      expect(runnerTakesClass(ct), ct).toBe(false)
    }
  })

  it('every class the runner doesn’t take is local-only, retired, or named here as Sailor’s own', () => {
    const unclassified = Object.keys(CATALOG).filter(ct => !runnerTakesClass(ct) && !RETIRED_CLASSES.has(ct) && !LOCAL_ONLY_CLASSES.has(ct))
    expect(unclassified.sort()).toEqual([...SAILOR_NOT_TAKEN].sort())
    for (const ct of SAILOR_NOT_TAKEN) expect(isLocalOnlyClass(ct), ct).toBe(false)
  })

  it('the stock diffusion stack is local-only; Sailor’s cards and the stock classes the runner takes are not', () => {
    for (const ct of ['KSampler', 'CheckpointLoaderSimple', 'CLIPTextEncode', 'VAEDecode', 'EmptyLatentImage', 'TrainLoraNode', 'LoraLoader']) expect(isLocalOnlyClass(ct), ct).toBe(true)
    for (const ct of ['SaveImage', 'LoadImage', 'PreviewImage', 'Blur', 'ShaderEffect', 'Image', 'Text', 'GenerateImageNode']) expect(isLocalOnlyClass(ct), ct).toBe(false)
  })
})

describe('engineRoute: a KSampler graph', () => {
  it('goes to the local engine, locally, with the engine up', () => {
    expect(route(kSampler())).toEqual({ to: 'engine' })
  })

  it('a Sailor node it feeds rides along (judged with a stand-in source): Blur after VAE decode', () => {
    expect(route(kSampler({ b: blur(['d', 0]), s: saveImage(['b', 0]) }))).toEqual({ to: 'engine' })
  })

  it('in hosted it never goes, and says the nodes run only on the local engine', () => {
    const r = route(kSampler(), { hosted: true })
    expect(r).toEqual({ to: 'refused', title: 'This workflow can’t run here', description: localOnlyHostedWords(LOCAL_TITLES) })
    expect(localOnlyHostedWords(LOCAL_TITLES)).toBe('“Load checkpoint”, “Prompt”, “Negative”, “Empty latent” and 2 more run only on the local engine, on your own computer.')
    expect(localOnlyHostedWords(['KSampler'])).toBe('“KSampler” runs only on the local engine, on your own computer.')
    expect(route(kSampler(), { hosted: true, engineUp: false }).to).toBe('refused')
  })

  it('locally with the engine off: the old toast, kept for these classes only', () => {
    expect(route(kSampler(), { engineUp: false })).toEqual({ to: 'refused', title: 'This workflow needs the local engine', description: needsEngineDescription(LOCAL_TITLES) })
  })

  it('with the runner off it is judged as the runner would judge it with every family on', () => {
    expect(route(kSampler({ b: blur(['d', 0]), s: saveImage(['b', 0]) }), { runnerOn: false, families: undefined, declined: RUNNER_OFF_WORDS })).toEqual({ to: 'engine' })
  })
})

/** Save video reading a still picture: a Sailor node the runner refuses for its own sake (not on NEEDS_LOCAL_ENGINE). */
const saveVideoOfPicture = (from: Link) => ({ class_type: 'SaveVideo', inputs: { video: from, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })

describe('engineRoute: a declined Sailor class never goes to the engine', () => {
  it('a Sailor node refused for its own sake is refused by its title, even locally with the engine up', () => {
    const p: ApiPrompt = { l: loadImage(), v: saveVideoOfPicture(['l', 0]) }
    expect(route(p)).toEqual({ to: 'refused', title: '“Save clip” can’t run', description: `“Save clip”: ${NOT_TAKEN_NODE_WORDS}` })
  })

  it('one inside a KSampler graph is refused too: only local-only nodes may take a run to the engine', () => {
    const r = route(kSampler({ s: saveImage(['d', 0]), l: loadImage(), v: saveVideoOfPicture(['l', 0]) }))
    expect(r.to).toBe('refused')
    expect(r.to === 'refused' && r.title).toBe('“Save clip” can’t run')
  })

  it('a family that is off is refused with “is switched off right now.” (row 25)', () => {
    const off = new Set<RunnerFamily>([...EVERY].filter(f => f !== 'effects-blur'))
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]) }
    expect(route(p, { families: off })).toEqual({ to: 'refused', title: '“Soft blur” can’t run', description: switchedOffWords('Soft blur') })
  })

  it('nothing refused here but the runner declined: the runner’s own words', () => {
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]) }
    expect(route(p, { declined: '“Soft blur” is switched off right now.' })).toEqual({ to: 'refused', title: 'This workflow can’t run', description: '“Soft blur” is switched off right now.' })
    expect(route(p, { declined: null })).toEqual({ to: 'refused', title: 'This workflow can’t run', description: WORKFLOW_CANT_RUN_WORDS })
    expect(route(p, { runnerOn: false, declined: RUNNER_OFF_WORDS })).toEqual({ to: 'refused', title: 'This workflow can’t run', description: RUNNER_OFF_WORDS })
  })

  it('every take is judged: a Sailor refusal in take 2 refuses the run', () => {
    const second: ApiPrompt = { l: loadImage(), v: saveVideoOfPicture(['l', 0]) }
    const r = engineRoute([{ prompt: kSampler(), titleOf }, { prompt: second, titleOf }], LOCAL_UP)
    expect(r.to).toBe('refused')
  })

  it('several refused nodes are each named, at most four, then “And N more.”', () => {
    const p: ApiPrompt = { l: loadImage() }
    for (let i = 0; i < 6; i++) p[`r${i}`] = saveVideoOfPicture(['l', 0])
    const r = route(p)
    expect(r).toMatchObject({ to: 'refused', title: '6 nodes can’t run' })
    expect(r.to === 'refused' && r.description).toBe(
      [0, 1, 2, 3].map(i => `“Node r${i}”: ${NOT_TAKEN_NODE_WORDS}`).join(' ') + ' And 2 more.',
    )
  })
})

describe('R10.2 closes the Shader effect’s engine cases: each is a plain refusal, locally with the engine up', () => {
  const stale = shader({})
  stale.fx!.inputs.sailor_baked = shaderBakedText([`shader_bake_${'0'.repeat(32)}.png`], 'f'.repeat(64))
  const cases: [string, ApiPrompt, string][] = [
    ['an effect the runner doesn’t know', shader({ effect: 'no_such_effect' }), SHADER_ENGINE_WORDS.unknownEffect],
    ['params only Python reads', shader({ params: '{"u_amount":"0.5"}' }), SHADER_ENGINE_WORDS.oddParams],
    ['a wired setting', { ...shader({ seed: ['9', 0] }), 9: { class_type: 'PrimitiveInt', inputs: { value: 3 } } }, SHADER_ENGINE_WORDS.wired],
    ['a bake that no longer agrees with its settings', stale, SHADER_ENGINE_WORDS.keyMismatch],
  ]
  for (const [name, p, words] of cases) {
    it(name, () => {
      expect(route(p)).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${words}` })
      expect(route(p, { hosted: true })).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${words}` })
    })
  }

  it('a Shader effect with no picture whose effect needs one never ran anywhere: refused with its words', () => {
    const p: ApiPrompt = shader({})
    delete p[0]
    delete p.fx!.inputs.image
    expect(route(p)).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_ENGINE_WORDS.needsPicture}` })
  })

  it('the words no longer promise the local engine, but for your own effects (fix round 1 (c))', () => {
    for (const [k, w] of Object.entries(SHADER_ENGINE_WORDS)) if (k !== 'myEffect') expect(w, k).not.toMatch(/engine/i)
  })
})

describe('step 4, C4: no Sailor class needs the local engine any more; each is ported or retired', () => {
  it('both explicit lists are empty, and every Sailor class the runner doesn’t take as a class is the Timeline (editor-only) or Film a shot', () => {
    expect(NEEDS_LOCAL_ENGINE).toEqual({})
    expect(NEEDS_LOCAL_ENGINE_SHADER_CASES).toEqual({})
    for (const ct of SAILOR_NOT_TAKEN) expect(isLocalOnlyClass(ct), ct).toBe(false)
    // Preview video is the runner's now (a rule row); the retired ones are retired.
    expect(runnerTakesClass('PreviewVideo')).toBe(true)
    for (const ct of ['RenderType', 'KineticType', 'FluxProRemoteNode', 'IdeogramV3TurboRemoteNode', 'FluxKontextRemoteNode', 'ClarityUpscaleRemoteNode', 'Seedance2RemoteNode', 'Veo3RemoteNode', 'KlingVideoRemoteNode']) {
      expect(RETIRED_CLASSES.has(ct), ct).toBe(true)
      expect(isCustomClass(ct), ct).toBe(false)
    }
    // Neither Film a shot nor the Text card is taken for a custom node.
    for (const ct of ['FilmShotNode', 'Text', 'PreviewVideo']) expect(isCustomClass(ct), ct).toBe(false)
  })

  const renderType: ApiPrompt = { r: { class_type: 'RenderType', inputs: { params: '{}' } }, rs: saveImage(['r', 0]) }
  it('a retired one is refused before anything is sent, naming its replacement, locally with the engine up as in hosted', () => {
    expect(blockedRunRefusal([{ prompt: renderType, titleOf }], { runnerOn: true, families: EVERY })).toEqual({ title: '“Poster type” was retired', description: 'Use Vector Type instead.' })
    expect(blockedRunRefusal([{ prompt: kSampler({ s: saveImage(['d', 0]), ...renderType }), titleOf }], { runnerOn: true, families: EVERY })).toMatchObject({ title: '“Poster type” was retired' })
    // Were the browser's check skipped, the route still never sends it to the engine.
    for (const o of [{}, { hosted: true }, { engineUp: false }]) expect(route(renderType, o).to).toBe('refused')
  })
  it('LC9: a Smart Layout read by an Image card (28 saved graphs) is off the list: the runner takes it', () => {
    expect(NEEDS_LOCAL_ENGINE.SmartLayout).toBeUndefined()
    const card = (from: Link) => ({ class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true, batch_index: -1, images: from } })
    const p: ApiPrompt = { lay: { class_type: 'SmartLayout', inputs: { layout: '', aspects: '300x250,320x50', brand_kit: '' } }, i: card(['lay', 0]) }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    // The Image card hands the list on: what reads it is held to Save image, Preview image and another Image card.
    expect(runnerTakesWorkflow({ ...p, j: card(['i', 0]), s: saveImage(['j', 0]) }, EVERY)).toBe(true)
    expect(runnerTakesWorkflow({ ...p, b: blur(['i', 0]), s: saveImage(['b', 0]) }, EVERY)).toBe(false)
  })
  it('a node with a plainer reason is refused, not sent: a switched-off family stays refused', () => {
    const off = new Set<RunnerFamily>([...EVERY].filter(f => f !== 'effects-blur'))
    expect(route({ l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]) }, { families: off }).to).toBe('refused')
  })
})

describe('step 4, C4: a Film a shot the runner doesn’t film is refused by name, saying what to pick', () => {
  const shot = (over: Record<string, unknown> = {}): ApiPrompt => ({
    f: { class_type: 'FilmShotNode', inputs: { preset: 'push-in', prompt: 'a fox in snow', model: 'kling-v3', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}', shot_size: 'auto (preset)', camera_angle: 'auto (preset)', camera_movement: 'auto (preset)', lens_look: 'auto (preset)', composition: 'auto (preset)', ...over } },
    v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['f', 0] } },
  })
  const SHOT_TITLES: Record<string, string> = { f: 'Fox shot', t: 'Words' }
  const shotRoute = (p: ApiPrompt, o: Partial<Parameters<typeof engineRoute>[1]> = {}) =>
    engineRoute([{ prompt: p, titleOf: id => SHOT_TITLES[id] ?? id }], { ...LOCAL_UP, ...o })
  const refusedWith = (words: string) => ({ to: 'refused', title: '“Fox shot” can’t run', description: `“Fox shot”: ${words}` })
  const directed = (model: string) => JSON.stringify({ __shot_directed: true, model })

  it('the runner takes a preset shot on every model Python lists, and a Shot Director shot on its four', () => {
    expect(runnerTakesWorkflow(shot(), EVERY)).toBe(true)
    expect(runnerTakesWorkflow(shot({ model: 'hailuo-h3-max' }), EVERY)).toBe(true)
    for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast', 'kling-v3']) expect(runnerTakesWorkflow(shot({ model, model_options: directed(model) }), EVERY), model).toBe(true)
  })
  it('a Shot Director shot on another model: names the four to pick, everywhere, never the engine', () => {
    const p = shot({ model: 'hailuo-h3-max', model_options: directed('hailuo-h3-max') })
    for (const o of [{}, { hosted: true }, { engineUp: false }]) expect(shotRoute(p, o)).toEqual(refusedWith(FILM_SHOT_DIRECTED_MODEL_WORDS))
    expect(FILM_SHOT_DIRECTED_MODEL_WORDS).toBe('Shot Director films only with Seedance 2.0, Veo 3.1, Veo 3.1 Fast or Kling Video 3.0. Pick one of those for this shot.')
  })
  it('a model Python no longer lists: pick another', () => {
    expect(shotRoute(shot({ model: 'Kling 2.1' }))).toEqual(refusedWith(FILM_SHOT_MODEL_WORDS))
  })
  it('a wired setting or sound, a setting that can’t be read: named', () => {
    const words: ApiPrompt = { t: { class_type: 'PrimitiveString', inputs: { value: 'a fox' } } }
    expect(shotRoute({ ...shot({ prompt: ['t', 0] }), ...words })).toEqual(refusedWith(wiredSettingWords('Prompt')))
    expect(shotRoute({ ...shot({ model_options: directed('kling-v3'), prompt: ['t', 0] }), ...words })).toEqual(refusedWith(wiredSettingWords('Prompt')))
    expect(shotRoute({ ...shot({ audio: ['t', 0] }), ...words })).toEqual(refusedWith(FILM_SHOT_SOUND_WORDS))
    expect(shotRoute(shot({ preset: 'no-such-shot' }))).toEqual(refusedWith(oddSettingWords('Preset')))
    expect(shotRoute(shot({ shot_size: 'very big' }))).toEqual(refusedWith(oddSettingWords('Shot size')))
    expect(shotRoute(shot({ model_options: '{"__shot_directed": 1}' }))).toEqual(refusedWith(oddSettingWords('Model options')))
  })
  it('its family off: switched off, by name', () => {
    const off = new Set<RunnerFamily>([...EVERY].filter(f => f !== 'film-shot'))
    // A reason that names its node already stands as it is.
    expect(shotRoute(shot(), { families: off })).toEqual({ to: 'refused', title: '“Fox shot” can’t run', description: switchedOffWords('Fox shot') })
  })
})

describe('step 4, C4: a Text card wired to a LoRA node’s old log output', () => {
  const lora = { class_type: 'FluxLoRARemoteNode', inputs: { prompt: 'a fox', lora_name: 'fox.safetensors', lora_url: '', lora_scale: 1, aspect_ratio: '1:1', megapixels: '1', num_inference_steps: 28, guidance: 3, seed: 0, prompt_strength: 0.8 } }
  const card = { class_type: 'Image', inputs: { image: '', export: false, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true, batch_index: -1, images: ['m', 0] } }
  const p: ApiPrompt = { m: lora, mi: card, t: { class_type: 'Text', inputs: { text: 'mode: text-to-image', source: ['m', 1] } } }
  it('is dropped as ComfyUI drops it (no such output), the rest handed to the runner; the card keeps its saved text', () => {
    expect(CATALOG.FluxLoRARemoteNode!.output).toEqual(['IMAGE'])
    expect(runnerTakesWorkflow(p, EVERY)).toBe(false)
    const pruned = engineRunPrompt(p, CATALOG)!
    expect(Object.keys(pruned).sort()).toEqual(['m', 'mi'])
    expect(runnerTakesWorkflow(pruned, EVERY)).toBe(true)
    expect(leftOutNotice([{ prompt: p, pruned, titleOf: () => 'LoRA log' }])).toMatchObject({ title: 'Some nodes were left out' })
  })
  it('judged on its own (the rest refused too), it is named in plain words, never sent to the engine', () => {
    for (const o of [{}, { hosted: true }, { engineUp: false }]) {
      expect(route(p, o)).toEqual({ to: 'refused', title: '“Node t” can’t run', description: `“Node t”: ${MISSING_OUTPUT_WORDS}` })
    }
  })
})

describe('fix round 3 (I-1): a class the committed catalogue doesn’t hold is a custom node: local engine, named', () => {
  const custom: ApiPrompt = { l: loadImage(), c: { class_type: 'MyCustomUpscaler', inputs: { image: ['l', 0] } } }
  /** The live /object_info with ComfyUI up: it lists every installed custom node. */
  const LIVE = { ...CATALOG, MyCustomUpscaler: { input: { required: { image: ['IMAGE', {}] } }, output: ['IMAGE'], output_node: true } }
  const named = { to: 'engine', notice: { title: 'This workflow needs the local engine', description: needsEngineDescription(['My node']) } }

  it('every class of the committed catalogue is Sailor’s or stock: none counts as custom', () => {
    for (const ct of Object.keys(CATALOG)) expect(isCustomClass(ct), ct).toBe(false)
    expect(isCustomClass('MyCustomUpscaler')).toBe(true)
  })
  it('engine up: it goes there, named, whether the live catalogue lists it (installed) or not', () => {
    expect(route(custom, { catalog: LIVE })).toEqual(named)
    expect(route(custom)).toEqual(named)
    expect(route(custom, { catalog: undefined })).toEqual(named)
  })
  it('engine down (the saved catalogue, or none loaded yet): the needs-the-engine toast naming it', () => {
    for (const catalog of [CATALOG, {}, undefined]) {
      expect(route(custom, { engineUp: false, catalog })).toEqual({ to: 'refused', title: 'This workflow needs the local engine', description: needsEngineDescription(['My node']) })
    }
  })
  it('hosted refuses it in plain words, naming it', () => {
    expect(route(custom, { hosted: true, catalog: LIVE })).toEqual({ to: 'refused', title: 'This workflow can’t run here', description: `“My node”: ${CUSTOM_NODE_WORDS}` })
  })
  it('a Sailor class missing from the live catalogue (empty until it loads) is never sent: C4\'s classes are refused', () => {
    for (const catalog of [{}, undefined]) {
      for (const ct of ['RenderType', 'PreviewVideo', 'KineticType', 'FluxProRemoteNode', 'FilmShotNode']) {
        const p: ApiPrompt = { r: { class_type: ct, inputs: {} }, rs: saveImage(['r', 0]) }
        expect(route(p, { catalog }).to, ct).toBe('refused')
      }
    }
    for (const ct of C4_RETIRED_CLASSES) expect(retiredAdviceOf(ct), ct).toMatch(/^Use .+ instead\.$/)
  })
})

describe('fix round 3: the review’s minors', () => {
  it('M-1: an autogrow input (images.image0…) is not a missing wire', () => {
    const p: ApiPrompt = {
      a: loadImage(), b: loadImage(),
      g: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['a', 0], 'images.image1': ['b', 0] } },
      s: saveImage(['g', 0]),
    }
    expect(engineRunPrompt(p, CATALOG)).toBe(p)
  })
  it('M-2: a pruned run names what it left out', () => {
    // LC8 round 2: a local-only node (VAE decode) is never left out, so the example is a Sailor result with nothing wired in.
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]), b2: { class_type: 'Blur', inputs: { type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } }, s2: saveImage(['b2', 0]) }
    const pruned = engineRunPrompt(p, CATALOG)
    const t = (id: string) => ({ b2: 'Decode', s2: 'Show any' } as Record<string, string>)[id] ?? id
    expect(leftOutNotice([{ prompt: p, pruned, titleOf: t }])).toEqual({ title: 'Some nodes were left out', description: '“Decode” and “Show any” won’t run: something they need isn’t wired in.' })
    expect(leftOutNotice([{ prompt: p, pruned: p, titleOf: t }])).toBeNull()
  })
  it('M-3: an unbaked Shader effect with nothing wrong rides along in a run bound for the local engine', () => {
    const p: ApiPrompt = { ...kSampler(), ...shader({}) }
    p.s2 = saveImage(['d', 0])
    expect(route(p)).toEqual({ to: 'engine' })
    // Alone it is not sent: nothing else needs the engine.
    expect(route(shader({})).to).toBe('refused')
  })
})

describe('LC13: a Shader effect showing one of your own effects is the runner\'s; never the local engine', () => {
  // Not drawn for this run (the browser draws only a run the runner takes): the local engine can't run it
  // (Python's node knows only the catalogue), so it is refused plainly everywhere, never sent there.
  const mine = shader({ effect: 'mine_abcdefghijkl~v1' })
  it('locally with the engine up: refused with its words, not sent to the engine', () => {
    expect(route(mine)).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_ENGINE_WORDS.myEffect}` })
  })
  it('hosted, or the engine off: the same words', () => {
    expect(route(mine, { hosted: true })).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_ENGINE_WORDS.myEffect}` })
    expect(route(mine, { engineUp: false })).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_ENGINE_WORDS.myEffect}` })
  })
  it('even riding with a node the local engine runs: refused, not sent (the M-3 ride-along is for catalogue effects)', () => {
    const p: ApiPrompt = { ...kSampler(), ...mine }
    p.s2 = saveImage(['d', 0])
    expect(route(p).to).toBe('refused')
  })
})

describe('step 4, C4: a Shader effect whose picture is made in the same run is refused plainly everywhere', () => {
  // The saved graph's shape: a picture → bloom → vignette (vignette's picture is made in the run).
  const chain: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), ...shader({}, ['b', 0]) }
  delete chain[0]
  it('is no longer on any list', () => {
    expect(NEEDS_LOCAL_ENGINE_SHADER_CASES).toEqual({})
  })
  it('locally with the engine up, in hosted and with the engine off: its words, never the engine', () => {
    for (const o of [{}, { hosted: true }, { engineUp: false }]) {
      expect(route(chain, o)).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_NEEDS_PICTURE_FIRST}` })
    }
  })
})

describe('fix round 1: what ComfyUI would drop doesn’t decide the route', () => {
  it('an output ComfyUI drops no longer keeps a runner graph off the runner', () => {
    // A Save image reading a Blur with nothing wired in: ComfyUI drops both and runs the rest.
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]), b2: { class_type: 'Blur', inputs: { type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } }, s2: saveImage(['b2', 0]) }
    // (Every class here is the runner's, so it prunes this itself too.)
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    const pruned = engineRunPrompt(p, CATALOG)!
    expect(Object.keys(pruned).sort()).toEqual(['b', 'l', 's'])
    expect(runnerTakesWorkflow(pruned, EVERY)).toBe(true)
  })
  it('LC8 round 2 (ruling): a local-only node is never left out: its presence routes the whole run the R10.2 way', () => {
    // A Preview any reading a VAE decode with nothing wired in, beside a runnable chain: no runner hand-off.
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]), d: { class_type: 'VAEDecode', inputs: {} }, pa: { class_type: 'PreviewAny', inputs: { source: ['d', 0] } } }
    expect(engineRunPrompt(p, CATALOG)).toBeNull()
    expect(route(p).to).toBe('engine')
    expect(route(p, { engineUp: false })).toMatchObject({ to: 'refused', title: 'This workflow needs the local engine' })
    expect(route(p, { hosted: true })).toMatchObject({ to: 'refused', title: 'This workflow can’t run here' })
  })
  it('a KSampler graph with nothing to show, or whose every result fails: LC8 round 2, its local-only nodes route it (the engine judges it)', () => {
    const { s: _s, ...noOutput } = kSampler()
    expect(route(noOutput)).toEqual({ to: 'engine' })
    expect(route(kSampler({ s: { class_type: 'SaveImage', inputs: { ...SAVE_DEFAULTS } } }))).toEqual({ to: 'engine' })
    expect(route(noOutput, { engineUp: false })).toMatchObject({ to: 'refused', title: 'This workflow needs the local engine' })
    // With no local-only node, the plain refusals stand.
    expect(route({ s: { class_type: 'SaveImage', inputs: { ...SAVE_DEFAULTS } } })).toEqual({ to: 'refused', title: 'This workflow can’t run', description: `${NO_VALID_OUTPUTS_MESSAGE}.` })
    expect(route({ l: loadImage() })).toEqual({ to: 'refused', title: 'This workflow can’t run', description: NO_OUTPUTS_MESSAGE })
  })
})

describe('layouts/default.vue: the run route', () => {
  const src = readFileSync(join(process.cwd(), 'app/layouts/default.vue'), 'utf8')
  const start = src.indexOf('async function runVueWorkflowBody(') // LC8 (B5): runVueWorkflow wraps this body
  const body = src.slice(start, src.indexOf('\n}\n', start))

  it('refuses before any /prompt unless the engine route says so', () => {
    const declined = body.indexOf('if (!isRunnerDeclined(err)) throw err')
    const routed = body.indexOf('engineRoute(')
    const refuse = body.indexOf("if (route?.to === 'refused') {")
    const back = body.indexOf('return false', refuse)
    expect(declined).toBeGreaterThan(0)
    expect(routed).toBeGreaterThan(declined)
    expect(body.slice(routed - 40, routed)).toContain('sentToRunner ? null :')
    expect(refuse).toBeGreaterThan(routed)
    expect(body.slice(refuse, back)).toContain('toast.error(route.title, { description: route.description })')
    // R10.3: the local engine's two /prompt calls (one take, several takes in order) come after the refusal.
    const queues = [...body.matchAll(/direct\.queue\(/g)].map(m => m.index!)
    expect(queues).toHaveLength(2)
    for (const q of queues) expect(q).toBeGreaterThan(back)
    expect(body).not.toMatch(/direct\.queue(Parallel|Smart)\(/)
  })

  it('passes hosted, the engine’s state and the runner’s words to the route', () => {
    const call = body.slice(body.indexOf('engineRoute('), body.indexOf("if (route?.to === 'refused') {"))
    expect(call).toContain('hosted: hostedShell')
    expect(call).toContain('engineUp: engineUp.value || direct.isMainSocketOpen()')
    expect(call).toContain('declined: declinedWords')
    expect(call).toContain('catalog: objectInfo.value')
    // Fix round 1: the named local-engine toast, and the pruned prompts for the runner.
    expect(body).toContain("if (route?.to === 'engine' && route.notice) toast.info(route.notice.title, { description: route.notice.description })")
    expect(body).toContain('engineRunPrompt(p, objectInfo.value)')
  })

  it('no silent fallback is left: no “runs on the local engine instead”, no engine-there exception for a shader bake', () => {
    expect(src).not.toContain('It will run on the local engine instead.')
    expect(src).not.toContain('engineThere')
    expect(src).not.toMatch(/running on ComfyUI/)
  })
})
