// @vitest-environment happy-dom
/**
 * The Actions panel, mounted over the committed node catalogue (Task R4.1 fix
 * round 1): the retired partner nodes (shared/runner/retired.ts) never show,
 * whatever the search, and there is no Legacy toggle to bring them back. A
 * Comfy-billed provider a live engine may list is never offered either.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import GeneratorsPanel from '~/components/vue-canvas/GeneratorsPanel.vue'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/assets/nodeCatalog.json.gz'))).toString('utf8')) as Record<string, any>
/** A Comfy-billed partner node a newer engine might list (not in the committed catalogue). */
const LIVE = { ...CATALOG, ZetaPartnerNode: { display_name: 'Zeta partner image', description: '', category: 'api node/image/Zeta', python_module: 'comfy_api_nodes.nodes_zeta' } }

const g = globalThis as any
const saved = g.fetch
let w: VueWrapper
beforeAll(async () => {
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => LIVE }))
  w = mount(GeneratorsPanel as any, { props: {}, attachTo: document.body })
  await flushPromises()
})
afterAll(() => { w.unmount(); g.fetch = saved })

async function search(q: string): Promise<string> {
  await w.find('input').setValue(q)
  return w.text()
}

describe('the Actions panel offers no retired node', () => {
  it('loaded the catalogue and shows a Replicate action', async () => {
    expect(w.text()).not.toContain('Loading actions')
    expect(await search('FluxLoRARemoteNode')).not.toContain('No actions match')
  })

  it('a retired node is found by no search: its class, its name or its provider', async () => {
    for (const q of ['KlingImage2VideoNode', 'Kling Image(First Frame) to Video', 'Kling', 'Recraft', 'Tripo', 'ElevenLabs']) {
      expect(await search(q), q).toContain('No actions match')
    }
  })

  it('a Comfy-billed provider the engine lists later is not offered either', async () => {
    expect(await search('Zeta')).toContain('No actions match')
  })

  it('has no Legacy toggle', async () => {
    await search('')
    const buttons = w.findAll('button').map(b => `${b.text()} ${b.attributes('title') ?? ''}`)
    expect(buttons.filter(t => /legacy/i.test(t))).toEqual([])
    expect(w.text()).not.toMatch(/legacy/i)
  })
})
