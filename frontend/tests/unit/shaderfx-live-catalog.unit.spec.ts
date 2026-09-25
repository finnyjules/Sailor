import { describe, it, expect, vi, beforeEach } from 'vitest'

const builtIns = { version: 3, effects: [{ id: 'water_ripple', name: 'Water ripple', category: 'distortion', animated: false, passes: 1, centerParam: null, textures: [], params: [], source: 'x' }] }
;(globalThis as any).$fetch = vi.fn(async (url: string) => {
  if (url === '/sailor/shader_effects') return builtIns
  if (url === '/api/my-effects') return { effects: [] }
  throw new Error(url)
})

describe('one live catalog', () => {
  beforeEach(() => vi.resetModules())

  it('merges My effects into the fetched catalog and the sync store', async () => {
    const { SPIKE_TAKES } = await import('~/lib/shadergen/__eval__/spikeTakes')
    const { recordFromTake } = await import('~/lib/myEffects/defs')
    const rec = recordFromTake(SPIKE_TAKES.rain![2]!, { id: 'mine_aaaaaaaaaaaa', request: 'rain', from: null, now: 'x' })
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [rec] } : builtIns))
    const cat = await (await import('~/lib/shaderfx/catalog')).fetchShaderFxCatalog()
    expect(cat.effects.map(e => e.id)).toEqual(['water_ripple', 'mine_aaaaaaaaaaaa'])
    const store = await import('~/lib/shaderfx/catalogStore')
    expect(store.getEffectSync('mine_aaaaaaaaaaaa')?.mine).toBe(true)
    const lib = await import('~/lib/myEffects/library')
    expect(lib.myEffectsLoaded.value).toBe(true)
    expect(lib.myEffectRecordById('mine_aaaaaaaaaaaa')?.id).toBe('mine_aaaaaaaaaaaa')
  })

  it('a My effects failure never blocks the built-ins', async () => {
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => { if (url === '/api/my-effects') throw new Error('405'); return builtIns })
    const cat = await (await import('~/lib/shaderfx/catalog')).fetchShaderFxCatalog()
    expect(cat.effects.map(e => e.id)).toEqual(['water_ripple'])
    expect((await import('~/lib/myEffects/library')).myEffectsLoaded.value).toBe(false)
  })

  it('registerEffects replaces by id and publishes a NEW catalog object; unregister removes', async () => {
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [] } : builtIns))
    const c = await import('~/lib/shaderfx/catalog')
    const live = c.useShaderCatalog()
    await c.fetchShaderFxCatalog()
    const before = live.value
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'draft_1_0', name: 'Take', draft: true } as any])
    expect(live.value).not.toBe(before)
    expect(live.value!.effects.some(e => e.id === 'draft_1_0')).toBe(true)
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'draft_1_0', name: 'Take (new)', draft: true } as any])
    expect(live.value!.effects.filter(e => e.id === 'draft_1_0').map(e => e.name)).toEqual(['Take (new)'])
    const mid = live.value
    c.unregisterEffects(['draft_1_0'])
    expect(live.value).not.toBe(mid)
    expect(live.value!.effects.some(e => e.id === 'draft_1_0')).toBe(false)
    expect((await import('~/lib/shaderfx/catalogStore')).getEffectSync('draft_1_0')).toBeNull()
  })

  it('effects registered before the fetch resolves survive it', async () => {
    const c = await import('~/lib/shaderfx/catalog')
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'mine_bbbbbbbbbbbb', mine: true } as any])
    const cat = await c.fetchShaderFxCatalog()
    expect(cat.effects.some(e => e.id === 'mine_bbbbbbbbbbbb')).toBe(true)
  })

  it('effects registered after the load survive a forced refetch (the render path’s self-heal)', async () => {
    const c = await import('~/lib/shaderfx/catalog')
    await c.fetchShaderFxCatalog()
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'draft_2_0', draft: true } as any])
    const again = await c.fetchShaderFxCatalog(true)
    expect(again.effects.some(e => e.id === 'draft_2_0')).toBe(true)
    c.unregisterEffects(['draft_2_0'])
    const third = await c.fetchShaderFxCatalog(true)
    expect(third.effects.some(e => e.id === 'draft_2_0')).toBe(false)
  })
})
