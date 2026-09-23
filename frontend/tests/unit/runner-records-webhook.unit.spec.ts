import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { toGenerationRecord, createGenerationRecords } from '~~/server/runner/records'
import { verifyFalWebhook, falWebhookMessage, createJwksCache } from '~~/server/runner/webhook'
import { pollDelayMs } from '~~/server/runner/index'
import type { StageRecordSummary } from '~~/server/runner/engine'

function summary(over: Partial<StageRecordSummary['run']> = {}): StageRecordSummary {
  const run: any = { id: 'run_x', userId: 'u1', canvasId: 'c1', projectUuid: 'p-1', projectName: 'Fox', ...over }
  return {
    run,
    take: { index: 0 } as any,
    leg: { index: 0, id: 'run_x.0' } as any,
    charge: { stageKey: 'run_x.0.t0', actual: 2 } as any,
    outputs: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }, { filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' }],
    nodeTypes: ['GenerateImageNode', 'Image'],
    ts: 1234,
  }
}

describe('generation records', () => {
  it('carry the stage key, exact credits and the run id', () => {
    expect(toGenerationRecord(summary(), true)).toEqual({
      promptId: 'run_x.0.t0', runId: 'run_x', ts: 1234, canvasId: 'c1',
      outputs: [
        { kind: 'image', filename: 'generate_image_00001_.png', subfolder: '', type: 'output' },
        { kind: 'video', filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' },
      ],
      usd: null, usdApproximate: false, credits: 2, nodes: ['GenerateImageNode', 'Image'],
    })
    expect(toGenerationRecord(summary(), false).credits).toBeNull()
  })
  it('write to the project, claiming it if nobody owns it yet, never to someone else’s', async () => {
    const post = vi.fn(async () => {})
    const recordOwner = vi.fn(async () => {})
    const owners: Record<string, string | null> = { 'p-1': null, 'p-2': 'u2', 'p-3': 'u1' }
    const r = createGenerationRecords({ hosted: () => true, ownerOf: async (_k, id) => owners[id] ?? null, recordOwner, post })
    await r.write(summary())
    expect(recordOwner).toHaveBeenCalledWith('project', 'p-1', 'u1')
    expect(post).toHaveBeenCalledWith('p-1', { projectName: 'Fox', generation: expect.objectContaining({ promptId: 'run_x.0.t0' }) })
    await r.write(summary({ projectUuid: 'p-2' }))
    await r.write(summary({ projectUuid: 'p-3' }))
    expect(post.mock.calls.map(c => c[0])).toEqual(['p-1', 'p-3'])
    await r.write(summary({ projectUuid: null }))
    await r.write(summary({ projectUuid: '../x' }))
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('fal webhook signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as any
  const keys = [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x }]
  const body = new TextEncoder().encode(JSON.stringify({ request_id: 'r1', status: 'OK' }))
  const h = { requestId: 'r1', userId: 'fal-user', timestamp: '1700000000' }
  const signature = sign(null, falWebhookMessage(h, body), privateKey).toString('hex')

  it('accepts a correctly signed, fresh call', () => {
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys, nowSec: 1700000100 })).toBe(true)
  })
  it('refuses anything unsigned, altered, stale or from another key', () => {
    expect(verifyFalWebhook({ headers: { ...h }, rawBody: body, keys, nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: new TextEncoder().encode('{}'), keys, nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys, nowSec: 1700000400 })).toBe(false)
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as any
    expect(verifyFalWebhook({ headers: { ...h, signature }, rawBody: body, keys: [{ kty: other.kty, crv: other.crv, x: other.x }], nowSec: 1700000100 })).toBe(false)
    expect(verifyFalWebhook({ headers: { ...h, signature: 'zz' }, rawBody: body, keys, nowSec: 1700000100 })).toBe(false)
  })
  it('caches the key list', async () => {
    const fetchKeys = vi.fn(async () => keys)
    const cache = createJwksCache(fetchKeys, 60_000)
    await cache.keys(); await cache.keys()
    expect(fetchKeys).toHaveBeenCalledTimes(1)
  })
})

describe('poll pacing', () => {
  it('ramps from 350ms to a 2s ceiling, like the Python client', () => {
    expect(pollDelayMs(0)).toBe(350)
    expect(pollDelayMs(1)).toBe(525)
    expect(pollDelayMs(10)).toBe(2000)
  })
})
