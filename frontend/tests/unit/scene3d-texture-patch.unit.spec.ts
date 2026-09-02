import { describe, it, expect, vi } from 'vitest'

// studioTune imports ofetch's $fetch at module scope for other tuners; stub it so this
// spec doesn't need the real package resolvable (see tests/unit/studio-tune.unit.spec.ts).
vi.mock('ofetch', () => ({ $fetch: vi.fn() }))

import { resolveTexturePatches } from '~/lib/agent/studioTune'

describe('resolveTexturePatches', () => {
  it('rewrites a phrase to the resolved id', async () => {
    const resolve = vi.fn(async () => ({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' }))
    const { patch, notes } = await resolveTexturePatches({ 'object.material.texture': 'wood', 'object.material.roughness': 0.8 }, resolve)
    expect(patch).toEqual({ 'object.material.texture': 'ambientcg:WoodFloor051', 'object.material.roughness': 0.8 })
    expect(notes).toEqual([])
    expect(resolve).toHaveBeenCalledWith('wood')
  })
  it('drops a miss and notes it', async () => {
    const resolve = vi.fn(async () => ({ id: null, name: null }))
    const { patch, notes } = await resolveTexturePatches({ 'objects.abc.material.texture': 'unicorn' }, resolve)
    expect(patch).toEqual({})
    expect(notes).toEqual(["No texture set matched 'unicorn'"])
  })
  it('leaves resolved ids and unrelated keys alone without calling the resolver', async () => {
    const resolve = vi.fn()
    const { patch } = await resolveTexturePatches({ 'object.material.texture': 'ambientcg:Wood095', 'lighting.ambient': 0.3 }, resolve)
    expect(patch).toEqual({ 'object.material.texture': 'ambientcg:Wood095', 'lighting.ambient': 0.3 })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('treats a resolver failure as a miss with a plain note', async () => {
    const resolve = vi.fn(async () => { throw new Error('down') })
    const { patch, notes } = await resolveTexturePatches({ 'object.material.texture': 'wood' }, resolve)
    expect(patch).toEqual({})
    expect(notes[0]).toMatch(/texture library/i)
  })
})
