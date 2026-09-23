// frontend/tests/unit/scene3d-asset-tracker.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { AssetTracker, REASON_DIDNT_FINISH, REASON_KEPT_RELOADING } from '~/lib/scene3d/assetTracker'

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
  it('settle gives up after maxRounds rather than hanging on a load that keeps re-arming, and names it', async () => {
    const t = new AssetTracker()
    let stop = false
    const arm = (): void => { if (!stop) t.observe('texture', 'loop', later(0).then(arm)) }
    arm()
    const failures = await t.settle({ maxRounds: 3 })
    expect(t.pending).toBeGreaterThan(0)
    expect(failures).toEqual([{ kind: 'texture', name: 'loop', reason: REASON_KEPT_RELOADING }])
    stop = true
    await t.settle()
    expect(t.pending).toBe(0)
  })
  it('a load that never settles: settle returns by the deadline and names it', async () => {
    const t = new AssetTracker()
    t.observe('model', 'Sneaker', new Promise(() => {}))
    t.observe('hdri', 'studio', later(1))
    const start = Date.now()
    const failures = await t.settle({ deadline: Date.now() + 40 })
    expect(Date.now() - start).toBeLessThan(1000)
    expect(failures).toEqual([{ kind: 'model', name: 'Sneaker', reason: REASON_DIDNT_FINISH }])
    expect(t.pending).toBe(1) // the load itself keeps running; settle only stopped waiting
  })
  it("a timed-out load is reported, not stored: once it lands a later settle doesn't name it", async () => {
    const t = new AssetTracker()
    let land!: () => void
    t.observe('font', 'Inter', new Promise<void>((r) => { land = r }))
    expect(await t.settle({ deadline: Date.now() + 10 })).toHaveLength(1)
    land()
    expect(await t.settle()).toEqual([])
  })
  it('one failure per asset, the latest reason winning', async () => {
    const t = new AssetTracker()
    t.observe('texture', 'wood.jpg', failLater('HTTP 404'))
    t.observe('texture', 'wood.jpg', failLater('HTTP 404'))
    t.fail('decal', 'Sticker', 'offline')
    t.fail('decal', 'Sticker', 'HTTP 500')
    expect(await t.settle()).toEqual([ // most recent last: the texture loads failed after the fail() calls
      { kind: 'decal', name: 'Sticker', reason: 'HTTP 500' },
      { kind: 'texture', name: 'wood.jpg', reason: 'HTTP 404' },
    ])
  })
  it('a failure retried many times does not grow the list', async () => {
    const t = new AssetTracker()
    for (let i = 0; i < 500; i++) t.fail('decal', 'Sticker', 'HTTP 404')
    expect(t.failures()).toHaveLength(1)
  })
  it('mark: later failures can be read on their own, and clearFailures never makes a mark skip one', async () => {
    const t = new AssetTracker()
    t.fail('texture', 'old.jpg', 'earlier session')
    const base = t.mark
    t.observe('texture', 'new.jpg', failLater('HTTP 404'))
    await t.settle()
    expect(t.failures({ since: base })).toEqual([{ kind: 'texture', name: 'new.jpg', reason: 'HTTP 404' }])
    t.clearFailures()
    expect(t.mark).toBeGreaterThan(base) // monotonic
    t.fail('texture', 'after-clear.jpg', 'HTTP 404')
    expect(t.failures({ since: base })).toEqual([{ kind: 'texture', name: 'after-clear.jpg', reason: 'HTTP 404' }])
  })
  it('an asset that failed again after the mark is read again', () => {
    const t = new AssetTracker()
    t.fail('texture', 'wood.jpg', 'first')
    const base = t.mark
    expect(t.failures({ since: base })).toEqual([])
    t.fail('texture', 'wood.jpg', 'second')
    expect(t.failures({ since: base })).toEqual([{ kind: 'texture', name: 'wood.jpg', reason: 'second' }])
  })
})

describe('AssetTracker owners', () => {
  it("an owner waits only on its own loads and reads only its own failures", async () => {
    const t = new AssetTracker()
    t.observe('texture', 'mine.jpg', failLater('HTTP 404'), 'e1')
    t.observe('texture', 'theirs.jpg', failLater('HTTP 403', 1), 'e2')
    t.observe('texture', 'stalled.jpg', new Promise(() => {}), 'e2')
    const start = Date.now()
    expect(await t.settle({ owner: 'e1', deadline: Date.now() + 5000 })).toEqual([
      { kind: 'texture', name: 'mine.jpg', reason: 'HTTP 404' },
    ])
    expect(Date.now() - start).toBeLessThan(1000) // never waited on e2's stalled load
    await later(0, 10) // let e2's quick failure land
    expect(t.pendingFor('e1')).toBe(0)
    expect(t.pendingFor('e2')).toBe(1)
    expect(t.failures({ owner: 'e2' })).toEqual([{ kind: 'texture', name: 'theirs.jpg', reason: 'HTTP 403' }])
  })
  it('a shared load another owner joined fails for every owner waiting on it', async () => {
    const t = new AssetTracker()
    const load = t.observe('texture', 'shared.jpg', failLater('HTTP 404'), 'e1')
    load.addOwner('e2')
    await t.settle()
    expect(t.failures({ owner: 'e1' })).toHaveLength(1)
    expect(t.failures({ owner: 'e2' })).toHaveLength(1)
    expect(t.failures({ owner: 'e3' })).toEqual([])
  })
  it('the same asset failing for two owners keeps both, even when one fails again later', () => {
    const t = new AssetTracker()
    t.fail('texture', 'wood.jpg', 'x', 'e1')
    const base = t.mark
    t.fail('texture', 'wood.jpg', 'y', 'e2')
    expect(t.failures({ owner: 'e1' })).toEqual([{ kind: 'texture', name: 'wood.jpg', reason: 'y' }])
    expect(t.failures({ owner: 'e1', since: base })).toEqual([]) // e1's own failure predates the mark
    expect(t.failures({ owner: 'e2', since: base })).toHaveLength(1)
  })
  it('forgetOwner drops a gone owner, and a record nobody owns any more', () => {
    const t = new AssetTracker()
    t.fail('texture', 'a.jpg', 'x', 'e1')
    t.fail('texture', 'b.jpg', 'x', 'e1')
    t.fail('texture', 'b.jpg', 'x', 'e2')
    t.forgetOwner('e1')
    expect(t.failures()).toEqual([{ kind: 'texture', name: 'b.jpg', reason: 'x' }])
    expect(t.failures({ owner: 'e1' })).toEqual([])
  })
})
