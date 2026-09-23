// frontend/tests/unit/scene3d-asset-tracker.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { AssetTracker } from '~/lib/scene3d/assetTracker'

const later = <T>(v: T, ms = 5) => new Promise<T>(r => setTimeout(() => r(v), ms))
const failLater = (msg: string, ms = 5) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))

describe('AssetTracker', () => {
  it('settle waits for every observed load', async () => {
    const t = new AssetTracker()
    let done = 0
    t.observe('model', 'a.glb', later(1).then(() => { done++ }))
    t.observe('hdri', 'studio', later(2, 15).then(() => { done++ }))
    expect(t.pending).toBe(2)
    expect(await t.settle()).toEqual([])
    expect(done).toBe(2)
    expect(t.pending).toBe(0)
  })
  it('a load started while settling is waited for too (a model starts its textures)', async () => {
    const t = new AssetTracker()
    let nested = false
    t.observe('model', 'a.glb', later(0).then(() => {
      t.observe('texture', 'wood.jpg', later(0, 10).then(() => { nested = true }))
    }))
    await t.settle()
    expect(nested).toBe(true)
  })
  it('a failed load is reported by kind and name with its reason', async () => {
    const t = new AssetTracker()
    t.observe('model', 'Sneaker', failLater('HTTP 403'))
    const failures = await t.settle()
    expect(failures).toEqual([{ kind: 'model', name: 'Sneaker', reason: 'HTTP 403' }])
  })
  it('fail() records a failure a site swallowed', async () => {
    const t = new AssetTracker()
    t.fail('font', 'google:Inter@700', new Error('offline'))
    expect(await t.settle()).toEqual([{ kind: 'font', name: 'google:Inter@700', reason: 'offline' }])
  })
  it('observing never raises an unhandled rejection of its own', async () => {
    const t = new AssetTracker()
    const p = failLater('x')
    p.catch(() => {})             // the site handles its own promise
    t.observe('mesh', 'm1', p)
    await t.settle()              // no throw
  })
  it('settle gives up after maxRounds rather than hanging on a load that keeps re-arming', async () => {
    const t = new AssetTracker()
    const arm = (): void => { t.observe('texture', 'loop', later(0).then(arm)) }
    arm()
    await t.settle(3)
    expect(t.pending).toBeGreaterThan(0)
  })
  it('failureCount marks a point so later failures can be read on their own', async () => {
    const t = new AssetTracker()
    t.fail('texture', 'old.jpg', 'earlier session')
    const base = t.failureCount
    t.observe('texture', 'new.jpg', failLater('HTTP 404'))
    const all = await t.settle()
    expect(all.slice(base)).toEqual([{ kind: 'texture', name: 'new.jpg', reason: 'HTTP 404' }])
    t.clearFailures()
    expect(t.failureCount).toBe(0)
  })
})
