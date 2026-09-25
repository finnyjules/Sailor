import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetchObjectInfo: a non-forced call while a fetch is in flight shares it
// (the start modal's build must not wait out a second multi-MB /object_info).
describe('fetchObjectInfo', () => {
  beforeEach(() => { vi.resetModules() })

  it('a caller arriving mid-fetch shares the in-flight request', async () => {
    let release!: (v: any) => void
    const $fetch = vi.fn(() => new Promise(r => { release = r }))
    vi.stubGlobal('$fetch', $fetch)
    const { fetchObjectInfo } = await import('../../app/composables/useVueNodes')
    const a = fetchObjectInfo()
    const b = fetchObjectInfo()
    expect($fetch).toHaveBeenCalledTimes(1)
    release({ Compositor: { input: {} } })
    expect(await a).toEqual({ Compositor: { input: {} } })
    expect(await b).toEqual({ Compositor: { input: {} } })
    // Cached afterwards; a forced call still goes to the network.
    await fetchObjectInfo()
    expect($fetch).toHaveBeenCalledTimes(1)
    const c = fetchObjectInfo(true)
    expect($fetch).toHaveBeenCalledTimes(2)
    release({})
    await c
  })

  it('a failed fetch does not wedge later calls', async () => {
    const $fetch = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ X: {} })
    vi.stubGlobal('$fetch', $fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fetchObjectInfo } = await import('../../app/composables/useVueNodes')
    expect(await fetchObjectInfo()).toEqual({})
    expect(await fetchObjectInfo()).toEqual({ X: {} })
    expect($fetch).toHaveBeenCalledTimes(2)
  })
})
