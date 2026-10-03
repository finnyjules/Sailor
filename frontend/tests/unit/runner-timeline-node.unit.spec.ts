// @vitest-environment happy-dom
/**
 * Task R9.1 (engine-free step 3, decision 5): the Timeline node in a workflow
 * is refused plainly, before the hold, on both paths (the runner, and every
 * /prompt bound for ComfyUI: the hosted meter, the local proxy, the browser),
 * with "Export this timeline from the Timeline editor." It isn't retired: it
 * is still offered, its card is normal, and it still opens the editor.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_ONLY_ADVICE_OF, RETIRED_NODE_MESSAGE, isEditorOnlyClass, isRetiredClass, jsonNamesRetiredClass,
  retiredMessageOf, retiredNodeIds, retiredNodesResponse, retiredUnparsedResponse,
} from '#shared/runner/retired'
import { blockedRunRefusal, workflowNodeTitles } from '#shared/runner/needsEngine'
import { outputClassesOf } from '#shared/runner/validate'
import type { ApiPrompt } from '#shared/runner/graph'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { createFakeLedger, makeKit } from './__runner__/kit'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>
const IS_OUTPUT = outputClassesOf(CATALOG)!
const WORDS = 'Export this timeline from the Timeline editor.'

/** A workflow whose only output is a Timeline fed by a loaded video. */
const timelineGraph = (): ApiPrompt => ({
  1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  2: { class_type: 'Timeline', inputs: { clip1_video: ['1', 0], total_duration: 0, output_fps: 30, bg_color: '#000000', audio_file: '(none)', preview_frame: -1, edit_state: '{}' } },
})

describe('the Timeline class', () => {
  it('is editor-only, not retired: an output node in the catalogue, refused in a run with its own words', () => {
    expect(CATALOG.Timeline?.output_node).toBe(true)
    expect(isEditorOnlyClass('Timeline')).toBe(true)
    expect(isRetiredClass('Timeline')).toBe(false)
    expect(EDITOR_ONLY_ADVICE_OF.Timeline).toBe(WORDS)
    expect(retiredMessageOf('Timeline')).toBe(WORDS)
    expect(isEditorOnlyClass('toString')).toBe(false)
  })

  it('is still offered and its card is normal (the node opens the editor)', () => {
    // The node search, Actions panel, catalogues and the card's retired badge all read isRetiredClass (false above);
    // the toolbar still adds a Timeline node.
    expect(readFileSync(join(process.cwd(), 'app/layouts/default.vue'), 'utf8')).toContain("nodeType: 'Timeline'")
  })
})

