import { describe, expect, it } from 'vitest'
import { shouldUseRunner, runIdOfPrompt } from '~/lib/runner/client'
import { runnerMessageToPipe } from '~/composables/useRunnerEvents'

const img = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x' } } }
const blur = { '1': { class_type: 'ImageBlur', inputs: {} } }

describe('shouldUseRunner', () => {
  it('needs the switch on and every take eligible', () => {
    expect(shouldUseRunner(false, [img])).toBe(false)
    expect(shouldUseRunner(true, [img, img])).toBe(true)
    expect(shouldUseRunner(true, [img, blur])).toBe(false)
    expect(shouldUseRunner(true, [img, null])).toBe(false)
    expect(shouldUseRunner(true, [])).toBe(false)
  })
})

describe('runIdOfPrompt', () => {
  it('finds the run behind a stage key or leg id', () => {
    expect(runIdOfPrompt('run_abc.1.t2')).toBe('run_abc')
    expect(runIdOfPrompt('run_abc.1')).toBe('run_abc')
    expect(runIdOfPrompt('4f1e-comfy')).toBeNull()
    expect(runIdOfPrompt(undefined)).toBeNull()
  })
})

describe('runnerMessageToPipe', () => {
  it('wraps a runner message in the page’s event envelope', () => {
    expect(runnerMessageToPipe(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'run_a.0.t0' } })))
      .toEqual({ type: 'sailor-bridge', v: 2, direct: true, event: 'execution_start', prompt_id: 'run_a.0.t0' })
  })
  it('drops junk and messages the canvas does not use', () => {
    expect(runnerMessageToPipe('not json')).toBeNull()
    expect(runnerMessageToPipe(JSON.stringify({ type: 'status', data: {} }))).toBeNull()
  })
})
