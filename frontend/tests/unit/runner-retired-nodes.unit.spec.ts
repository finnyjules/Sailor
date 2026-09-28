// @vitest-environment happy-dom
/**
 * Task R4.1 (engine-free step 3, decision 3): the 182 partner nodes ComfyUI
 * bills through Comfy's own account (api.comfy.org) are retired.
 *   - The list is every class of comfy_api_nodes/nodes_*.py except
 *     nodes_replicate.py, read here from the committed catalogue: a guard.
 *   - None of them is offered: Actions panel (and no Legacy toggle behind
 *     it), node search, the agent's / port-intent catalogue, the start
 *     modal, the toolbox, next steps.
 *   - Refused before anything is priced or held, in ComfyUI's 400 shape, on
 *     both paths: the runner, and /prompt bound for ComfyUI (hosted meter and
 *     local proxy); the browser says so before sending anything.
 *   - A saved workflow holding one still opens; its card shows it retired and
 *     can't be run.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { RETIRED_CLASSES, RETIRED_NODE_MESSAGE, isRetiredClass, retiredNodesResponse } from '#shared/runner/retired'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, RUNNER_NODE_TYPES } from '#shared/runner/eligibility'
import { modelMenus } from '#shared/runner/modelMenus'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import type { ApiPrompt } from '#shared/runner/graph'
import { ACTION_CATALOG, CHIPS_BY_DOMAIN, DEPRECATED_NODES, HERO_BY_DOMAIN, offeredInActionsPanel } from '~/data/action-catalog'
import { AGENT_CAPABILITIES } from '~/lib/agent/capabilities'
import { buildCatalog } from '~/lib/portIntentCatalog'
import type { NodeTypeLite } from '~/lib/portIntent'
import { planStart } from '~/lib/startModal/plan'
import { START_AI, startHandTiles } from '~/data/start-modal'
import { TOOLBOX_SECTIONS } from '~/data/toolbox-items'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { createFakeLedger, makeKit } from './__runner__/kit'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>
const moduleOf = (name: string) => String(CATALOG[name]?.python_module ?? '')
/** The mechanical rule: a partner-node file other than nodes_replicate.py. */
const comfyBilled = (name: string) => /^comfy_api_nodes\.nodes_/.test(moduleOf(name)) && moduleOf(name) !== 'comfy_api_nodes.nodes_replicate'

