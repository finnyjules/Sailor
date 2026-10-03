/**
 * Stage 5 Task 5: tenant ownership gating for the shared ComfyUI engine's
 * read/control endpoints — the pure /view decisions.
 *
 * Step 3, R10.9: hosted never reaches the engine. The handlers that asked it
 * (the /queue filter, targeted /interrupt, the /view race-window harvest of
 * the engine's history, per-user settings/userdata) are deleted, and the
 * proxy answers those paths 404 (hosted-never-reaches-engine.unit.spec.ts).
 * C2 (annotated /view) lives in view-route-gate.unit.spec.ts.
 */
import { describe, expect, it } from 'vitest'

const gate = await import('../../server/utils/engineGate')
const { annotatedFilepath, viewGateDecision } = gate

describe('R10.9: the hosted engine handlers are gone', () => {
  it('exports no handler that asks the engine', () => {
    for (const name of ['handleHostedQueueGet', 'handleHostedInterrupt', 'handleHostedUserScoped', 'harvestPendingOutputs', 'filterQueuePayload', 'filterHistoryPayload']) {
      expect((gate as Record<string, unknown>)[name], name).toBeUndefined()
    }
  })
})

describe('annotatedFilepath — mirrors folder_paths.annotated_filepath', () => {
  it('resolves each annotation and strips the separator', () => {
    expect(annotatedFilepath('a.png [output]')).toEqual({ name: 'a.png', type: 'output' })
    expect(annotatedFilepath('a.png [input]')).toEqual({ name: 'a.png', type: 'input' })
    expect(annotatedFilepath('a.png [temp]')).toEqual({ name: 'a.png', type: 'temp' })
  })
  it('leaves an unannotated name alone', () => {
    expect(annotatedFilepath('a.png')).toEqual({ name: 'a.png', type: null })
    expect(annotatedFilepath('a [output].png')).toEqual({ name: 'a [output].png', type: null })
  })
})

describe('viewGateDecision', () => {
  it('gates the annotated form as output regardless of ?type', () => {
    expect(viewGateDecision({ filename: 'v.png [output]', type: 'temp' })).toEqual({ kind: 'check', key: 'output::v.png' })
    expect(viewGateDecision({ filename: 'v.png [output]', type: 'input', subfolder: 's' })).toEqual({ kind: 'check', key: 'output:s:v.png' })
  })
  it('honours an annotation that points AWAY from output', () => {
    expect(viewGateDecision({ filename: 'v.png [temp]', type: 'output' })).toEqual({ kind: 'ungated' })
  })
  it('defaults a missing type to output', () => {
    expect(viewGateDecision({ filename: 'v.png' })).toEqual({ kind: 'check', key: 'output::v.png' })
  })
  it('rejects blake3 reads', () => {
    expect(viewGateDecision({ filename: 'blake3:abc' })).toMatchObject({ kind: 'reject', status: 400 })
  })
})
