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
import { RETIRED_ADVICE_OF, RETIRED_CLASSES, RETIRED_NODE_MESSAGE, RETIRED_OUTPUT_CLASSES, isRetiredClass, retiredNodeIds, retiredNodesResponse } from '#shared/runner/retired'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, RUNNER_NODE_TYPES } from '#shared/runner/eligibility'
import { modelMenus } from '#shared/runner/modelMenus'
import { blockedRunRefusal, workflowNodeTitles } from '#shared/runner/needsEngine'
import { outputClassesOf } from '#shared/runner/validate'
import { graphToPrompt } from '~/lib/graph/graphToPrompt'
import type { ApiPrompt } from '#shared/runner/graph'
import { ACTION_CATALOG, CHIPS_BY_DOMAIN, DEPRECATED_NODES, HERO_BY_DOMAIN, offeredInActionsPanel } from '~/data/action-catalog'
import { AGENT_CAPABILITIES } from '~/lib/agent/capabilities'
import { buildCatalog } from '~/lib/portIntentCatalog'
import type { NodeTypeLite } from '~/lib/portIntent'
import { planStart } from '~/lib/startModal/plan'
import { START_AI, startHandTiles } from '~/data/start-modal'
import { TOOLBOX_SECTIONS } from '~/data/toolbox-items'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { createFakeLedger, makeKit } from './__runner__/kit'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>
const moduleOf = (name: string) => String(CATALOG[name]?.python_module ?? '')
/** The mechanical rule: a partner-node file other than nodes_replicate.py. */
const comfyBilled = (name: string) => /^comfy_api_nodes\.nodes_/.test(moduleOf(name)) && moduleOf(name) !== 'comfy_api_nodes.nodes_replicate'