const KLING = 'KlingImage2VideoNode'
const retiredGraph = (): ApiPrompt => ({
  1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  2: { class_type: KLING, inputs: { start_frame: ['1', 0], prompt: 'a fox runs', negative_prompt: '', model_name: 'kling-v2-master', cfg_scale: 0.8, mode: 'std', aspect_ratio: '16:9', duration: '5' } },
  3: { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
})

describe('the retired list (guard)', () => {
  it('is exactly every api.comfy.org-billed class in the committed catalogue: 182', () => {
    const billed = Object.keys(CATALOG).filter(comfyBilled).sort()
    expect(billed.length).toBe(182)
    expect([...RETIRED_CLASSES].sort()).toEqual(billed)
    for (const name of billed) expect(isRetiredClass(name), name).toBe(true)
  })

  it('retires no Replicate or fal class, nothing the runner or the line-up takes', () => {
    for (const name of RETIRED_CLASSES) {
      expect(moduleOf(name), name).not.toBe('comfy_api_nodes.nodes_replicate')
      expect(RUNNER_NODE_TYPES.has(name), name).toBe(false)
      expect(name in RUNNER_NODE_RULES, name).toBe(false)
      expect(PROVIDER_TYPES.has(name), name).toBe(false)
    }
    for (const menu of modelMenus()) expect(isRetiredClass(menu.classType), menu.classType).toBe(false)
    expect(isRetiredClass('GenerateImageNode')).toBe(false)
    expect(isRetiredClass('FluxLoRARemoteNode')).toBe(false)
    expect(isRetiredClass(undefined)).toBe(false)
  })
})

describe('no surface offers a retired node', () => {
  it('Actions panel: none, and nothing Comfy-billed is left for a Legacy toggle', () => {
    const offered = Object.entries(CATALOG).filter(([name, info]) => offeredInActionsPanel(name, info?.category ?? '')).map(([n]) => n)
    expect(offered.length).toBeGreaterThan(40)
    expect(offered.filter(isRetiredClass)).toEqual([])
    const providers = new Set(offered.map(n => String(CATALOG[n].category).split('/')[2]))
    expect([...providers].sort()).toEqual(['Replicate', 'fal'])
    // A Comfy-billed provider the live engine may list is never offered either.
    expect(offeredInActionsPanel('SomeNewPartnerNode', 'api node/image/Kling')).toBe(false)
    expect(offeredInActionsPanel('GenerateImageNode', 'api node/image/Replicate')).toBe(true)
    expect(offeredInActionsPanel('FluxProRemoteNode', 'api node/image/Replicate')).toBe(false) // DEPRECATED_NODES, as before
  })

  it('the panel has no Legacy toggle any more', () => {
    const src = readFileSync(join(process.cwd(), 'app/components/vue-canvas/GeneratorsPanel.vue'), 'utf8')
    expect(src).not.toMatch(/showLegacy|legacy partners/i)
  })

  it('the Actions catalogue, heroes, chips, deprecated list, agent capabilities, toolbox and start modal name none', () => {
    const named = [
      ...Object.keys(ACTION_CATALOG),
      ...Object.values(HERO_BY_DOMAIN).flat(),
      ...Object.values(CHIPS_BY_DOMAIN).flat().map(c => c.nodeType),
      ...DEPRECATED_NODES,
      ...AGENT_CAPABILITIES.map(c => c.nodeType),
      ...TOOLBOX_SECTIONS.flatMap(s => s.items.map(i => i.nodeType)),
      ...[null, ...START_AI, ...startHandTiles(true)].flatMap(t => planStart(t ? t.id : null).nodes.map(n => n.nodeType)),
    ]
    expect(named.filter(isRetiredClass)).toEqual([])
  })

  it('next steps and the image-edit bar name none', () => {
    for (const f of ['app/lib/artifact/nextSteps.ts', 'app/lib/canvas/nodeActions.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect([...RETIRED_CLASSES].filter(n => new RegExp(`['"\`]${n}['"\`]`).test(src)), f).toEqual([])
    }
  })

  it('node search lists none of them (a Replicate node still shows)', async () => {
    const g = globalThis as any
    const saved = g.$fetch
    g.$fetch = vi.fn(async () => CATALOG)
    try {
      const { useNodeSearch } = await import('~/composables/useNodeSearch')
      const s = useNodeSearch()
      s.openNodeSearch()
      await vi.waitFor(() => expect(s.nodeTypes.value.length).toBeGreaterThan(100))
      const names = s.nodeTypes.value.map((n: { name: string }) => n.name)
      expect(names.filter(isRetiredClass)).toEqual([])
      expect(names).toContain('FluxLoRARemoteNode')
      s.searchQuery.value = 'kling'
      expect(s.filteredNodes.value.map((n: { name: string }) => n.name).filter(isRetiredClass)).toEqual([])
    }
    finally { g.$fetch = saved }
  })

  it('the agent and port-intent catalogue leave them out, pinned or matched', () => {
    const lite = (name: string): NodeTypeLite => ({ name, displayName: CATALOG[name]?.display_name ?? name, description: '', category: CATALOG[name]?.category ?? '', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'VIDEO', type: 'VIDEO' }] })
    const types = [lite(KLING), lite('GenerateVideoNode')]
    const out = buildCatalog(types, CATALOG, { portType: 'IMAGE', direction: 'output' }, { intent: 'kling image to video', alwaysInclude: [KLING] })
    expect(out.map(e => e.type)).toEqual(['GenerateVideoNode'])
  })
})

