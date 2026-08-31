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
})
