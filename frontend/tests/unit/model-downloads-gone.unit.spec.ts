// @vitest-environment happy-dom
/**
 * Step 3, R10.5: model downloads go. Settings → Models, the Toolbox's
 * download gate, useModelDownloads and the /sailor/models routes are deleted;
 * adding a node never downloads anything. The depth model is the only model
 * left, and it fills its own folder (depth-model-fill.unit.spec.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const addNode = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useNodeSearch', () => ({ useNodeSearch: () => ({ addNode }) }))

import ToolboxPanel from '~/components/vue-canvas/ToolboxPanel.vue'
import { TOOLBOX_SECTIONS } from '~/data/toolbox-items'

const ROOT = join(__dirname, '..', '..')

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else if (/\.(ts|vue|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}

describe('model downloads go (R10.5)', () => {
  it('nothing in the app, server or shared code names models/status or models/download', () => {
    const hits: string[] = []
    for (const top of ['app', 'server', 'shared']) {
      for (const f of filesUnder(join(ROOT, top))) {
        const rel = relative(ROOT, f)
        if (/models\/(status|download)/.test(readFileSync(f, 'utf8'))) hits.push(rel)
      }
    }
    expect(hits).toEqual([])
  })

  it('the panel, the composable and the native route are deleted', () => {
    for (const f of ['app/components/ModelBundlesPanel.vue', 'app/composables/useModelDownloads.ts', 'server/native/modelBundles.ts']) {
      expect(existsSync(join(ROOT, f)), f).toBe(false)
    }
    const settings = readFileSync(join(ROOT, 'app/components/SettingsModal.vue'), 'utf8')
    expect(settings).not.toMatch(/ModelBundlesPanel|id: 'models'/)
  })

  it('no Toolbox item asks for a model download', () => {
    expect(readFileSync(join(ROOT, 'app/data/toolbox-items.ts'), 'utf8')).not.toMatch(/requiresModels|ModelBundleKey/)
    for (const s of TOOLBOX_SECTIONS) {
      for (const item of s.items) {
        expect(Object.keys(item), item.nodeType).not.toContain('requiresModels')
        expect(item.description, item.nodeType).not.toMatch(/Downloads ~/)
      }
    }
  })

  it('the Toolbox adds a node at once, with no download and no request', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no request expected')))
    vi.stubGlobal('fetch', fetch)
    const w = mount(ToolboxPanel, { attachTo: document.body })
    // Nodes that used to wait on a model bundle (depth, upscale, object removal).
    for (const nodeType of ['LensBlur', 'UpscaleImage', 'ObjectRemove']) {
      addNode.mockClear()
      await w.get('input').setValue(nodeType)
      const card = w.findAll('button[draggable="true"]').find(b => b.attributes('title') === 'Click to add, or drag onto the canvas')
      expect(card, nodeType).toBeTruthy()
      await card!.trigger('click')
      // Synchronous: nothing awaited before the node is added.
      expect(addNode).toHaveBeenCalledWith(nodeType)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/Installing|downloaded/)
    w.unmount()
    vi.unstubAllGlobals()
  })
})