describe('refused before any charge, in ComfyUI\'s 400 shape', () => {
  it('the refusal body marks the Timeline node with the words', () => {
    const body = retiredNodesResponse(timelineGraph(), IS_OUTPUT)!
    expect(body.error).toMatchObject({ type: 'value_not_valid', message: WORDS })
    expect(Object.keys(body.node_errors)).toEqual(['2'])
    expect(body.node_errors['2']).toMatchObject({ class_type: 'Timeline', errors: [{ message: WORDS }] })
    // An output node always runs: refused even when the catalogue's output test misses it.
    expect(retiredNodeIds(timelineGraph(), () => false)).toEqual(['2'])
  })

  it('the runner refuses it before the hold, with no provider call and no "run it on ComfyUI" marker', async () => {
    const ledger = createFakeLedger()
    const k = makeKit({ hosted: true, ledger })
    const err = await k.engine.startRun({ userId: k.userId, takes: [timelineGraph()], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: WORDS })
    expect(err.data).toMatchObject({ node_errors: { 2: { class_type: 'Timeline' } } })
    expect(err.data?.reason).toBeUndefined()
    expect(ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('every /prompt bound for ComfyUI: the shared gate refuses it', () => {
    expect(blockedPromptRefusal(timelineGraph(), { isOutputClass: IS_OUTPUT })!.error.message).toBe(WORDS)
  })


  it('the browser refuses it before sending anything, naming the node by its title', () => {
    const r = blockedRunRefusal([{ prompt: timelineGraph(), titleOf: id => (id === '2' ? 'Launch cut' : 'Other') }], { runnerOn: true, isOutputClass: IS_OUTPUT })
    expect(r).toEqual({ title: '“Launch cut” can’t run in a workflow', description: WORDS })
    expect(blockedRunRefusal([{ prompt: timelineGraph(), titleOf: () => 'Launch cut' }], { runnerOn: false, isOutputClass: IS_OUTPUT })).toEqual(r)
  })

  it('a prompt too large to parse: found in the text, refused in its own words', () => {
    const text = JSON.stringify({ prompt: timelineGraph() })
    expect(jsonNamesRetiredClass(text)).toBe(true)
    expect(retiredUnparsedResponse(text).error.message).toBe(WORDS)
    expect(retiredUnparsedResponse().error.message).toBe(RETIRED_NODE_MESSAGE)
  })
})

describe('local /prompt: a plain 404 (step 4, C5: no engine, nothing to check or forward)', () => {
  const g = globalThis as any
  const proxyRequest = vi.fn(async (_event: any, url: string) => ({ proxiedTo: url }))
  it('is refused before anything is read, in every size; nothing is proxied', async () => {
    vi.doMock('~~/server/utils/deployMode', () => ({ deployMode: () => 'local', isHosted: () => false, engineMultiUser: () => false }))
    g.defineEventHandler = (fn: any) => fn
    g.createError = (opts: { statusCode: number, message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
    g.proxyRequest = proxyRequest
    const middleware = (await import('~~/server/middleware/comfyui-proxy')).default as any
    const ev = (body: unknown) => ({ path: '/prompt', method: 'POST', context: {}, _requestBody: body, node: { req: { headers: {} }, res: {} as any } })
    for (const body of [{ prompt: timelineGraph() }, Buffer.from(JSON.stringify({ prompt: timelineGraph(), pad: 'x'.repeat(9 * 1024 * 1024) }))]) {
      await expect(middleware(ev(body))).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

/**
 * The saved projects on this Mac that hold a Timeline node (20 on
 * 2026-10-01; user/ is not in git, so a checkout without them skips). Each
 * still opens (its workflow reads), and a run of it lists the Timeline as
 * refused, by its title.
 */
describe('saved projects with a Timeline node', () => {
  const projectsDir = join(process.cwd(), '..', 'user', 'sailor', 'projects')
  const files = existsSync(projectsDir)
    ? readdirSync(projectsDir).map(d => join(projectsDir, d, 'versions', 'current.json')).filter(f => existsSync(f))
    : []
  interface WfNode { id: number | string, type?: string, title?: string }
  const withTimeline: { file: string, workflow: { nodes: WfNode[] } }[] = []
  for (const file of files) {
    let project: any
    try { project = JSON.parse(readFileSync(file, 'utf8')) }
    catch { continue }
    for (const canvas of project?.workflow?.canvases ?? []) {
      const wf = canvas?.workflow
      if (Array.isArray(wf?.nodes) && wf.nodes.some((n: WfNode) => n?.type === 'Timeline')) withTimeline.push({ file, workflow: wf })
    }
  }

  it.skipIf(!withTimeline.length)('each opens and its run lists the Timeline as refused, by title', () => {
    expect(new Set(withTimeline.map(w => w.file)).size).toBeGreaterThanOrEqual(1)
    for (const { file, workflow } of withTimeline) {
      // The run's prompt as the canvas builds it, reduced to what the gate reads (class per node id).
      const prompt: ApiPrompt = {}
      for (const n of workflow.nodes) if (typeof n?.type === 'string') prompt[String(n.id)] = { class_type: n.type, inputs: {} }
      const timelineIds = workflow.nodes.filter(n => n.type === 'Timeline').map(n => String(n.id))
      expect(retiredNodeIds(prompt, IS_OUTPUT), file).toEqual(expect.arrayContaining(timelineIds))
      const titleOf = workflowNodeTitles(workflow as any, CATALOG)
      const r = blockedRunRefusal([{ prompt, titleOf }], { runnerOn: true, isOutputClass: IS_OUTPUT })
      expect(r, file).not.toBeNull()
      // The first refused node may be a retired one listed earlier; a Timeline-only project names its Timeline.
      const refused = retiredNodeIds(prompt, IS_OUTPUT)
      if (refused.every(id => prompt[id]!.class_type === 'Timeline')) {
        expect(r!.description, file).toBe(WORDS)
        expect(r!.title, file).toBe(`“${titleOf(refused[0]!)}” can’t run in a workflow`)
      }
    }
  })
})
