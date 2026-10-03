import { describe, it, expect } from 'vitest'
import { mapWsEvent } from '~/lib/graph/wsEventMap'

const CID = 'client-abc'

describe('mapWsEvent', () => {
  it('maps execution_start to { event, prompt_id }', () => {
    expect(mapWsEvent({ type: 'execution_start', data: { prompt_id: 'p1' } }, CID)).toEqual({
      event: 'execution_start',
      prompt_id: 'p1',
    })
  })

  it('emits percent 0 when max is 0 or absent (no NaN/Infinity)', () => {
    expect(mapWsEvent({ type: 'progress', data: { value: 5, max: 0, prompt_id: 'p1', node: '7' } }, CID)).toEqual({
      event: 'progress',
      percent: 0,
      prompt_id: 'p1',
      node_id: '7',
    })
    expect(mapWsEvent({ type: 'progress', data: { value: 5, prompt_id: 'p1', node: '7' } }, CID)).toEqual({
      event: 'progress',
      percent: 0,
      prompt_id: 'p1',
      node_id: '7',
    })
  })

  it('maps progress computing percent from value/max', () => {
    expect(mapWsEvent({ type: 'progress', data: { value: 5, max: 10, prompt_id: 'p1', node: '7' } }, CID)).toEqual({
      event: 'progress',
      percent: 50,
      prompt_id: 'p1',
      node_id: '7',
    })
  })

  it('rounds percent', () => {
    const out = mapWsEvent({ type: 'progress', data: { value: 1, max: 3, prompt_id: 'p1', node: '7' } }, CID)
    expect(out?.percent).toBe(33)
  })

  it('maps executing with a node to { event, node_id }', () => {
    expect(mapWsEvent({ type: 'executing', data: { node: '3', prompt_id: 'p1', display_node: '3' } }, CID)).toEqual({
      event: 'executing',
      node_id: '3',
      display_node: '3',
      prompt_id: 'p1',
    })
  })

  it('maps executing with node=null to execution_complete', () => {
    expect(mapWsEvent({ type: 'executing', data: { node: null, prompt_id: 'p1' } }, CID)).toEqual({
      event: 'execution_complete',
      prompt_id: 'p1',
    })
  })

  it('maps executed to { event, node_id, output }', () => {
    expect(
      mapWsEvent({ type: 'executed', data: { node: '9', output: { images: [{ filename: 'a.png' }] }, prompt_id: 'p1' } }, CID)
    ).toEqual({
      event: 'executed',
      node_id: '9',
      output: { images: [{ filename: 'a.png' }] },
      prompt_id: 'p1',
    })
  })

  it('maps execution_error with traceback array joined to a string', () => {
    expect(
      mapWsEvent(
        {
          type: 'execution_error',
          data: {
            node_id: '4',
            node_type: 'KSampler',
            exception_message: 'boom',
            exception_type: 'RuntimeError',
            traceback: ['line1\n', 'line2\n'],
            prompt_id: 'p1',
          },
        },
        CID
      )
    ).toEqual({
      event: 'execution_error',
      node_id: '4',
      node_type: 'KSampler',
      exception_message: 'boom',
      exception_type: 'RuntimeError',
      traceback: 'line1\nline2\n',
      prompt_id: 'p1',
    })
  })

  it('maps execution_success to execution_complete', () => {
    expect(mapWsEvent({ type: 'execution_success', data: { prompt_id: 'p1' } }, CID)).toEqual({
      event: 'execution_complete',
      prompt_id: 'p1',
    })
  })

  it('maps execution_complete to execution_complete', () => {
    expect(mapWsEvent({ type: 'execution_complete', data: { prompt_id: 'p1' } }, CID)).toEqual({
      event: 'execution_complete',
      prompt_id: 'p1',
    })
  })

  it('maps gate_paused to { event, node_id, prompt_id }', () => {
    expect(mapWsEvent({ type: 'gate_paused', data: { node_id: '2', prompt_id: 'p1' } }, CID)).toEqual({
      event: 'gate_paused',
      node_id: '2',
      prompt_id: 'p1',
    })
  })

  it('ignores status messages (returns null)', () => {
    expect(mapWsEvent({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } }, CID)).toBeNull()
  })

  it('returns null for an unknown type', () => {
    expect(mapWsEvent({ type: 'some_future_event', data: {} }, CID)).toBeNull()
  })

  it('drops messages carrying a different clientId', () => {
    expect(
      mapWsEvent({ type: 'executing', data: { node: '3', prompt_id: 'p1', clientId: 'other-client' } }, CID)
    ).toBeNull()
  })

  it('keeps messages carrying the same clientId', () => {
    expect(
      mapWsEvent({ type: 'executing', data: { node: '3', prompt_id: 'p1', clientId: CID } }, CID)
    ).toEqual({
      event: 'executing',
      node_id: '3',
      display_node: undefined,
      prompt_id: 'p1',
    })
  })

  it('drops messages with a different sid on status-shaped payloads', () => {
    expect(mapWsEvent({ type: 'status', data: { sid: 'other-client' } }, CID)).toBeNull()
  })

  it('returns null for malformed/non-object data', () => {
    expect(mapWsEvent({ type: 'executing', data: null }, CID)).toBeNull()
    expect(mapWsEvent({ type: 'progress', data: undefined }, CID)).toBeNull()
  })

  it('returns null for a binary/non-JSON message shape', () => {
    // Binary preview frames never reach mapWsEvent as { type, data } — but guard
    // against garbage callers might pass after a failed parse.
    expect(mapWsEvent(null as any, CID)).toBeNull()
    expect(mapWsEvent(undefined as any, CID)).toBeNull()
    expect(mapWsEvent({} as any, CID)).toBeNull()
  })

  it('maps the runner’s queue position', () => {
    expect(mapWsEvent({ type: 'queue_position', data: { prompt_id: 'run_a.0.t0', node: '1', position: 3 } }, CID))
      .toEqual({ event: 'queue_position', prompt_id: 'run_a.0.t0', node_id: '1', position: 3 })
  })
  it('maps the runner’s switch to a backup service, with its status line and canvas', () => {
    const data = { prompt_id: 'run_a.0.t0', node: '1', from: 'replicate', to: 'fal', message: 'Slow to start on Replicate, trying fal.', canvas_id: 'c1' }
    expect(mapWsEvent({ type: 'provider-switch', data }, CID)).toEqual({
      event: 'provider_switch', prompt_id: 'run_a.0.t0', node_id: '1', from: 'replicate', to: 'fal',
      message: 'Slow to start on Replicate, trying fal.', canvas_id: 'c1',
    })
  })
  it('carries the runner’s exact cost on completion, and nothing extra for ComfyUI', () => {
    expect(mapWsEvent({ type: 'execution_success', data: { prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 47, recorded: true, stopped: false } }, CID))
      .toEqual({ event: 'execution_complete', prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 47, recorded: true, stopped: false })
    expect(mapWsEvent({ type: 'execution_success', data: { prompt_id: 'p1' } }, CID))
      .toEqual({ event: 'execution_complete', prompt_id: 'p1' })
  })
  it('carries Gate choices', () => {
    const choices = [{ take: 0, files: [{ filename: 'a.png', subfolder: '', type: 'output' }] }]
    expect(mapWsEvent({ type: 'gate_paused', data: { prompt_id: 'run_a.0', run_id: 'run_a', node_id: '2', choices, picked: [0] } }, CID))
      .toEqual({ event: 'gate_paused', prompt_id: 'run_a.0', node_id: '2', run_id: 'run_a', choices, picked: [0] })
    expect(mapWsEvent({ type: 'gate_paused', data: { prompt_id: 'p', node_id: '2' } }, CID))
      .toEqual({ event: 'gate_paused', prompt_id: 'p', node_id: '2' })
  })
  it('passes a runner message’s canvas_id through, and leaves ComfyUI messages alone', () => {
    const on = (type: string, data: Record<string, unknown>) => mapWsEvent({ type, data }, CID)
    expect(on('execution_start', { prompt_id: 'run_a.0.t0', canvas_id: 'c7' })).toEqual({ event: 'execution_start', prompt_id: 'run_a.0.t0', canvas_id: 'c7' })
    expect(on('executing', { prompt_id: 'run_a.0.t0', node: '1', display_node: '1', canvas_id: 'c7' })).toMatchObject({ event: 'executing', canvas_id: 'c7' })
    expect(on('queue_position', { prompt_id: 'run_a.0.t0', node: '1', position: 2, canvas_id: null })).toMatchObject({ event: 'queue_position', canvas_id: null })
    expect(on('execution_success', { prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 2, recorded: true, canvas_id: 'c7' })).toMatchObject({ event: 'execution_complete', canvas_id: 'c7' })
    expect(on('gate_paused', { prompt_id: 'run_a.0', run_id: 'run_a', node_id: '2', choices: [], picked: [], canvas_id: 'c7' })).toMatchObject({ event: 'gate_paused', canvas_id: 'c7' })
    // ComfyUI's own messages never carry it, even if something put it there
    expect(on('execution_start', { prompt_id: 'p1', canvas_id: 'c7' })).toEqual({ event: 'execution_start', prompt_id: 'p1' })
    expect(on('executed', { prompt_id: 'p1', node: '3', output: {}, canvas_id: 'c7' })).toEqual({ event: 'executed', node_id: '3', output: {}, prompt_id: 'p1' })
  })
  it('keeps the runner’s charge on a failure', () => {
    expect(mapWsEvent({ type: 'execution_error', data: { prompt_id: 'run_a.0.t0', node_id: '1', node_type: 'GenerateImageNode', exception_message: 'x', exception_type: 'RunnerError', traceback: [], run_id: 'run_a', credits: 0, recorded: true } }, CID))
      .toMatchObject({ event: 'execution_error', prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 0, recorded: true })
  })
})