const KLING = 'KlingImage2VideoNode'
const IS_OUTPUT = outputClassesOf(CATALOG)!
const kling = (start: string) => ({ class_type: KLING, inputs: { start_frame: [start, 0], prompt: 'a fox runs', negative_prompt: '', model_name: 'kling-v2-master', cfg_scale: 0.8, mode: 'std', aspect_ratio: '16:9', duration: '5' } })
/** A picture graph (LoadImage → Save image) with a retired node beside it that no output reads. */
const unreadGraph = (): ApiPrompt => ({
  1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  2: kling('1'),
  3: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ComfyUI' } },
})
/** The same picture graph with a lone retired helper (a Recraft colour) nothing reads. */
const unreadHelperGraph = (): ApiPrompt => ({
  1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  2: { class_type: 'RecraftColorRGB', inputs: { r: 0, g: 0, b: 0 } },
  3: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ComfyUI' } },
})
/** A retired output node (Meshy makes a 3D model): it always runs. */
const outputGraph = (): ApiPrompt => ({
  1: { class_type: 'MeshyTextToModelNode', inputs: { prompt: 'a fox', model: 'latest', seed: 0 } },
})
const retiredGraph = (): ApiPrompt => ({
  1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  2: { class_type: KLING, inputs: { start_frame: ['1', 0], prompt: 'a fox runs', negative_prompt: '', model_name: 'kling-v2-master', cfg_scale: 0.8, mode: 'std', aspect_ratio: '16:9', duration: '5' } },
  3: { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
})

describe('the retired list (guard)', () => {
  it('is exactly every api.comfy.org-billed class in the committed catalogue (182) plus the two deleted local nodes', () => {
    const billed = Object.keys(CATALOG).filter(comfyBilled).sort()
    expect(billed.length).toBe(182)
    expect([...RETIRED_CLASSES].sort()).toEqual([...billed, 'FaceRestore', 'LipSync'].sort())
    for (const name of billed) expect(isRetiredClass(name), name).toBe(true)
    expect(Object.keys(RETIRED_ADVICE_OF).sort()).toEqual(['FaceRestore', 'LipSync'])
    for (const name of ['FaceRestore', 'LipSync']) expect(name in CATALOG, name).toBe(false)
  })

  it('FaceRestore and LipSync are refused before the hold, each with its own advice, on both paths', () => {
    const cases: [string, string][] = [
      ['FaceRestore', 'This node was retired. Use Fix faces instead.'],
      ['LipSync', 'This node was retired. Use Lip-sync a character instead.'],
    ]
    for (const [cls, message] of cases) {
      const g: ApiPrompt = {
        1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
        2: { class_type: cls, inputs: { image: ['1', 0] } },
        3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'x' } },
      }
      const body = retiredNodesResponse(g, c => c === 'SaveImage')!
      expect(body.error.message).toBe(message)
      expect(body.node_errors['2']).toMatchObject({ class_type: cls, errors: [{ message }] })
      expect(blockedPromptRefusal(g, { isOutputClass: c => c === 'SaveImage' })!.error.message).toBe(message)
      expect(blockedRunRefusal([{ prompt: g, titleOf: () => 'Old node' }], { runnerOn: true, isOutputClass: c => c === 'SaveImage' }))
        .toEqual({ title: '“Old node” was retired', description: message.replace('This node was retired. ', '') })
    }
  })

  it('the retired output nodes are exactly the catalogue\'s: 17', () => {
    const outputs = [...RETIRED_CLASSES].filter(n => CATALOG[n]?.output_node === true).sort()
    expect(outputs.length).toBe(17)
    expect([...RETIRED_OUTPUT_CLASSES].sort()).toEqual(outputs)
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
    const r = blockedRunRefusal([{ prompt: retiredGraph(), titleOf: id => (id === '2' ? 'Fox clip' : 'Other') }], { runnerOn: true, isOutputClass: IS_OUTPUT })
    expect(r).toEqual({ title: '“Fox clip” was retired', description: 'Pick another way to make this.' })
    expect(blockedRunRefusal([{ prompt: retiredGraph(), titleOf: () => 'Fox clip' }], { runnerOn: false, isOutputClass: IS_OUTPUT })).toEqual(r)
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

/** The hosted meter's deps, every step a spy (nothing real is priced, held or sent). */
const meterDeps = (overrides: Record<string, unknown> = {}) => ({
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
  isOutputClass: IS_OUTPUT,
  ...overrides,
})

describe('only a retired node that runs is refused (R4.1 fix round 1: pruned as ComfyUI prunes it)', () => {
  it('the shared rule: a node no output reads, or a lone helper, is left out; a retired output node always counts', () => {
    expect(retiredNodeIds(unreadGraph(), IS_OUTPUT)).toEqual([])
    expect(retiredNodeIds(unreadHelperGraph(), IS_OUTPUT)).toEqual([])
    expect(retiredNodeIds(outputGraph(), IS_OUTPUT)).toEqual(['1'])
    expect(retiredNodeIds(retiredGraph(), IS_OUTPUT)).toEqual(['2'])
    // Read through a helper chain: Recraft colour → Recraft text-to-image → Save image.
    const chain: ApiPrompt = {
      1: { class_type: 'RecraftColorRGB', inputs: { r: 0, g: 0, b: 0 } },
      2: { class_type: 'RecraftTextToImageNode', inputs: { prompt: 'x', recraft_color: ['1', 0] } },
      3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'ComfyUI' } },
    }
    expect(retiredNodeIds(chain, IS_OUTPUT)).toEqual(['1', '2'])
    // Without an output test, every retired node counts (the safe side).
    expect(retiredNodeIds(unreadGraph())).toEqual(['2'])
  })

  it('a retired node feeding only an output ComfyUI would drop is still refused (its validity is ComfyUI\'s to judge, after this gate)', () => {
    const g: ApiPrompt = { ...unreadGraph(), 4: { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: '', format: 'bogus', codec: 'auto' } } }
    expect(retiredNodeIds(g, IS_OUTPUT)).toEqual(['2'])
    expect(blockedPromptRefusal(g)!.error.message).toBe(RETIRED_NODE_MESSAGE)
  })

  it('the shared gate (hosted meter and local proxy): not refused unread, refused as an output', () => {
    expect(blockedPromptRefusal(unreadGraph())).toBeNull()
    expect(blockedPromptRefusal(unreadHelperGraph())).toBeNull()
    expect(blockedPromptRefusal(outputGraph())).toEqual(retiredNodesResponse(outputGraph()))
  })

  it('hosted meter: the unread node is priced out and the rest is held and sent; a retired output node is refused before anything', async () => {
    for (const graph of [unreadGraph(), unreadHelperGraph()]) {
      const d = meterDeps()
      const r = await meterGraphSubmit('u1', { prompt: graph, client_id: 'c1' }, d as any)
      expect(r.status).toBe(200)
      expect(d.hold).toHaveBeenCalled()
      expect(d.forward).toHaveBeenCalled()
      // Priced on the part that runs: the retired node is not in it.
      const priced = (d.priceGraph.mock.calls as unknown as [ApiPrompt][]).map(c => Object.keys(c[0]))
      expect(priced.every(ids => !ids.includes('2'))).toBe(true)
    }
    const d = meterDeps()
    const r = await meterGraphSubmit('u1', { prompt: outputGraph(), client_id: 'c1' }, d as any)
    expect([r.status, r.body]).toEqual([400, retiredNodesResponse(outputGraph())])
    for (const f of [d.moderatePrompt, d.priceGraph, d.hold, d.forward]) expect(f).not.toHaveBeenCalled()
  })

  it('the runner: an unread one is declined with the marker (the ComfyUI path prunes it and runs the rest); a retired output node is refused, no hold', async () => {
    for (const graph of [unreadGraph(), unreadHelperGraph()]) {
      const ledger = createFakeLedger()
      const k = makeKit({ hosted: true, ledger })
      const err = await k.engine.startRun({ userId: k.userId, takes: [graph], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
      expect(err.message).not.toBe(RETIRED_NODE_MESSAGE)
      expect(err.data?.reason).toBe(RUNNER_NOT_ELIGIBLE)
      expect(ledger.hold).not.toHaveBeenCalled()
    }
    const ledger = createFakeLedger()
    const k = makeKit({ hosted: true, ledger })
    const err = await k.engine.startRun({ userId: k.userId, takes: [outputGraph()], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: RETIRED_NODE_MESSAGE })
    expect(err.data?.reason).toBeUndefined()
    expect(ledger.hold).not.toHaveBeenCalled()
  })

  it('the browser: not refused unread; refused as an output, by its title', () => {
    const titleOf = () => 'Fox model'
    expect(blockedRunRefusal([{ prompt: unreadGraph(), titleOf }], { runnerOn: true, isOutputClass: IS_OUTPUT })).toBeNull()
    expect(blockedRunRefusal([{ prompt: unreadHelperGraph(), titleOf }], { runnerOn: false, isOutputClass: IS_OUTPUT })).toBeNull()
    expect(blockedRunRefusal([{ prompt: outputGraph(), titleOf }], { runnerOn: true, isOutputClass: IS_OUTPUT }))
      .toEqual({ title: '“Fox model” was retired', description: 'Pick another way to make this.' })
  })
})

describe('a retired node inside a subgraph', () => {
  const SG = '5f0c1a2b-0000-4000-8000-00000000abcd'
  const workflow = (title?: string) => ({
    last_node_id: 8, last_link_id: 1, groups: [], config: {}, extra: {}, version: 0.4,
    nodes: [
      { id: 7, type: SG, ...(title ? { title } : {}), pos: [0, 0], size: [200, 100], mode: 0, inputs: [], outputs: [{ name: 'VIDEO', type: 'VIDEO', links: [1] }], widgets_values: [], properties: {} },
      { id: 8, type: 'SaveVideo', pos: [300, 0], size: [200, 100], mode: 0, inputs: [{ name: 'video', type: 'VIDEO', link: 1 }], outputs: [], widgets_values: ['video/ComfyUI', 'auto', 'auto'], properties: {} },
    ],
    links: [[1, 7, 0, 8, 0, 'VIDEO']],
    definitions: { subgraphs: [{
      id: SG, version: 1, name: 'Fox clip maker',
      inputNode: { id: -10 }, outputNode: { id: -20 },
      inputs: [], outputs: [{ id: 'o1', name: 'VIDEO', type: 'VIDEO', linkIds: [1] }],
      nodes: [{ id: 1, type: KLING, pos: [0, 0], size: [200, 100], mode: 0, inputs: [], outputs: [{ name: 'VIDEO', type: 'VIDEO', links: [1] }], widgets_values: ['a fox runs', '', 'kling-v2-master', 0.8, 'std', '16:9', '5'], properties: {} }],
      links: [{ id: 1, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'VIDEO' }],
    }] },
  })

  it('the refusal names the subgraph card as the user sees it: its title, else its subgraph\'s name', () => {
    for (const [title, shown] of [['My clip', 'My clip'], [undefined, 'Fox clip maker']] as const) {
      const wf = workflow(title)
      const prompt = graphToPrompt(wf as any, CATALOG)
      const inner = Object.keys(prompt).find(id => prompt[id]!.class_type === KLING)
      expect(inner).toBe('70001')
      const r = blockedRunRefusal([{ prompt, titleOf: workflowNodeTitles(wf as any, CATALOG) }], { runnerOn: true, isOutputClass: IS_OUTPUT })
      expect(r).toEqual({ title: `“${shown}” was retired`, description: 'Pick another way to make this.' })
    }
  })
})
