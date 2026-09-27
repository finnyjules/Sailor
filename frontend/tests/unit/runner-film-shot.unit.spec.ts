/**
 * Task 4 (characters stage 3): the runner takes a shot-directed "Film a shot"
 * (FilmShotNode with `__shot_directed` in its options) on Seedance 2.0, Veo 3.1
 * and Veo 3.1 Fast, and on Kling 3 with the replicate-video family on. Its
 * `/view?…&type=input` reference links become provider links (shotRefs.ts),
 * and it is planned exactly like "Generate a video".
 */
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { VIEW_REF_REFUSED } from '#shared/pricing/clipSettings'
import { PROVIDER_TYPES, isRunnerEligible, isShotDirected, runnerTakesNode } from '#shared/runner/eligibility'
import { planNode } from '~~/server/runner/executors'
import { resolveShotRefs, shotRefFilenames, shotRefProblem } from '~~/server/runner/shotRefs'
import { ELEMENTS_ONLY_KLING_WORDS, KLING_ELEMENTS_COMFY_WORDS, SEEDANCE_TOO_MUCH_VIDEO, SEEDANCE_UNMEASURED_REFERENCE, requestProblems } from '~~/server/runner/requestRules'
import { runnerReferenceProblems, seedanceReferenceSeconds } from '~~/server/utils/graphInputSeconds'
import { VEO_31_ONE_PICTURE, VEO_31_REFS_WORDS } from '~~/server/runner/generators/video'
import { KLING_ELEMENTS_NEED_FRAME } from '~~/server/runner/generators/twins'
import { nodeCredits } from '~~/server/runner/metering'
import { extractFileRefs, GRAPH_FILE_READERS } from '~~/server/utils/engineFileSurface'
import type { OutputFile } from '~~/server/runner/types'

const view = (n: string) => `/view?filename=${n}&type=input`
const REPLICATE_VIDEO = new Set<RunnerFamily>(['replicate-video'])

function shot(model: string, opts: Record<string, unknown> = {}, o: { directed?: boolean, image?: boolean } = {}) {
  const inputs: Record<string, unknown> = {
    preset: 'slow_push_in', prompt: 'Reva walks through the rain', model, aspect_ratio: '16:9', duration: '5', seed: 0,
    model_options: JSON.stringify({ ...(o.directed === false ? {} : { __shot_directed: true }), ...opts }),
  }
  if (o.image) inputs.image = ['9', 0]
  return { class_type: 'FilmShotNode', inputs }
}

function video(model: string, opts: Record<string, unknown> = {}, image = false) {
  const inputs: Record<string, unknown> = {
    model, prompt: 'Reva walks through the rain', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: JSON.stringify(opts),
  }
  if (image) inputs.image = ['9', 0]
  return { class_type: 'GenerateVideoNode', inputs }
}

const toUrl = async (f: OutputFile) => `https://fal/${f.filename}`

function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'f.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'f.png', subfolder: '', type: 'input' }],
    toUrl,
    gateOpen: false,
  })
}

describe('runnerTakesNode: a shot-directed Film a shot', () => {
  it('takes one on Seedance 2.0, Veo 3.1 and Veo 3.1 Fast, with no family', () => {
    for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast']) {
      const p: ApiPrompt = { n: shot(model) }
      expect(runnerTakesNode(p, 'n'), model).toBe(true)
      expect(isRunnerEligible(p), model).toBe(true)
    }
  })
  it('does not take one without __shot_directed, with linked options, linked sound or another model', () => {
    expect(runnerTakesNode({ n: shot('seedance-2.0', {}, { directed: false }) }, 'n')).toBe(false)
    const linked = shot('seedance-2.0')
    linked.inputs.model_options = ['7', 0]
    expect(runnerTakesNode({ 7: { class_type: 'Image', inputs: {} }, n: linked }, 'n')).toBe(false)
    const sound = shot('seedance-2.0')
    sound.inputs.audio = ['7', 0]
    expect(runnerTakesNode({ 7: { class_type: 'Image', inputs: {} }, n: sound }, 'n')).toBe(false)
    expect(runnerTakesNode({ n: shot('veo-3.1-lite') }, 'n', REPLICATE_VIDEO)).toBe(false)
    expect(runnerTakesNode({ n: shot('kling-v2.5-turbo-pro') }, 'n', REPLICATE_VIDEO)).toBe(false)
  })
  it('takes Kling 3 only with the replicate-video family on', () => {
    expect(runnerTakesNode({ n: shot('kling-v3') }, 'n')).toBe(false)
    expect(runnerTakesNode({ n: shot('kling-v3') }, 'n', REPLICATE_VIDEO)).toBe(true)
  })
  it('isShotDirected reads the options safely', () => {
    expect(isShotDirected({ model_options: '{"__shot_directed":true}' })).toBe(true)
    expect(isShotDirected({ model_options: '{"__shot_directed":"true"}' })).toBe(false)
    expect(isShotDirected({ model_options: 'not json' })).toBe(false)
    expect(isShotDirected({ model_options: ['7', 0] })).toBe(false)
    expect(isShotDirected({})).toBe(false)
  })
  it('Film a shot makes a provider call, so it is held and charged', () => {
    expect(PROVIDER_TYPES.has('FilmShotNode')).toBe(true)
    for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast', 'kling-v3']) {
      expect(nodeCredits(shot(model), undefined, REPLICATE_VIDEO), model).toBeGreaterThan(0)
    }
  })
})

