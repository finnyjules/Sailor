import { describe, it, expect, vi, beforeEach } from 'vitest'

const builtIns = { version: 3, effects: [{ id: 'water_ripple', name: 'Water ripple', category: 'distortion', animated: false, passes: 1, centerParam: null, textures: [], params: [], source: 'x' }] }
;(globalThis as any).$fetch = vi.fn(async (url: string) => {
  if (url === '/sailor/shader_effects') return builtIns
  if (url === '/api/my-effects') return { effects: [] }
  throw new Error(url)
})

describe('one live catalog', () => {
  beforeEach(() => vi.resetModules())

  it('merges My effects into the live catalog and the sync store when the library lands', async () => {
    const { SPIKE_TAKES } = await import('~/lib/shadergen/__eval__/spikeTakes')
    const { recordFromTake } = await import('~/lib/myEffects/defs')
    const rec = recordFromTake(SPIKE_TAKES.rain![2]!, { id: 'mine_aaaaaaaaaaaa', request: 'rain', from: null, now: 'x' })
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [rec] } : builtIns))
    const c = await import('~/lib/shaderfx/catalog')
    const live = c.useShaderCatalog()
    await c.fetchShaderFxCatalog()
    const lib = await import('~/lib/myEffects/library')
    await lib.loadMyEffectRecords()
    expect(live.value!.effects.map(e => e.id)).toEqual(['water_ripple', 'mine_aaaaaaaaaaaa'])
    const store = await import('~/lib/shaderfx/catalogStore')
    expect(store.getEffectSync('mine_aaaaaaaaaaaa')?.mine).toBe(true)
    expect(lib.myEffectsLoaded.value).toBe(true)
    expect(lib.myEffectRecordById('mine_aaaaaaaaaaaa')?.id).toBe('mine_aaaaaaaaaaaa')
  })

  it('a My effects list that never answers holds up nothing: built-ins publish and render', async () => {
    ;(globalThis as any).$fetch.mockImplementation((url: string) => (url === '/api/my-effects' ? new Promise(() => {}) : Promise.resolve(builtIns)))
    const c = await import('~/lib/shaderfx/catalog')
    const live = c.useShaderCatalog()
    const cat = await c.fetchShaderFxCatalog()
    expect(cat.effects.map(e => e.id)).toEqual(['water_ripple'])
    expect(live.value!.effects.map(e => e.id)).toEqual(['water_ripple'])
    expect((await c.getEffect('water_ripple'))?.id).toBe('water_ripple')
    expect((await import('~/lib/myEffects/library')).myEffectsLoaded.value).toBe(false)
  })

  it('a library load that times out stays "not loaded", in plain words, and the next call retries', async () => {
    const lib = await import('~/lib/myEffects/library')
    await expect(lib.loadMyEffectRecords({ listMyEffects: () => new Promise(() => {}) }, false, 5))
      .rejects.toThrow('My effects couldn’t be reached. Try again in a moment.')
    expect(lib.myEffectsLoaded.value).toBe(false)
    const again = await lib.loadMyEffectRecords({ listMyEffects: async () => [] }, false, 5)
    expect(again).toEqual([])
    expect(lib.myEffectsLoaded.value).toBe(true)
    expect(lib.MY_EFFECTS_LOAD_TIMEOUT_MS).toBe(8000)
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

  it('no registered effect can replace or remove a built-in', async () => {
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [] } : builtIns))
    const c = await import('~/lib/shaderfx/catalog')
    const store = await import('~/lib/shaderfx/catalogStore')
    await c.fetchShaderFxCatalog()
    c.registerEffects([{ ...builtIns.effects[0]!, name: 'Hijacked', source: 'evil' } as any])
    expect(store.getEffectSync('water_ripple')?.name).toBe('Water ripple')
    c.unregisterEffects(['water_ripple'])
    expect(store.getEffectSync('water_ripple')?.name).toBe('Water ripple')
    // registered before the built-ins were known: still dropped once they are
    vi.resetModules()
    const c2 = await import('~/lib/shaderfx/catalog')
    c2.registerEffects([{ ...builtIns.effects[0]!, name: 'Early hijack' } as any])
    await c2.fetchShaderFxCatalog()
    expect((await import('~/lib/shaderfx/catalogStore')).getEffectSync('water_ripple')?.name).toBe('Water ripple')
  })
})

