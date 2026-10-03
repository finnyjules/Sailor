/**
 * Step 4, C6: Sailor offers no blueprint and serves no blueprint list.
 *
 *   - Every blueprint in ComfyUI's `blueprints/` folder was built from classes
 *     Sailor doesn't run (the local diffusion stack, GLSL shaders, Comfy's own
 *     partner nodes), so none is kept (the folder left the repo in C7): `/global_subgraphs` and its module
 *     (server/native/globalSubgraphs.ts) are gone, and the path is a plain 404
 *     here and hosted (engine-path-alias.unit.spec.ts).
 *   - Sailor offers only the classes the runner takes, plus the cards: node
 *     search lists nothing else, and the sidebar has no blueprint tab or
 *     section.
 *
 * (Step 3, R10.6 served the list natively; step 4, C5 stopped offering it.)
 */
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_ENGINE_PREFIXES } from '../../server/native/router'
import { hostedEngineDecision, normalizeEnginePath } from '../../server/utils/enginePath'
import { isCustomClass } from '#shared/runner/needsEngine'
import { isStockClass } from '#shared/runner/stockClasses'
import { isRetiredClass } from '#shared/runner/retired'
import { sailorOffersClass } from '#shared/runner/offer'

const FRONTEND = path.resolve(__dirname, '..', '..')
const REPO = path.resolve(FRONTEND, '..')
const CATALOG: Record<string, any> = JSON.parse(gunzipSync(fs.readFileSync(path.join(FRONTEND, 'server', 'assets', 'nodeCatalog.json.gz'))).toString('utf8'))
const BLUEPRINTS = path.join(REPO, 'blueprints')
describe('C6: no blueprint is kept, so the blueprint list is gone', () => {
  it('the blueprints folder is gone (C7): every blueprint held a class Sailor doesn’t run', () => {
    // Each of ComfyUI's blueprints was built from classes Sailor doesn't run
    // (checked here until C7 removed the folder from the repo).
    expect(fs.existsSync(BLUEPRINTS)).toBe(false)
  })

  it('the module and the native route are gone; the path is a plain 404 hosted, in every spelling', () => {
    expect(fs.existsSync(path.join(FRONTEND, 'server', 'native', 'globalSubgraphs.ts'))).toBe(false)
    expect(NATIVE_ENGINE_PREFIXES).not.toContain('/global_subgraphs')
    for (const p of ['/global_subgraphs', '/api/global_subgraphs', '/comfyui/global_subgraphs', '/global_subgraphs/abc']) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'GET'), p).toEqual({ kind: 'notFound' })
    }
  })
})

describe('R10.6, C5: Sailor offers no stock class or blueprint, here or hosted', () => {
  it('sailorOffersClass: the runner’s classes and the cards; never a stock, retired or custom class', () => {
    const offered = Object.keys(CATALOG).filter(sailorOffersClass)
    expect(offered.length).toBeGreaterThan(200)
    for (const c of offered) {
      expect(isStockClass(c), c).toBe(false)
      expect(isRetiredClass(c), c).toBe(false)
      expect(isCustomClass(c), c).toBe(false)
    }
    // Step 4, C4: Preview video is the runner's now; Font Playground, Kinetic Typography and the per-model nodes are retired.
    for (const c of ['GenerateImageNode', 'GenerateVideoNode', 'Image', 'Video', 'SaveImage', 'FilmShotNode', 'SmartLayout', 'Text', 'Timeline', 'PreviewVideo']) {
      expect(sailorOffersClass(c), c).toBe(true)
    }
    for (const c of ['KSampler', 'CheckpointLoaderSimple', 'GLSLShader', 'RenderType', 'KineticType', 'FluxProRemoteNode', 'MyCustomPackNode', 'GeminiNode']) {
      expect(sailorOffersClass(c), c).toBe(false)
    }
    // Every catalogue class is offered, or is a stock or retired class Sailor refuses.
    for (const c of Object.keys(CATALOG)) {
      if (sailorOffersClass(c)) continue
      expect(isStockClass(c) || isRetiredClass(c), c).toBe(true)
    }
  })

  describe('node search', () => {
    const g = globalThis as any
    let saved: { fetch: unknown, config: unknown }
    beforeEach(() => {
      saved = { fetch: g.$fetch, config: g.useRuntimeConfig }
      vi.resetModules()
      // A served catalogue that also lists stock and custom classes (an old saved copy) offers none of them.
      g.$fetch = vi.fn(async () => ({
        ...CATALOG,
        LoraLoader: { display_name: 'Load LoRA', category: 'loaders', python_module: 'nodes', input: {}, output: [] },
        MyCustomPackNode: { display_name: 'My custom', category: 'custom', python_module: 'custom_nodes.pack', input: {}, output: [] },
      }))
    })
    afterEach(() => { g.$fetch = saved.fetch; g.useRuntimeConfig = saved.config })

    async function searched(hosted: boolean): Promise<string[]> {
      g.useRuntimeConfig = () => ({ public: { hostedMode: hosted } })
      const { useNodeSearch } = await import('~/composables/useNodeSearch')
      const s = useNodeSearch()
      await s.fetchNodeTypes()
      return s.nodeTypes.value.map((n: { name: string }) => n.name)
    }

    it('node search lists only the classes the runner takes, plus the cards, here and hosted', async () => {
      for (const hosted of [true, false]) {
        const names = await searched(hosted)
        expect(names.length).toBeGreaterThan(200)
        expect(names.filter(n => !sailorOffersClass(n))).toEqual([])
        expect(names).toEqual(expect.arrayContaining(['GenerateImageNode', 'SaveImage', 'Timeline']))
        for (const c of ['KSampler', 'CheckpointLoaderSimple', 'LoraLoader', 'MyCustomPackNode']) expect(names, `${hosted}: ${c}`).not.toContain(c)
      }
    })
  })

  it('the sidebar fetches no blueprint and shows no blueprint tab or section', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'app', 'components', 'vue-canvas', 'NodesSidebar.vue'), 'utf8')
    expect(src).not.toContain('global_subgraphs')
    expect(src).not.toMatch(/fetchBlueprints|blueprintTree|addBlueprint/)
    expect(src).not.toMatch(/>\s*Blueprints\s*</)
    expect(src).not.toMatch(/Subgraph Blueprints/)
  })
})