describe('resolveShotRefs and shotRefFilenames', () => {
  const adv = {
    __shot_directed: true,
    image_url: view('first.png'),
    end_image_url: view('last.png'),
    image_urls: [view('a.png'), 'https://x/y.png'],
    video_urls: [view('v.mp4')],
    audio_urls: [view('s.mp3')],
    elements: [{ frontal_image_url: view('face.png'), reference_image_urls: [view('body.png'), view('a.png')] }],
    resolution: '720p',
  }

  it('turns every /view link into a provider link, moves image_url to the first frame, drops the marker', async () => {
    const r = await resolveShotRefs(adv, toUrl)
    expect(r.firstFrame).toBe('https://fal/first.png')
    expect(r.adv).toEqual({
      end_image_url: 'https://fal/last.png',
      image_urls: ['https://fal/a.png', 'https://x/y.png'],
      video_urls: ['https://fal/v.mp4'],
      audio_urls: ['https://fal/s.mp3'],
      elements: [{ frontal_image_url: 'https://fal/face.png', reference_image_urls: ['https://fal/body.png', 'https://fal/a.png'] }],
      resolution: '720p',
    })
  })
  it('no image_url: no first frame', async () => {
    const r = await resolveShotRefs({ __shot_directed: true, image_urls: [view('a.png')] }, toUrl)
    expect(r.firstFrame).toBeNull()
    expect(r.adv).toEqual({ image_urls: ['https://fal/a.png'] })
  })
  it('a refused link throws its words; one that names no safe file cannot be read', async () => {
    await expect(resolveShotRefs({ image_urls: ['/view?filename=a.png&filename=b.png&type=input'] }, toUrl)).rejects.toThrow(VIEW_REF_REFUSED)
    await expect(resolveShotRefs({ image_urls: ['/view?filename=../x&type=input'] }, toUrl)).rejects.toThrow('A reference picture could not be read.')
    await expect(resolveShotRefs({ image_url: 'data:image/png;base64,AAAA' }, toUrl)).rejects.toThrow('A reference picture could not be read.')
  })
  it('lists every /view filename once, elements included', () => {
    expect(shotRefFilenames(adv).sort()).toEqual(['a.png', 'body.png', 'face.png', 'first.png', 'last.png', 's.mp3', 'v.mp4'])
  })
})