describe('a project copy and the library copy of one My effect (plan ruling 17)', () => {
  beforeEach(() => vi.resetModules())

  async function recs() {
    const { SPIKE_TAKES } = await import('~/lib/shadergen/__eval__/spikeTakes')
    const { recordFromTake, withCodeVersion } = await import('~/lib/myEffects/defs')
    const one = recordFromTake(SPIKE_TAKES.rain![2]!, { id: 'mine_aaaaaaaaaaaa', request: 'rain', from: null, now: 'x' })
    const two = withCodeVersion(one, SPIKE_TAKES.rain![0]!, { request: 'heavier', now: 'y' })
    return { one, two }
  }
  /** $fetch whose /api/my-effects answer is held until `release` is called. */
  function heldLibrary(effects: unknown[]) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => {
      if (url === '/api/my-effects') { await gate; return { effects } }
      return builtIns
    })
    return () => release()
  }
  const nameOf = async (id: string) => (await import('~/lib/shaderfx/catalogStore')).getEffectSync(id)?.name

  it('adopt, then the library loads: the library wins when it has as many versions or more', async () => {
    const { one, two } = await recs()
    const release = heldLibrary([{ ...two, name: 'Library copy' }])
    const c = await import('~/lib/shaderfx/catalog')
    const { useMyEffects } = await import('~/composables/useMyEffects')
    useMyEffects().adopt([{ ...one, name: 'Project copy' }])
    await c.fetchShaderFxCatalog()
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Project copy') // renders before the library lands
    release()
    await (await import('~/lib/myEffects/library')).loadMyEffectRecords()
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Library copy')
    expect(c.useShaderCatalog().value!.effects.filter(e => e.id === 'mine_aaaaaaaaaaaa').map(e => e.name)).toEqual(['Library copy'])
    // …and it stays that way through the render path's forced refetch
    await c.fetchShaderFxCatalog(true)
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Library copy')
  })

  it('adopt, then the library loads: a project copy with MORE versions stands', async () => {
    const { one, two } = await recs()
    const release = heldLibrary([{ ...one, name: 'Library copy' }])
    const c = await import('~/lib/shaderfx/catalog')
    const { useMyEffects } = await import('~/composables/useMyEffects')
    useMyEffects().adopt([{ ...two, name: 'Project copy' }])
    await c.fetchShaderFxCatalog()
    release()
    await (await import('~/lib/myEffects/library')).loadMyEffectRecords()
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Project copy')
    expect(await nameOf('mine_aaaaaaaaaaaa~v1')).toBeTruthy()
  })

  it('the library loads, then adopt: the same rule, both ways', async () => {
    const { one, two } = await recs()
    const release = heldLibrary([{ ...two, name: 'Library copy' }])
    release()
    const c = await import('~/lib/shaderfx/catalog')
    await c.fetchShaderFxCatalog()
    await (await import('~/lib/myEffects/library')).loadMyEffectRecords()
    const { useMyEffects } = await import('~/composables/useMyEffects')
    useMyEffects().adopt([{ ...one, name: 'Older project copy' }])
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Library copy')
    const three = { ...two, name: 'Newer project copy', versions: [...two.versions, { ...two.versions[1]!, label: 'v3' }] }
    useMyEffects().adopt([three])
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBe('Newer project copy')
  })

  it('adopt skips a malformed copy (a project doc is untrusted)', async () => {
    const { one } = await recs()
    heldLibrary([])
    const c = await import('~/lib/shaderfx/catalog')
    await c.fetchShaderFxCatalog()
    const { useMyEffects } = await import('~/composables/useMyEffects')
    useMyEffects().adopt([{ ...one, id: 'water_ripple' } as any, { ...one, versions: [] } as any])
    expect(await nameOf('water_ripple')).toBe('Water ripple')
    expect(await nameOf('mine_aaaaaaaaaaaa')).toBeUndefined()
  })
})
