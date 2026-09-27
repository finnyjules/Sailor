import { describe, expect, it } from 'vitest'
import { isRunnerEligible, resolveVideoModelId, runnerTakesNode, RUNNER_IMAGE_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import type { ApiPrompt } from '#shared/runner/graph'

const img = (model = 'flux-schnell') => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: '{}' } })

describe('isRunnerEligible', () => {
  it('takes an image → Gate → video workflow on runner models', () => {
    const p: ApiPrompt = {
      '1': img(),
      '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
      '3': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'y', image: ['2', 0], aspect_ratio: '16:9', duration: '8', seed: 0, model_options: '{}' } },
      '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['3', 0] } },
    }
    expect(isRunnerEligible(p)).toBe(true)
  })
  it('refuses a workflow with any other node type', () => {
    expect(isRunnerEligible({ '1': img(), '2': { class_type: 'ImageBlur', inputs: { image: ['1', 0] } } })).toBe(false)
  })
  it('refuses a model that is not on the runner list', () => {
    expect(isRunnerEligible({ '1': img('imagen-4') })).toBe(false)
    expect(isRunnerEligible({ '1': img('krea-2-large') })).toBe(false)
  })
  it('refuses a workflow with no generator, an empty one, or a dangling link', () => {
    expect(isRunnerEligible({ '1': { class_type: 'Image', inputs: { image: 'a.png' } } })).toBe(false)
    expect(isRunnerEligible({})).toBe(false)
    expect(isRunnerEligible({ '1': { class_type: 'Image', inputs: { images: ['9', 0] } }, '2': img() })).toBe(false)
  })
  it('refuses a video node with sound wired in', () => {
    expect(isRunnerEligible({ '1': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', audio: ['1', 0] } } })).toBe(false)
  })
  it('refuses an image node that asks for more than one picture (it goes to Python whole)', () => {
    const withOpts = (model: string, opts: unknown) => ({ '1': { class_type: 'GenerateImageNode', inputs: { model, prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: opts } } })
    expect(isRunnerEligible(withOpts('flux-schnell', JSON.stringify({ num_outputs: 2 })))).toBe(false)
    expect(isRunnerEligible(withOpts('flux-schnell', JSON.stringify({ num_outputs: '3' })))).toBe(false)
    expect(isRunnerEligible(withOpts('flux-schnell', { num_outputs: 4 }))).toBe(false)
    expect(isRunnerEligible(withOpts('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'auto', max_images: 4 })))).toBe(false)
    // one picture is fine, however it is written
    expect(isRunnerEligible(withOpts('flux-schnell', JSON.stringify({ num_outputs: 1 })))).toBe(true)
    expect(isRunnerEligible(withOpts('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'auto', max_images: 1 })))).toBe(true)
    expect(isRunnerEligible(withOpts('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'disabled', max_images: 6 })))).toBe(true)
    // unreadable options are no options, as GenerateImageNode treats them
    expect(isRunnerEligible(withOpts('flux-schnell', '{not json'))).toBe(true)
    expect(isRunnerEligible(withOpts('flux-schnell', '[2]'))).toBe(true)
    expect(isRunnerEligible(withOpts('flux-schnell', ''))).toBe(true)
    expect(isRunnerEligible(withOpts('flux-schnell', undefined))).toBe(true)
  })
  it('maps legacy video labels the way GenerateVideoNode does', () => {
    expect(resolveVideoModelId('Veo 3')).toBe('veo-3.1')
    expect(resolveVideoModelId('Seedance 2.0')).toBe('seedance-2.0')
    expect(resolveVideoModelId('hailuo-h3')).toBe('hailuo-h3')
  })
  it('lists exactly the 9 + 6 runner models', () => {
    expect(RUNNER_IMAGE_MODEL_IDS).toHaveLength(9)
    expect(RUNNER_VIDEO_MODEL_IDS).toHaveLength(6)
  })
})

describe('runnerTakesNode: Film a shot (Task 4, characters stage 3)', () => {
  const shot = (model: string, opts: Record<string, unknown>) => ({ class_type: 'FilmShotNode', inputs: {
    preset: 'slow_push_in', prompt: 'x', model, aspect_ratio: '16:9', duration: '5', seed: 0, model_options: JSON.stringify(opts),
  } })
  it('takes a shot-directed one on Seedance 2.0 or Veo 3.1; a preset one stays on ComfyUI', () => {
    expect(runnerTakesNode({ n: shot('seedance-2.0', { __shot_directed: true }) }, 'n')).toBe(true)
    expect(runnerTakesNode({ n: shot('veo-3.1', { __shot_directed: true }) }, 'n')).toBe(true)
    expect(runnerTakesNode({ n: shot('seedance-2.0', {}) }, 'n')).toBe(false)
    expect(isRunnerEligible({ n: shot('seedance-2.0', {}) })).toBe(false)
  })
  it('Kling 3 only with the replicate-video family', () => {
    expect(runnerTakesNode({ n: shot('kling-v3', { __shot_directed: true }) }, 'n')).toBe(false)
    expect(runnerTakesNode({ n: shot('kling-v3', { __shot_directed: true }) }, 'n', new Set(['replicate-video']))).toBe(true)
  })
})