describe('planning a shot-directed Film a shot', () => {
  it('Veo 3.1 with 2 pictures goes to reference-to-video with resolved links, no marker', async () => {
    const p = await plan(shot('veo-3.1', { image_urls: [view('a.png'), view('b.png')] }))
    if (p.kind !== 'provider') throw new Error('not a provider plan')
    expect(p.endpoint).toBe('fal-ai/veo3.1/reference-to-video')
    expect(p.payload.image_urls).toEqual(['https://fal/a.png', 'https://fal/b.png'])
    expect(p.payload).not.toHaveProperty('__shot_directed')
    expect(JSON.stringify(p.payload)).not.toContain('/view')
  })
  it('Seedance 2.0: the same request as the equivalent Generate a video', async () => {
    const a = await plan(shot('seedance-2.0', { image_urls: [view('a.png'), view('b.png')], resolution: '720p' }))
    const b = await plan(video('seedance-2.0', { image_urls: ['https://fal/a.png', 'https://fal/b.png'], resolution: '720p' }))
    if (a.kind !== 'provider' || b.kind !== 'provider') throw new Error('not a provider plan')
    expect(a.endpoint).toBe(b.endpoint)
    expect(a.payload).toEqual(b.payload)
    expect(a.backup).toEqual(b.backup)
  })
  it('Seedance 2.0: image_url is the first frame, as a linked picture is on Generate a video', async () => {
    const a = await plan(shot('seedance-2.0', { image_url: view('f.png') }))
    const b = await plan(video('seedance-2.0', {}, true))
    if (a.kind !== 'provider' || b.kind !== 'provider') throw new Error('not a provider plan')
    expect(a.endpoint).toBe(b.endpoint)
    expect(a.payload).toEqual(b.payload)
  })
  it('a linked picture wins over image_url', async () => {
    const p = await plan(shot('seedance-2.0', { image_url: view('other.png') }, { image: true }))
    if (p.kind !== 'provider') throw new Error('not a provider plan')
    expect(JSON.stringify(p.payload)).toContain('https://fal/f.png')
    expect(JSON.stringify(p.payload)).not.toContain('other.png')
  })
  it('Kling 3: elements resolved, the start frame from image_url, no Replicate backup', async () => {
    const p = await plan(shot('kling-v3', {
      image_url: view('start.png'),
      elements: [{ frontal_image_url: view('face.png'), reference_image_urls: [view('body.png')] }],
    }))
    if (p.kind !== 'provider') throw new Error('not a provider plan')
    expect(p.provider).toBe('fal')
    expect(p.payload.elements).toEqual([{ frontal_image_url: 'https://fal/face.png', reference_image_urls: ['https://fal/body.png'] }])
    expect(JSON.stringify(p.payload)).toContain('https://fal/start.png')
    expect(p.backup).toBeUndefined()
  })
  it('shows nothing on itself, as Generate a video', async () => {
    const p = await plan(shot('veo-3.1'))
    if (p.kind !== 'provider') throw new Error('not a provider plan')
    const f: OutputFile = { filename: 'film_shot_00001_.mp4', subfolder: '', type: 'output' }
    // Python's FilmShotNode is not an output node: the take lands on the Video card after it (Ruling C).
    expect(p.uiFor([f])).toBeNull()
  })
  it('a linked picture that brought no file fails the node, never falls back to image_url', async () => {
    const node = shot('seedance-2.0', { image_url: view('other.png') }, { image: true })
    await expect(planNode({
      prompt: { 9: { class_type: 'Image', inputs: { image: 'f.png' } }, n: node },
      nodeId: 'n', filesFrom: () => [], toUrl, gateOpen: false,
    })).rejects.toThrow('There is no picture for the first frame')
  })
  it('a refused link fails the node before anything is sent', async () => {
    await expect(plan(shot('veo-3.1', { image_urls: ['/view?filename=a.png&filename=b.png&type=input'] }))).rejects.toThrow(VIEW_REF_REFUSED)
  })
})

describe('requestProblems for Film a shot', () => {
  const el = { frontal_image_url: view('face.png'), reference_image_urls: [] }
  it('the ComfyUI path refuses elements, on Film a shot and Generate a video', () => {
    expect(requestProblems({ n: shot('kling-v3', { image_url: view('s.png'), elements: [el] }) })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: KLING_ELEMENTS_COMFY_WORDS },
    ])
    expect(requestProblems({ n: video('kling-v3', { elements: [el] }, true) })).toEqual([
      { nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: KLING_ELEMENTS_COMFY_WORDS },
    ])
    expect(requestProblems({ n: shot('kling-v3', { elements: [] }) })).toEqual([])
    expect(KLING_ELEMENTS_COMFY_WORDS).toBe('Kling 3 films characters only through Sailor\'s runner, and this shot can\'t go there. Pick Seedance or Veo, or switch Kling on.')
  })
  it('the runner gate takes a shot-directed Veo with up to 3 pictures, and refuses what Generate a video refuses', () => {
    expect(requestProblems({ n: shot('veo-3.1', { image_urls: [view('a.png'), view('b.png')] }) }, { runner: true })).toEqual([])
    expect(requestProblems({ n: shot('veo-3.1', { image_urls: ['1', '2', '3', '4'].map(view) }) }, { runner: true })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: VEO_31_REFS_WORDS },
    ])
    // The ComfyUI path keeps its old one-picture rule.
    expect(requestProblems({ n: shot('veo-3.1', { image_urls: [view('a.png')] }) })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: VEO_31_ONE_PICTURE },
    ])
  })
  it('the runner gate refuses Kling elements without a start frame, and takes them with one', () => {
    expect(requestProblems({ n: shot('kling-v3', { elements: [el] }) }, { runner: true })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: KLING_ELEMENTS_NEED_FRAME },
    ])
    expect(requestProblems({ n: shot('kling-v3', { image_url: view('s.png'), elements: [el] }) }, { runner: true })).toEqual([])
  })
  it('the runner gate refuses a Seedance first frame beside references', () => {
    const p = requestProblems({ n: shot('seedance-2.0', { image_url: view('s.png'), image_urls: [view('a.png')] }) }, { runner: true })
    expect(p).toHaveLength(1)
    expect(p[0]!.classType).toBe('FilmShotNode')
  })
})

