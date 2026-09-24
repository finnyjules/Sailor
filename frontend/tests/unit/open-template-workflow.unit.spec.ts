import { describe, it, expect, vi } from 'vitest'
import { openTemplateWorkflow } from '../../app/lib/openTemplateWorkflow'

const graph = { nodes: [{ id: 1 }], links: [] }

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('openTemplateWorkflow', () => {
  it('fetches the graph, then opens a tab and loads the graph into it', async () => {
    const calls: string[] = []
    const fetchJson = vi.fn(async (url: string) => { calls.push(`fetch ${url}`); return okResponse(graph) })
    const openTab = vi.fn((opts: { type: 'project'; label: string }) => { calls.push(`open ${opts.label}`); return { id: 't1' } })
    const loadIntoTab = vi.fn((tabId: string, wf: unknown) => { calls.push(`load ${tabId}`); expect(wf).toEqual(graph) })

    const tabId = await openTemplateWorkflow({ slug: 'image_z_image', title: 'Z Image' }, { fetch: fetchJson, openTab, loadIntoTab })

    expect(tabId).toBe('t1')
    // Order matters: the tab must not open before the graph is in hand, or the
    // blank-project picker fires over a tab whose graph is still loading.
    expect(calls).toEqual([
      'fetch /api/community-workflow?slug=image_z_image',
      'open Z Image',
      'load t1',
    ])
  })

  it('opens no tab when the graph cannot be fetched, and surfaces the server message', async () => {
    const fetchJson = vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({ message: "This workflow's graph isn't available from comfy.org." }),
    }) as unknown as Response)
    const openTab = vi.fn()
    const loadIntoTab = vi.fn()

    await expect(openTemplateWorkflow({ slug: 'missing', title: 'Missing' }, { fetch: fetchJson, openTab, loadIntoTab }))
      .rejects.toThrow("This workflow's graph isn't available from comfy.org.")
    expect(openTab).not.toHaveBeenCalled()
    expect(loadIntoTab).not.toHaveBeenCalled()
  })

  it('falls back to a status message when the error body is not JSON', async () => {
    const fetchJson = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new Error('not json') },
    }) as unknown as Response)

    await expect(openTemplateWorkflow({ slug: 'x', title: 'X' }, { fetch: fetchJson, openTab: vi.fn(), loadIntoTab: vi.fn() }))
      .rejects.toThrow('Failed to load workflow (502)')
  })

  it('encodes the slug in the request URL', async () => {
    const fetchJson = vi.fn(async () => okResponse(graph))
    await openTemplateWorkflow({ slug: 'a b', title: 'T' }, { fetch: fetchJson, openTab: () => ({ id: 't' }), loadIntoTab: vi.fn() })
    expect(fetchJson).toHaveBeenCalledWith('/api/community-workflow?slug=a%20b')
  })
})