describe('refused before any charge, in ComfyUI\'s 400 shape', () => {
  it('the refusal body marks each retired node with the plain message', () => {
    const body = retiredNodesResponse(retiredGraph())!
    expect(body.error).toMatchObject({ type: 'value_not_valid', message: RETIRED_NODE_MESSAGE })
    expect(Object.keys(body.node_errors)).toEqual(['2'])
    expect(body.node_errors['2']).toMatchObject({ class_type: KLING, dependent_outputs: [], errors: [{ type: 'value_not_valid', message: RETIRED_NODE_MESSAGE }] })
    expect(RETIRED_NODE_MESSAGE).toBe('This node was retired. Pick another way to make this.')
    expect(retiredNodesResponse({ 1: { class_type: 'GenerateImageNode', inputs: {} } })).toBeNull()
    expect(retiredNodesResponse(null)).toBeNull()
  })

  it('the runner refuses it before the hold, with no provider call and no "run it on ComfyUI" marker', async () => {
    const ledger = createFakeLedger()
    const k = makeKit({ hosted: true, ledger })
    const err = await k.engine.startRun({ userId: k.userId, takes: [retiredGraph()], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: RETIRED_NODE_MESSAGE })
    expect(err.data).toMatchObject({ node_errors: { 2: { class_type: KLING } } })
    expect(err.data?.reason).toBeUndefined()
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('every /prompt bound for ComfyUI: the shared gate refuses it', () => {
    expect(blockedPromptRefusal(retiredGraph())).toEqual(retiredNodesResponse(retiredGraph()))
  })

  it('hosted meter: 400 before moderation, pricing, the hold and the engine', async () => {
    const d = {
      priceGraph: vi.fn(() => ({ credits: 5, version: 'test', breakdown: [] })),
      spendGuard: vi.fn(async () => {}),
      validateFileRefs: vi.fn(async () => {}),
      moderatePrompt: vi.fn(async () => ({ ok: true as const })),
      hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
      getAvailable: vi.fn(async () => 3),
      forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
      registerRun: vi.fn(async () => {}),
      startSettle: vi.fn(),
      releaseHold: vi.fn(async () => {}),
    }
    const r = await meterGraphSubmit('u1', { prompt: retiredGraph(), client_id: 'c1' }, d as any)
    expect(r.status).toBe(400)
    expect(r.body).toEqual(retiredNodesResponse(retiredGraph()))
    for (const f of [d.moderatePrompt, d.priceGraph, d.hold, d.forward, d.validateFileRefs]) expect(f).not.toHaveBeenCalled()
  })

  it('the browser refuses it before sending anything, naming the node by its title', () => {
    const r = blockedRunRefusal([{ prompt: retiredGraph(), titleOf: id => (id === '2' ? 'Fox clip' : 'Other') }], { runnerOn: true })
    expect(r).toEqual({ title: '“Fox clip” was retired', description: 'Pick another way to make this.' })
    expect(blockedRunRefusal([{ prompt: retiredGraph(), titleOf: () => 'Fox clip' }], { runnerOn: false })).toEqual(r)
  })
})

describe('local /prompt proxy', () => {
  const g = globalThis as any
  let middleware: (event: any) => Promise<any>
  const proxyRequest = vi.fn(async (_event: any, url: string) => ({ proxiedTo: url }))
  beforeAll(async () => {
    vi.doMock('~~/server/native/engineHealth', async orig => ({ ...(await orig() as object), engineHealth: async () => 'up' }))
    vi.doMock('~~/server/utils/deployMode', () => ({ deployMode: () => 'local', isHosted: () => false, engineMultiUser: () => false }))
    g.defineEventHandler = (fn: any) => fn
    g.createError = (opts: { statusCode: number, message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
    g.proxyRequest = proxyRequest
    middleware = (await import('~~/server/middleware/comfyui-proxy')).default as any
  })
  afterEach(() => proxyRequest.mockClear())
  const ev = (path: string, body: unknown) => ({ path, method: 'POST', context: {}, _requestBody: body, node: { req: { headers: {} }, res: {} as any } })

  it('refuses it, 400, never forwarded — over the parse cap too', async () => {
    const { PROMPT_CHECK_MAX_BYTES } = await import('~~/server/middleware/comfyui-proxy')
    const small = ev('/prompt', { prompt: retiredGraph() })
    const res = await middleware(small)
    expect(small.node.res.statusCode).toBe(400)
    expect(res).toEqual(retiredNodesResponse(retiredGraph()))
    const base = JSON.stringify({ prompt: retiredGraph(), pad: '' })
    const big = ev('/prompt', Buffer.from(JSON.stringify({ prompt: retiredGraph(), pad: 'x'.repeat(PROMPT_CHECK_MAX_BYTES + 1 - base.length) })))
    const bigRes = await middleware(big)
    expect(big.node.res.statusCode).toBe(400)
    expect(bigRes.error.message).toBe(RETIRED_NODE_MESSAGE)
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

describe('a saved workflow holding one', () => {
  it('opens, and its card shows it retired and can\'t be run', async () => {
    const { useVueNodes } = await import('~/composables/useVueNodes')
    const vn = useVueNodes()
    vn.objectInfo.value = CATALOG
    vn.convertFromLiteGraph({
      last_node_id: 1, last_link_id: 0, links: [], groups: [], config: {}, extra: {}, version: 0.4,
      nodes: [{ id: 1, type: KLING, pos: [0, 0], size: [280, 400], inputs: [], outputs: [], widgets_values: ['a fox runs', '', 'kling-v2-master', 0.8, 'std', '16:9', '5'], properties: {} }],
    } as any)
    const node = vn.nodes.value.find((n: any) => String(n.id) === '1') as any
    expect(node?.data?.nodeType).toBe(KLING)

    const g = globalThis as any
    const saved = g.useRuntimeConfig
    g.useRuntimeConfig = () => ({ public: { runnerEnabled: true, runnerFamilies: '' } })
    try {
      const { default: ComfyNode } = await import('~/components/vue-canvas/ComfyNode.vue')
      const WidgetStub = defineComponent({ props: { widgetDef: { type: Object, required: true } }, setup: () => () => h('div') })
      const w = mount(ComfyNode as any, { props: { id: '1', data: node.data, selected: false }, shallow: true, global: { stubs: { VueCanvasComfyNodeWidget: WidgetStub } } })
      const badge = w.find('[data-retired]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('Retired')
      expect(badge.attributes('title')).toBe(RETIRED_NODE_MESSAGE)
      const row = w.findComponent({ name: 'NodeRunRow' })
      expect(row.exists()).toBe(true)
      expect(row.props('canRun')).toBe(false)

      // Any other partner-free card: no badge.
      const other = mount(ComfyNode as any, { props: { id: '2', data: { ...node.data, nodeType: 'GenerateVideoNode' }, selected: false }, shallow: true, global: { stubs: { VueCanvasComfyNodeWidget: WidgetStub } } })
      expect(other.find('[data-retired]').exists()).toBe(false)
    }
    finally { g.useRuntimeConfig = saved }
  })
})
