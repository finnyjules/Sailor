import { describe, it, expect } from 'vitest'
import { mapWsEvent } from '~/lib/graph/wsEventMap'
import { reconnectDelayMs, buildWsUrl } from '~/composables/useDirectExecution'

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
  it('keeps the runner’s charge on a failure', () => {
    expect(mapWsEvent({ type: 'execution_error', data: { prompt_id: 'run_a.0.t0', node_id: '1', node_type: 'GenerateImageNode', exception_message: 'x', exception_type: 'RunnerError', traceback: [], run_id: 'run_a', credits: 0, recorded: true } }, CID))
      .toMatchObject({ event: 'execution_error', prompt_id: 'run_a.0.t0', run_id: 'run_a', credits: 0, recorded: true })
  })
})

describe('reconnectDelayMs', () => {
  it('starts at 1s for the first attempt', () => {
    expect(reconnectDelayMs(0)).toBe(1000)
  })

  it('doubles with each attempt', () => {
    expect(reconnectDelayMs(1)).toBe(2000)
    expect(reconnectDelayMs(2)).toBe(4000)
  })

  it('caps at 5s', () => {
    expect(reconnectDelayMs(3)).toBe(5000)
    expect(reconnectDelayMs(10)).toBe(5000)
  })

  it('never goes below 1s for negative/zero attempts', () => {
    expect(reconnectDelayMs(-5)).toBe(1000)
  })
})

describe('buildWsUrl', () => {
  it('converts an http origin to ws and appends the clientId', () => {
    expect(buildWsUrl('http://127.0.0.1:8188', CID)).toBe('ws://127.0.0.1:8188/ws?clientId=client-abc')
  })

  it('converts an https origin to wss', () => {
    expect(buildWsUrl('https://sailor.fly.dev:8188', CID)).toBe(
      'wss://sailor.fly.dev:8188/ws?clientId=client-abc',
    )
  })

  it('builds a same-origin ws URL from a browser location origin (the dev path)', () => {
    // wsUrl() passes window.location.origin so the /ws upgrade goes to the Nuxt
    // proxy on the SAME port the page loaded from, never :8188 directly.
    expect(buildWsUrl('http://localhost:3002', CID)).toBe('ws://localhost:3002/ws?clientId=client-abc')
  })

  it('omits the comfyWorker param for worker 0 / main (byte-identical to the 2-arg form)', () => {
    expect(buildWsUrl('http://localhost:3002', CID, 0)).toBe('ws://localhost:3002/ws?clientId=client-abc')
    // absent worker arg is treated as main too.
    expect(buildWsUrl('http://localhost:3002', CID)).toBe(buildWsUrl('http://localhost:3002', CID, 0))
  })

  it('appends &comfyWorker=<0-based pool index> for pool workers (app-side N → N-1)', () => {
    // app-side worker 1 → pool index 0; worker 2 → pool index 1.
    expect(buildWsUrl('http://localhost:3002', CID, 1)).toBe(
      'ws://localhost:3002/ws?clientId=client-abc&comfyWorker=0',
    )
    expect(buildWsUrl('http://localhost:3002', CID, 2)).toBe(
      'ws://localhost:3002/ws?clientId=client-abc&comfyWorker=1',
    )
  })
})