describe('the hosted ComfyUI gate reads elements\' links too', () => {
  it('video-refs lists elements\' face and reference pictures', () => {
    const spec = GRAPH_FILE_READERS.FilmShotNode![0]!
    const refs = extractFileRefs(spec, JSON.stringify({
      image_urls: [view('a.png')],
      elements: [{ frontal_image_url: view('face.png'), reference_image_urls: [view('body.png'), 'https://x/y.png'] }],
    }))
    expect(refs?.sort()).toEqual(['a.png', 'body.png', 'face.png'])
  })
})

describe('a bad reference link is refused before the hold', () => {
  it('the runner gate names the refusal', () => {
    expect(requestProblems({ n: shot('veo-3.1', { image_urls: ['/view?filename=a.png&filename=b.png&type=input'] }) }, { runner: true })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: VIEW_REF_REFUSED },
    ])
    expect(shotRefProblem({ image_urls: ['/view?filename=../x&type=input'] })).toBe('A reference picture could not be read.')
    expect(shotRefProblem({ image_urls: [view('a.png'), 'https://x/y.png'], elements: [{ frontal_image_url: view('f.png') }] })).toBeNull()
  })
})

describe('fix round: elements only on Kling 3 (runner)', () => {
  const el = { frontal_image_url: view('face.png'), reference_image_urls: [] }
  it('the runner gate refuses elements on any other model, Film a shot or Generate a video', () => {
    expect(requestProblems({ n: shot('seedance-2.0', { elements: [el] }) }, { runner: true })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: ELEMENTS_ONLY_KLING_WORDS },
    ])
    expect(requestProblems({ n: video('veo-3.1', { elements: [el] }) }, { runner: true })).toEqual([
      { nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: ELEMENTS_ONLY_KLING_WORDS },
    ])
    expect(ELEMENTS_ONLY_KLING_WORDS).toBe('Only Kling 3 takes characters as elements. Pick Kling 3, or send pictures instead.')
  })
})

describe('fix round (Ruling D): Seedance reference lengths on a shot-directed Film a shot', () => {
  const lengths: Record<string, number> = { 'a.mp4': 8, 'b.mp4': 8 }
  const read = async (f: { value: string }) => lengths[f.value] ?? null
  const overlong = () => ({ n: shot('seedance-2.0', { video_urls: [view('a.mp4'), view('b.mp4')] }) })

  it('the runner\'s check refuses 16 s of reference video', async () => {
    expect(await seedanceReferenceSeconds(overlong(), read, { filmShots: true })).toEqual([
      { nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: SEEDANCE_TOO_MUCH_VIDEO },
    ])
  })
  it('the runner\'s own call refuses an unmeasurable reference (hosted) and checks its files are owned', async () => {
    const owned: string[] = []
    const p = await runnerReferenceProblems([{ n: shot('seedance-2.0', { video_urls: [view('a.mp4'), 'https://x/y.mp4'] }) }], {
      readFile: async () => { throw new Error('gone') },
      strict: true,
      assertOwned: async fs => { owned.push(...fs.map(f => f.filename)) },
    })
    expect(p).toEqual({ nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: SEEDANCE_UNMEASURED_REFERENCE })
    expect(owned).toEqual(['a.mp4'])
  })
  it('the ComfyUI gate is unchanged: it does not read a Film a shot', async () => {
    expect(await seedanceReferenceSeconds(overlong(), read)).toEqual([])
    expect(await seedanceReferenceSeconds(overlong(), read, { strict: true })).toEqual([])
  })
})
