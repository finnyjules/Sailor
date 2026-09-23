import { describe, expect, it, vi } from 'vitest'
import { createRunEvents, ev } from '~~/server/runner/events'
import { isRunnerPromptId, RUNNER_WORKER } from '#shared/runner/messages'

describe('run events', () => {
  it('delivers only to the same user, and stops after unsubscribe', () => {
    const bus = createRunEvents()
    const a = vi.fn(); const b = vi.fn()
    const offA = bus.subscribe('u1', a)
    bus.subscribe('u2', b)
    bus.publish('u1', ev.start('run_x.0.t0'))
    expect(a).toHaveBeenCalledWith({ type: 'execution_start', data: { prompt_id: 'run_x.0.t0' } })
    expect(b).not.toHaveBeenCalled()
    offA()
    bus.publish('u1', ev.start('run_x.0.t0'))
    expect(a).toHaveBeenCalledTimes(1)
  })
  it('a listener that throws does not stop the others', () => {
    const bus = createRunEvents()
    const ok = vi.fn()
    bus.subscribe('u1', () => { throw new Error('x') })
    bus.subscribe('u1', ok)
    bus.publish('u1', ev.start('p'))
    expect(ok).toHaveBeenCalled()
  })
  it('builds the ComfyUI shapes the canvas already reads', () => {
    expect(ev.executing('p', '3')).toEqual({ type: 'executing', data: { prompt_id: 'p', node: '3', display_node: '3' } })
    expect(ev.progress('p', '3', 40)).toEqual({ type: 'progress', data: { prompt_id: 'p', node: '3', value: 40, max: 100 } })
    expect(ev.queuePosition('p', '3', 2)).toEqual({ type: 'queue_position', data: { prompt_id: 'p', node: '3', position: 2 } })
    expect(ev.executed('p', '3', { images: [] })).toEqual({ type: 'executed', data: { prompt_id: 'p', node: '3', display_node: '3', output: { images: [] } } })
    expect(ev.success('p', { runId: 'run_x', credits: 9 })).toEqual({ type: 'execution_success', data: { prompt_id: 'p', run_id: 'run_x', credits: 9, recorded: true, stopped: false } })
    expect(ev.error('p', '3', 'GenerateImageNode', 'boom', { runId: 'run_x', credits: 0 })).toEqual({
      type: 'execution_error',
      data: { prompt_id: 'p', node_id: '3', node_type: 'GenerateImageNode', exception_message: 'boom', exception_type: 'RunnerError', traceback: [], run_id: 'run_x', credits: 0, recorded: true },
    })
    const choices = [{ take: 0, files: [{ filename: 'a.png', subfolder: '', type: 'output' }] }]
    expect(ev.gatePaused('run_x.0', 'run_x', '2', choices, [0])).toEqual({
      type: 'gate_paused', data: { prompt_id: 'run_x.0', run_id: 'run_x', node_id: '2', choices, picked: [0] },
    })
  })
  it('recognises runner prompt ids', () => {
    expect(isRunnerPromptId('run_abc.0.t1')).toBe(true)
    expect(isRunnerPromptId('8c1d…')).toBe(false)
    expect(isRunnerPromptId(null)).toBe(false)
    expect(RUNNER_WORKER).toBe(-1)
  })
})
