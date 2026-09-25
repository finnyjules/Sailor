import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMyEffects } from '~/composables/useMyEffects'
import { myEffectRecords, myEffectsLoaded } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const t1 = SPIKE_TAKES.rain![2]!, t2 = SPIKE_TAKES.rain![0]!
function setup() {
  const api = {
    listMyEffects: vi.fn(async () => []),
    putMyEffect: vi.fn(async (r: any) => ({ ...r, updatedAt: 'saved' })),
    renameMyEffect: vi.fn(async (id: string, name: string) => ({ ...myEffectRecords.value.find(r => r.id === id)!, name })),
    deleteMyEffect: vi.fn(async () => {}),
  }
  const register = vi.fn()
  const my = useMyEffects({ api: api as any, register, now: () => 'now', newId: () => 'mine_aaaaaaaaaaaa' })
  return { my, api, register }
}

describe('useMyEffects', () => {
  beforeEach(() => { myEffectRecords.value = []; myEffectsLoaded.value = true })

  it('saveTake stores v1 and registers its definitions', async () => {
    const { my, api, register } = setup()
    const r = await my.saveTake(t1, { request: 'rain on a window', from: 'Water ripple' })
    expect(api.putMyEffect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine_aaaaaaaaaaaa', from: 'Water ripple' }))
    expect(r.updatedAt).toBe('saved')
    expect(myEffectRecords.value.map(x => x.id)).toEqual(['mine_aaaaaaaaaaaa'])
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa'])
  })

  it('a failed save leaves the library and the catalog untouched', async () => {
    const { my, api, register } = setup()
    api.putMyEffect.mockRejectedValueOnce(new Error('500'))
    await expect(my.saveTake(t1, { request: 'rain', from: null })).rejects.toThrow('500')
    expect(myEffectRecords.value).toEqual([])
    expect(register).not.toHaveBeenCalled()
  })

  it('addCodeVersion appends a version and re-registers both code versions', async () => {
    const { my, register } = setup()
    await my.saveTake(t1, { request: 'rain', from: null })
    const r = await my.addCodeVersion('mine_aaaaaaaaaaaa', t2, 'heavier')
    expect(r.versions.map(v => v.label)).toEqual(['v1', 'v2'])
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa~v2', 'mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa'])
  })

  it('addValuesVersion is a no-op when nothing changed, and a version when a dial moved', async () => {
    const { my, api } = setup()
    const r = await my.saveTake(t1, { request: 'rain', from: null })
    api.putMyEffect.mockClear()
    expect(await my.addValuesVersion(r.id, { ...r.versions[0]!.values }, 'same')).toBeNull()
    expect(api.putMyEffect).not.toHaveBeenCalled()
    const [k, v] = Object.entries(r.versions[0]!.values).find(([, x]) => typeof x === 'number')!
    const next = await my.addValuesVersion(r.id, { [k]: (v as number) + 0.1 }, 'brighter')
    expect(next!.versions.map(x => x.label)).toEqual(['v1', 'v2'])
    expect(api.putMyEffect).toHaveBeenCalledTimes(1)
  })

  it('versioning an effect that is no longer in My effects says so', async () => {
    const { my } = setup()
    await expect(my.addCodeVersion('mine_zzzzzzzzzzzz', t2, 'x')).rejects.toThrow('My effects')
  })

  it('rename trims the name, stores the server’s record and re-registers it', async () => {
    const { my, api, register } = setup()
    await my.saveTake(t1, { request: 'rain', from: null })
    const r = await my.rename('mine_aaaaaaaaaaaa', '  Rain   on glass ')
    expect(api.renameMyEffect).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', 'Rain on glass')
    expect(myEffectRecords.value[0]!.name).toBe('Rain on glass')
    expect(register.mock.calls.at(-1)![0][0].name).toBe('Rain on glass')
    expect(r.name).toBe('Rain on glass')
  })

  it('remove deletes on the server and from the library, but leaves the definitions for projects that use it', async () => {
    const { my, api } = setup()
    const catalog = await import('~/lib/shaderfx/catalog')
    const unregister = vi.spyOn(catalog, 'unregisterEffects')
    await my.saveTake(t1, { request: 'rain', from: null })
    await my.remove('mine_aaaaaaaaaaaa')
    expect(api.deleteMyEffect).toHaveBeenCalledWith('mine_aaaaaaaaaaaa')
    expect(myEffectRecords.value).toEqual([])
    expect(unregister).not.toHaveBeenCalled() // pickers hide it via the library; open projects keep rendering
    unregister.mockRestore()
  })

  it('adopt registers project copies; the library copy wins when it has as many versions', async () => {
    const { my, register } = setup()
    const lib = await my.saveTake(t1, { request: 'rain', from: null })
    register.mockClear()
    my.adopt([{ ...lib, name: 'Old name' }])
    expect(register).not.toHaveBeenCalled()
    my.adopt([{ ...lib, id: 'mine_bbbbbbbbbbbb', name: 'From a shared project' }])
    expect(register.mock.calls[0]![0][0].name).toBe('From a shared project')
    expect(myEffectRecords.value.map(r => r.id)).toEqual(['mine_aaaaaaaaaaaa']) // never written into the library
  })

  it('load forces a fresh list', async () => {
    const { my, api } = setup()
    await my.load(); await my.load()
    expect(api.listMyEffects).toHaveBeenCalledTimes(2)
  })

  it('a dial version is added only for the newest code version, and only to an effect in the library', async () => {
    const { my, api } = setup()
    const r = await my.saveTake(t1, { request: 'rain', from: null })
    await my.addCodeVersion(r.id, t2, 'heavier')
    api.putMyEffect.mockClear()
    const [k, v] = Object.entries(r.versions[0]!.values).find(([, x]) => typeof x === 'number')!
    // Pinned to the old code: its dials would bind to the wrong code.
    expect(await my.addValuesVersion(`${r.id}~v1`, { [k]: (v as number) + 0.1 }, 'x')).toBeNull()
    expect(await my.addValuesVersion(r.id, { [k]: (v as number) + 0.1 }, 'x')).toBeNull() // bare = v1
    // A shared project's copy (not in the library) has nothing to add to.
    expect(await my.addValuesVersion('mine_zzzzzzzzzzzz~v1', { [k]: 1 }, 'x')).toBeNull()
    expect(api.putMyEffect).not.toHaveBeenCalled()
    const [k2, v2] = Object.entries(myEffectRecords.value[0]!.versions[1]!.values).find(([, x]) => typeof x === 'number')!
    const next = await my.addValuesVersion(`${r.id}~v2`, { [k2]: (v2 as number) + 0.1 }, 'brighter')
    expect(next!.versions.map(x => x.label)).toEqual(['v1', 'v2', 'v3'])
  })

  it('ready retries a library that has not loaded; has reads the loaded library', async () => {
    const { my, api } = setup()
    myEffectsLoaded.value = false
    // The page's own load failed (a cold start, a timeout): the library stays "not loaded".
    api.listMyEffects.mockRejectedValueOnce(new Error('down'))
    await expect(my.load()).rejects.toThrow()
    api.listMyEffects.mockRejectedValueOnce(new Error('down'))
    await my.ready() // retries, and never throws
    expect(api.listMyEffects).toHaveBeenCalledTimes(2)
    expect(my.has('mine_aaaaaaaaaaaa')).toBe(false)
    api.listMyEffects.mockResolvedValueOnce([{ id: 'mine_aaaaaaaaaaaa', name: 'Rain', versions: [] }] as any)
    await my.ready()
    expect(api.listMyEffects).toHaveBeenCalledTimes(3)
    expect(myEffectsLoaded.value).toBe(true)
    expect(my.has('mine_aaaaaaaaaaaa')).toBe(true)
    await my.ready() // loaded: no further call
    expect(api.listMyEffects).toHaveBeenCalledTimes(3)
  })

  it('adopt runs every code version through the static check and skips a record that fails (final review #5)', async () => {
    const { my, register } = setup()
    const { recordFromTake, withCodeVersion } = await import('~/lib/myEffects/defs')
    const ok = recordFromTake(t1, { id: 'mine_bbbbbbbbbbbb', request: 'r', from: null, now: 'x' })
    // A second code version with an unbounded loop: it would hang the graphics card when rendered.
    const looping = withCodeVersion({ ...ok, id: 'mine_cccccccccccc' }, { ...t2, body: t2.body.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void main() {\n  float k = 0.0;\n  while (k >= 0.0) { k += 1.0; }') }, { request: 'r2', now: 'y' })
    const { staticCheck } = await import('~/lib/shadergen/staticCheck')
    expect(staticCheck({ ...t2, body: looping.versions[1]!.body! }).ok).toBe(false)
    my.adopt([looping, ok])
    const ids = register.mock.calls.flatMap(c => c[0].map((d: any) => d.id))
    expect(ids).toContain('mine_bbbbbbbbbbbb~v1')
    expect(ids.some((id: string) => id.startsWith('mine_cccccccccccc'))).toBe(false)
  })
})
