import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMyEffects } from '~/composables/useMyEffects'
import { myEffectRecords } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const t1 = SPIKE_TAKES.rain![2]!, t2 = SPIKE_TAKES.rain![0]!
function setup() {
  const api = {
    listMyEffects: vi.fn(async () => []),
    putMyEffect: vi.fn(async (r: any) => ({ ...r, updatedAt: 'saved' })),
    renameMyEffect: vi.fn(async (id: string, name: string) => ({ ...myEffectRecords.value.find(r => r.id === id)!, name })),
    deleteMyEffect: vi.fn(async () => {}),
  }
  const register = vi.fn(), unregister = vi.fn()
  const my = useMyEffects({ api: api as any, register, unregister, now: () => 'now', newId: () => 'mine_aaaaaaaaaaaa' })
  return { my, api, register, unregister }
}

describe('useMyEffects', () => {
  beforeEach(() => { myEffectRecords.value = [] })

  it('saveTake stores v1 and registers its definitions', async () => {
    const { my, api, register } = setup()
    const r = await my.saveTake(t1, { request: 'rain on a window', from: 'Water ripple' })
    expect(api.putMyEffect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine_aaaaaaaaaaaa', from: 'Water ripple' }))
    expect(r.updatedAt).toBe('saved')
    expect(myEffectRecords.value.map(x => x.id)).toEqual(['mine_aaaaaaaaaaaa'])
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa'])
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
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa', 'mine_aaaaaaaaaaaa~v1'])
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
    const { my, api, unregister } = setup()
    await my.saveTake(t1, { request: 'rain', from: null })
    await my.remove('mine_aaaaaaaaaaaa')
    expect(api.deleteMyEffect).toHaveBeenCalledWith('mine_aaaaaaaaaaaa')
    expect(myEffectRecords.value).toEqual([])
    expect(unregister).not.toHaveBeenCalled() // pickers hide it via the library; open projects keep rendering
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
})
