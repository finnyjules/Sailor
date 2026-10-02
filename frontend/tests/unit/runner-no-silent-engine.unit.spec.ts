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
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, SWITCHED_CLASSES, runnerRuleFor } from '#shared/runner/eligibility'
import { RETIRED_CLASSES } from '#shared/runner/retired'
import { LOCAL_ONLY_CLASSES, isLocalOnlyClass } from '#shared/runner/localOnly'
import { NOT_TAKEN_NODE_WORDS, switchedOffWords } from '#shared/runner/messages'
import { SHADER_ENGINE_WORDS, SHADER_NEEDS_PICTURE_FIRST, shaderBakedText } from '#shared/runner/shaderBakeKey'
import { RUNNER_OFF_WORDS, WORKFLOW_CANT_RUN_WORDS, engineRoute, localOnlyHostedWords, needsEngineDescription, type EngineRoute } from '~/lib/runner/needsEngine'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, { output?: string[] }>
const outputTypesOf = (ct: string) => CATALOG[ct]?.output
const EVERY: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
type Link = [string, number]

/** Sailor's own classes in the catalogue that the runner doesn't take as a class: refused in words, never the engine. */
const SAILOR_NOT_TAKEN = [
  'PreviewVideo', 'Timeline', 'RenderType', 'KineticType', 'FilmShotNode',
  'FluxProRemoteNode', 'IdeogramV3TurboRemoteNode', 'FluxKontextRemoteNode', 'ClarityUpscaleRemoteNode',
  'Seedance2RemoteNode', 'Veo3RemoteNode', 'KlingVideoRemoteNode',
]

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
  ck: 'Load checkpoint', p: 'Prompt', n: 'Negative', e: 'Empty latent', k: 'KSampler', d: 'VAE decode', s: 'Save', b: 'Soft blur', fx: 'Halftone', r: 'Poster type',
}
const titleOf = (id: string) => TITLES[id] ?? `Node ${id}`
const LOCAL_TITLES = ['Load checkpoint', 'Prompt', 'Negative', 'Empty latent', 'KSampler', 'VAE decode']

const shader = (over: Record<string, unknown>, image: Link = ['0', 0]): ApiPrompt => ({
  0: { class_type: 'Image', inputs: { image: 'src.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
  fx: { class_type: 'ShaderEffect', inputs: { image, effect: 'halftone', params: '{}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 768, aspect: '1:1', ...over } },
  s: saveImage(['fx', 0]),
})

const LOCAL_UP = { runnerOn: true, families: EVERY, hosted: false, engineUp: true, outputTypesOf }
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

describe('engineRoute: a declined Sailor class never goes to the engine', () => {
  it('a Sailor class the runner doesn’t run is refused by its title, even locally with the engine up', () => {
    const p: ApiPrompt = { l: loadImage(), r: { class_type: 'RenderType', inputs: { text: 'Hi' } }, s: saveImage(['l', 0]) }
    expect(route(p)).toEqual({ to: 'refused', title: '“Poster type” can’t run', description: `“Poster type”: ${NOT_TAKEN_NODE_WORDS}` })
  })

  it('one inside a KSampler graph is refused too: only local-only nodes may take a run to the engine', () => {
    const r = route(kSampler({ r: { class_type: 'RenderType', inputs: { text: 'Hi' } } }))
    expect(r.to).toBe('refused')
    expect(r.to === 'refused' && r.title).toBe('“Poster type” can’t run')
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
    const second: ApiPrompt = { l: loadImage(), r: { class_type: 'RenderType', inputs: { text: 'Hi' } }, s: saveImage(['l', 0]) }
    const r = engineRoute([{ prompt: kSampler(), titleOf }, { prompt: second, titleOf }], LOCAL_UP)
    expect(r.to).toBe('refused')
  })

  it('several refused nodes are each named, at most four, then “And N more.”', () => {
    const p: ApiPrompt = { l: loadImage(), s: saveImage(['l', 0]) }
    for (let i = 0; i < 6; i++) p[`r${i}`] = { class_type: 'RenderType', inputs: { text: 'Hi' } }
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
  const madeInRun: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), ...shader({}, ['b', 0]) }
  delete madeInRun[0]
  const cases: [string, ApiPrompt, string][] = [
    ['a My effect or a draft', shader({ effect: 'mine_abc~v1' }), SHADER_ENGINE_WORDS.myEffect],
    ['an effect the runner doesn’t know', shader({ effect: 'no_such_effect' }), SHADER_ENGINE_WORDS.unknownEffect],
    ['params only Python reads', shader({ params: '{"u_amount":"0.5"}' }), SHADER_ENGINE_WORDS.oddParams],
    ['a wired setting', { ...shader({ seed: ['9', 0] }), 9: { class_type: 'PrimitiveInt', inputs: { value: 3 } } }, SHADER_ENGINE_WORDS.wired],
    ['a bake that no longer agrees with its settings', stale, SHADER_ENGINE_WORDS.keyMismatch],
    ['its picture made in the run', madeInRun, SHADER_NEEDS_PICTURE_FIRST],
  ]
  for (const [name, p, words] of cases) {
    it(name, () => {
      expect(route(p)).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${words}` })
      expect(route(p, { hosted: true })).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${words}` })
    })
  }

  it('the words no longer promise the local engine', () => {
    for (const w of Object.values(SHADER_ENGINE_WORDS)) expect(w).not.toMatch(/engine/i)
  })
})

describe('layouts/default.vue: the run route', () => {
  const src = readFileSync(join(process.cwd(), 'app/layouts/default.vue'), 'utf8')
  const start = src.indexOf('async function runVueWorkflow(')
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
    for (const q of ['direct.queueParallel(', 'direct.queueSmart(']) {
      expect(body.indexOf(q), q).toBeGreaterThan(back)
      expect(body.split(q).length, q).toBe(2)
    }
  })

  it('passes hosted, the engine’s state and the runner’s words to the route', () => {
    const call = body.slice(body.indexOf('engineRoute('), body.indexOf("if (route?.to === 'refused') {"))
    expect(call).toContain('hosted: hostedShell')
    expect(call).toContain('engineUp: engineUp.value || direct.isMainSocketOpen()')
    expect(call).toContain('declined: declinedWords')
    expect(call).toContain('outputTypesOf:')
  })

  it('no silent fallback is left: no “runs on the local engine instead”, no engine-there exception for a shader bake', () => {
    expect(src).not.toContain('It will run on the local engine instead.')
    expect(src).not.toContain('engineThere')
    expect(src).not.toMatch(/running on ComfyUI/)
  })
})
