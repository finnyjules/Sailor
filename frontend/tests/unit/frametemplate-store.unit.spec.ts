import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTemplateLibrary } from '../../app/composables/useTemplateLibrary'

describe('useTemplateLibrary', () => {
  beforeEach(() => { vi.restoreAllMocks(); useTemplateLibrary()._clearForTests() })
  it('optimistically upserts on save and calls PUT /api/frame-templates/:id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const lib = useTemplateLibrary()
    await lib.save({ id: 't1', name: 'Lower third', version: 1 } as any)
    expect(lib.templates.value.find(t => t.id === 't1')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/frame-templates/t1', expect.objectContaining({ method: 'PUT' }))
  })
  it('removes optimistically and calls DELETE', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const lib = useTemplateLibrary()
    await lib.save({ id: 't1', name: 'x', version: 1 } as any)
    await lib.remove('t1')
    expect(lib.templates.value.find(t => t.id === 't1')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/frame-templates/t1', expect.objectContaining({ method: 'DELETE' }))
  })
  it('rolls back the optimistic entry when save() hits a network-level fetch rejection', async () => {
    // Construct the library first with a persistent resolved mock so the
    // module's own fire-and-forget initial refresh() (triggered inside
    // useTemplateLibrary()) doesn't eat into the one-shot mocks below.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ templates: [] }), { status: 200 }))
    const lib = useTemplateLibrary()
    await new Promise(resolve => setTimeout(resolve, 0)) // let that initial refresh() settle

    fetchMock.mockReset()
    fetchMock
      .mockRejectedValueOnce(new Error('offline')) // save()'s PUT rejects at the network level
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: [] }), { status: 200 })) // rollback GET from refresh()

    await lib.save({ id: 't1', name: 'Lower third', version: 1 } as any)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/frame-templates/t1', expect.objectContaining({ method: 'PUT' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/frame-templates')
    // The optimistic entry must be rolled back once refresh() returns server truth.
    expect(lib.templates.value.find(t => t.id === 't1')).toBeUndefined()
  })
})
