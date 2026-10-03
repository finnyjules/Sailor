/**
 * Step 3, R10.6 (decision 4): blueprints.
 *
 *   - Locally, `/global_subgraphs` is served by Sailor itself, read-only, with
 *     ComfyUI off (server/native/globalSubgraphs.ts). Its list and every entry
 *     equal what ComfyUI's own `SubgraphManager` (app/subgraph_manager.py, run
 *     here from the repo's `.venv`) answers for the repo's blueprints, and for
 *     a temp root with a custom node pack's subgraphs and the odd cases.
 *   - Every class inside every blueprint is one R10.2 knows (the runner's, a
 *     local-only class, or one the local engine still runs), so a blueprint
 *     runs on Sailor when all its classes do, and otherwise gets R10.2's
 *     words: locally with the engine up it goes to the engine; in hosted it
 *     is refused in plain words.
 *   - Hosted offers none: node search lists only the classes the runner
 *     takes, plus the cards; the sidebar has no blueprint section (the
 *     hosted list itself is empty: engine-path-alias.unit.spec.ts).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_SUBGRAPHS_PREFIXES, matchGlobalSubgraphsRoute, runGlobalSubgraphs } from '../../server/native/globalSubgraphs'
import { NATIVE_ENGINE_PREFIXES, decodeSegment, nativeEnginePath } from '../../server/native/router'
import { graphToPrompt } from '~/lib/graph/graphToPrompt'
import { engineRoute, isCustomClass } from '#shared/runner/needsEngine'
import { EVERY_KNOWN_FAMILY } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { isLocalOnlyClass, NEEDS_LOCAL_ENGINE } from '#shared/runner/localOnly'
import { isRetiredClass } from '#shared/runner/retired'
import { hostedOffersClass } from '#shared/runner/hostedOffer'

const FRONTEND = path.resolve(__dirname, '..', '..')
const REPO = path.resolve(FRONTEND, '..')
const PYTHON = path.join(REPO, '.venv', 'bin', 'python')
const hasPython = fs.existsSync(PYTHON)
const CATALOG: Record<string, any> = JSON.parse(gunzipSync(fs.readFileSync(path.join(FRONTEND, 'server', 'native', 'objectInfo.baseline.json.gz'))).toString('utf8'))
const BLUEPRINT_FILES = fs.readdirSync(path.join(REPO, 'blueprints')).filter(n => !n.startsWith('.') && n.endsWith('.json'))

vi.setConfig({ testTimeout: 60_000 })

/**
 * ComfyUI's own SubgraphManager, loaded from `module` (its __file__ decides the
 * blueprints folder) with `folder_paths` stubbed to `customNodes`; answers the
 * list, every entry by id, and an unknown id.
 */
const ORACLE = `
import sys, json, asyncio, types, importlib.util
cfg = json.load(sys.stdin)
fp = types.ModuleType('folder_paths')
fp.get_folder_paths = lambda name: cfg['custom_nodes']
sys.modules['folder_paths'] = fp
spec = importlib.util.spec_from_file_location('sailor_subgraph_oracle', cfg['module'])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
async def go():
    mgr = m.SubgraphManager()
    listed = await mgr.sanitize_entries(await mgr.get_all_subgraphs([]), remove_data=True)
    entries = {}
    for k in list(listed.keys()) + ['no-such-id']:
        try:
            entries[k] = {'ok': await mgr.sanitize_entry(await mgr.get_subgraph(k, []))}
        except Exception as e:
            entries[k] = {'error': type(e).__name__}
    print(json.dumps({'list': listed, 'keys': list(listed.keys()), 'entries': entries}))
asyncio.run(go())
`

interface Oracle { list: Record<string, unknown>, keys: string[], entries: Record<string, { ok?: unknown, error?: string }> }

function python(module: string, customNodes: string[]): Oracle {
  const r = spawnSync(PYTHON, ['-c', ORACLE], {
    input: JSON.stringify({ module, custom_nodes: customNodes }),
    encoding: 'utf8',
    env: { ...process.env as Record<string, string>, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** The native side, in the oracle's shape. */
function native(root: string): Oracle {
  const listed = runGlobalSubgraphs({ name: 'list' }, root)
  expect(listed.status).toBe(200)
  const list = listed.body as Record<string, unknown>
  const entries: Oracle['entries'] = {}
  for (const k of [...Object.keys(list), 'no-such-id']) {
    try {
      const r = runGlobalSubgraphs({ name: 'entry', id: k }, root)
      expect(r.status).toBe(200)
      entries[k] = { ok: typeof r.body === 'string' ? JSON.parse(r.body) : r.body }
    }
    catch (e) {
      entries[k] = { error: (e as Error).name }
    }
  }
  return { list, keys: Object.keys(list), entries }
}

describe('R10.6: the native blueprint list', () => {
  it('lists the repo’s blueprints with ComfyUI off: one entry per file, the Python’s own ids', () => {
    expect(BLUEPRINT_FILES.length).toBe(36)
    const r = native(REPO)
    expect(r.keys).toHaveLength(BLUEPRINT_FILES.length)
    for (const f of BLUEPRINT_FILES) {
      const file = path.join(REPO, 'blueprints', f)
      const id = createHash('sha256').update(`templates${file}`).digest('hex')
      expect(r.list[id], f).toEqual({ source: 'templates', name: f.slice(0, -'.json'.length), info: { node_pack: 'comfyui' } })
      const full = r.entries[id]!.ok as { data: string }
      expect(full.data, f).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'))
      expect(() => JSON.parse(full.data), f).not.toThrow()
    }
    expect(r.entries['no-such-id']).toEqual({ ok: null })
  })

  it.skipIf(!hasPython)('equals ComfyUI’s own list and entries for the repo’s blueprints', () => {
    const py = python(path.join(REPO, 'app', 'subgraph_manager.py'), [path.join(fs.realpathSync(REPO), 'custom_nodes')])
    const ours = native(REPO)
    expect(ours.keys).toEqual(py.keys)
    expect(ours.list).toEqual(py.list)
    expect(ours.entries).toEqual(py.entries)
  })

  describe('a temp engine root: a custom node pack, hidden and odd files', () => {
    let root: string
    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-subgraphs-')))
      fs.mkdirSync(path.join(root, 'app'))
      fs.copyFileSync(path.join(REPO, 'app', 'subgraph_manager.py'), path.join(root, 'app', 'subgraph_manager.py'))
      const bp = path.join(root, 'blueprints')
      fs.mkdirSync(bp)
      fs.writeFileSync(path.join(bp, 'Plain.json'), '{"a": 1}\n')
      fs.writeFileSync(path.join(bp, 'Windows lines.json'), '{\r\n"b": 2\r\n}\r')
      fs.writeFileSync(path.join(bp, 'With BOM.json'), '﻿{"c": "é"}')
      fs.writeFileSync(path.join(bp, '.hidden.json'), '{}')
      fs.writeFileSync(path.join(bp, 'Upper.JSON'), '{}')
      fs.writeFileSync(path.join(bp, 'notes.txt'), 'x')
      fs.writeFileSync(path.join(bp, 'put_blueprints_here'), '')
      fs.writeFileSync(path.join(bp, 'Broken.json'), Buffer.from([0x7B, 0xFF, 0x7D]))
      const pack = path.join(root, 'custom_nodes', 'my-pack', 'subgraphs')
      fs.mkdirSync(pack, { recursive: true })
      fs.writeFileSync(path.join(pack, 'Pack graph.json'), '{"d": 4}')
      fs.mkdirSync(path.join(root, 'custom_nodes', 'no-subgraphs'))
      fs.mkdirSync(path.join(root, 'custom_nodes', '.hidden-pack', 'subgraphs'), { recursive: true })
      fs.writeFileSync(path.join(root, 'custom_nodes', '.hidden-pack', 'subgraphs', 'x.json'), '{}')
      fs.writeFileSync(path.join(root, 'custom_nodes', 'loose.py'), '')
    })
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    it('custom nodes first, then the blueprints; text read as Python reads it; a bad file fails alone', () => {
      const r = native(root)
      const names = r.keys.map(k => (r.list[k] as { name: string }).name)
      expect(names[0]).toBe('Pack graph')
      expect(new Set(names)).toEqual(new Set(['Pack graph', 'Plain', 'Windows lines', 'With BOM', 'Broken']))
      const byName = (n: string) => r.keys.find(k => (r.list[k] as { name: string }).name === n)!
      expect(r.list[byName('Pack graph')]).toEqual({ source: 'custom_node', name: 'Pack graph', info: { node_pack: 'custom_nodes.my-pack' } })
      expect((r.entries[byName('Windows lines')]!.ok as { data: string }).data).toBe('{\n"b": 2\n}\n')
      expect((r.entries[byName('With BOM')]!.ok as { data: string }).data).toBe('﻿{"c": "é"}')
      expect(r.entries[byName('Broken')]!.error).toBeDefined()
    })

    it.skipIf(!hasPython)('equals ComfyUI’s own answers', () => {
      const py = python(path.join(root, 'app', 'subgraph_manager.py'), [path.join(root, 'custom_nodes')])
      const ours = native(root)
      expect(ours.keys).toEqual(py.keys)
      expect(ours.list).toEqual(py.list)
      for (const k of Object.keys(py.entries)) {
        // A file Python can't read raises in both (its UnicodeDecodeError, our TypeError): aiohttp's 500 either way.
        if (py.entries[k]!.error) expect(ours.entries[k]!.error, k).toBeDefined()
        else expect(ours.entries[k], k).toEqual(py.entries[k])
      }
    })
  })

  it('no engine root lists nothing', () => {
    expect(runGlobalSubgraphs({ name: 'list' }, null)).toEqual({ status: 200, body: {} })
  })

  it('is a native route in every spelling, with aiohttp’s route table', () => {
    expect(NATIVE_ENGINE_PREFIXES).toEqual(expect.arrayContaining(GLOBAL_SUBGRAPHS_PREFIXES))
    for (const p of ['/global_subgraphs', '/api/global_subgraphs', '/comfyui/global_subgraphs', '/comfyui/api/global_subgraphs?x=1']) {
      expect(nativeEnginePath(p), p).toBe('/global_subgraphs')
    }
    expect(nativeEnginePath('/api/global_subgraphs/abc')).toBe('/global_subgraphs/abc')
    const m = (p: string, v = 'GET') => matchGlobalSubgraphsRoute(p, v, decodeSegment)
    expect(m('/global_subgraphs')).toEqual({ kind: 'route', handler: { name: 'list' } })
    expect(m('/global_subgraphs', 'HEAD')).toEqual({ kind: 'route', handler: { name: 'list' } })
    expect(m('/global_subgraphs/a%20b')).toEqual({ kind: 'route', handler: { name: 'entry', id: 'a b' } })
    expect(m('/global_subgraphs', 'POST')).toEqual({ kind: 'badMethod' })
    expect(m('/global_subgraphs/abc', 'DELETE')).toEqual({ kind: 'badMethod' })
    expect(m('/global_subgraphs/')).toEqual({ kind: 'notFound' })
    expect(m('/global_subgraphs/a/b')).toEqual({ kind: 'notFound' })
    expect(m('/global_subgraphs/%7Bx%7D')).toEqual({ kind: 'notFound' })
  })

  it('an id that is an Object.prototype name is no entry', () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(runGlobalSubgraphs({ name: 'entry', id }, REPO).body, id).toBe('null')
    }
  })
})

/** The blueprints as the canvas adds them (NodesSidebar's `sailor:addNode` with the workflow). */
function blueprintWorkflows(): [string, any][] {
  return BLUEPRINT_FILES.map(f => [f, JSON.parse(fs.readFileSync(path.join(REPO, 'blueprints', f), 'utf8'))])
}

/** Canvas-only nodes graphToPrompt leaves out (never a class run anywhere). */
const CANVAS_ONLY = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'])

/** Saver classes by output type: a blueprint added to the canvas is wired to one of these to run. */
const SAVERS: Record<string, (from: [string, number]) => { class_type: string, inputs: Record<string, unknown> }> = {
  IMAGE: from => ({ class_type: 'PreviewImage', inputs: { images: from } }),
  VIDEO: from => ({ class_type: 'SaveVideo', inputs: { video: from, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } }),
  AUDIO: from => ({ class_type: 'SaveAudio', inputs: { audio: from, filename_prefix: 'audio/ComfyUI' } }),
}

/** Loaders for a blueprint's picture, clip and sound inputs, as a user wires them on the canvas. */
const LOADERS: Record<string, { type: string, widgets: unknown[] }> = {
  IMAGE: { type: 'LoadImage', widgets: ['p.png', 'image'] },
  VIDEO: { type: 'LoadVideo', widgets: ['v.mp4'] },
  AUDIO: { type: 'LoadAudio', widgets: ['a.wav', null, null] },
}

/** The blueprint's workflow with a loader on each picture, clip or sound input it has. */
function withSources(wf: any): any {
  const out = structuredClone(wf)
  out.links ??= []
  let nextNode = 1 + Math.max(0, ...out.nodes.map((n: { id: number }) => Number(n.id) || 0))
  let nextLink = 1 + Math.max(0, out.last_link_id ?? 0, ...out.links.map((l: number[]) => l[0] ?? 0))
  for (const node of [...out.nodes]) {
    ;(node.inputs ?? []).forEach((input: { type: string, link: number | null, widget?: unknown }, slot: number) => {
      const loader = LOADERS[input.type]
      if (!loader || input.link != null || input.widget) return
      const id = nextNode++
      const link = nextLink++
      out.nodes.push({ id, type: loader.type, mode: 0, inputs: [], outputs: [{ name: input.type, type: input.type, links: [link] }], widgets_values: loader.widgets, properties: {} })
      out.links.push([link, id, 0, node.id, slot, input.type])
      input.link = link
    })
  }
  out.last_link_id = nextLink
  return out
}

/** The blueprint's prompt with a saver on each output nothing inside it reads (its subgraph's outputs). */
function withSavers(prompt: Record<string, any>): Record<string, any> {
  const read = new Set<string>()
  for (const n of Object.values(prompt)) {
    for (const v of Object.values(n.inputs ?? {})) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') read.add(`${v[0]}:${v[1]}`)
  }
  const out = { ...prompt }
  for (const [id, n] of Object.entries(prompt)) {
    const types: string[] = CATALOG[n.class_type]?.output ?? []
    types.forEach((t, slot) => {
      if (!SAVERS[t] || [...read].some(r => r.startsWith(`${id}:`))) return
      out[`saver:${id}:${slot}`] = SAVERS[t]!([id, slot])
    })
  }
  return out
}

describe('R10.6: a blueprint runs on Sailor when all its classes do, otherwise R10.2’s words apply', () => {
  it('every class inside every blueprint is one R10.2 knows: none is a custom node', () => {
    for (const [f, wf] of blueprintWorkflows()) {
      const subgraphIds = new Set<string>((wf.definitions?.subgraphs ?? []).map((s: { id: string }) => s.id))
      const classes = new Set<string>()
      for (const n of wf.nodes ?? []) classes.add(n.type)
      for (const s of wf.definitions?.subgraphs ?? []) for (const n of s.nodes ?? []) classes.add(n.type)
      for (const c of classes) {
        if (subgraphIds.has(c) || CANVAS_ONLY.has(c)) continue
        expect(isCustomClass(c), `${f}: ${c}`).toBe(false)
        expect(isLocalOnlyClass(c) || isRetiredClass(c) || Object.hasOwn(NEEDS_LOCAL_ENGINE, c) || !isCustomClass(c), `${f}: ${c}`).toBe(true)
      }
    }
  })

  it('each blueprint: on Sailor when the runner takes it; else the local engine locally (engine up), and plain words in hosted', () => {
    let onSailor = 0
    let toEngine = 0
    let saved = 0
    const unbuilt: string[] = []
    for (const [f, wf] of blueprintWorkflows()) {
      let built: Record<string, any>
      try { built = graphToPrompt(withSources(wf), CATALOG) }
      catch (e) {
        // Known gap, not R10.6's: the canvas's prompt builder has no Reroute or PrimitiveNode, so these four
        // stop with "Unknown node type" before any route is chosen (named in the R10.6 report).
        expect(String((e as Error).message), f).toMatch(/Unknown node type: (Reroute|PrimitiveNode)/)
        unbuilt.push(f)
        continue
      }
      const prompt = withSavers(built)
      expect(Object.keys(prompt).length, f).toBeGreaterThan(0)
      if (Object.keys(prompt).some(id => id.startsWith('saver:'))) saved++
      const titleOf = (id: string) => prompt[id]?._meta?.title ?? f
      if (isRunnerEligible(prompt, EVERY_KNOWN_FAMILY, { plainRefusals: true })) { onSailor++; continue }
      const opts = { runnerOn: true, families: EVERY_KNOWN_FAMILY, catalog: CATALOG, engineUp: true }
      const local = engineRoute([{ prompt, titleOf }], { ...opts, hosted: false })
      // Locally: the local engine (decision 4), or plain words (a node named, or the run's own words when
      // a stand-in left a proxied setting empty); never ComfyUI's name, never a silent fallback.
      if (local.to === 'engine') toEngine++
      else expect(local.description, f).toMatch(/^(“[^”]+”: |Nothing )/)
      if (local.to === 'refused') expect(local.description, f).not.toMatch(/comfy/i)
      else expect(local.to, f).toBe('engine')
      const hosted = engineRoute([{ prompt, titleOf }], { ...opts, hosted: true })
      expect(hosted.to, f).toBe('refused')
      if (hosted.to === 'refused') {
        expect(hosted.description, f).toMatch(/runs? only on the local engine|^(“[^”]+”: |Nothing )/)
        expect(hosted.description, f).not.toMatch(/comfy/i)
      }
      const off = engineRoute([{ prompt, titleOf }], { ...opts, hosted: false, engineUp: false })
      expect(off.to, f).toBe('refused')
    }
    // Every stock blueprint is built on the local diffusion stack today.
    expect(onSailor).toBe(0)
    expect(toEngine).toBeGreaterThan(BLUEPRINT_FILES.length / 2)
    expect(saved).toBeGreaterThan(BLUEPRINT_FILES.length / 2)
    expect(unbuilt.sort()).toEqual(['Canny to Video (LTX 2.0).json', 'Depth to Video (ltx 2.0).json', 'Pose to Video (LTX 2.0).json', 'Text to Audio (ACE-Step 1.5).json'])
  })
})

describe('R10.6: hosted offers no local-only class or blueprint', () => {
  it('hostedOffersClass: the runner’s classes and the cards; never a local-only, retired, custom or local-engine-only class', () => {
    const offered = Object.keys(CATALOG).filter(hostedOffersClass)
    expect(offered.length).toBeGreaterThan(200)
    for (const c of offered) {
      expect(isLocalOnlyClass(c), c).toBe(false)
      expect(isRetiredClass(c), c).toBe(false)
      expect(isCustomClass(c), c).toBe(false)
    }
    // Step 4, C4: Preview video is the runner's now; Font Playground, Kinetic Typography and the per-model nodes are retired.
    for (const c of ['GenerateImageNode', 'GenerateVideoNode', 'Image', 'Video', 'SaveImage', 'FilmShotNode', 'SmartLayout', 'Text', 'Timeline', 'PreviewVideo']) {
      expect(hostedOffersClass(c), c).toBe(true)
    }
    for (const c of ['KSampler', 'CheckpointLoaderSimple', 'GLSLShader', 'RenderType', 'KineticType', 'FluxProRemoteNode', 'MyCustomPackNode', 'GeminiNode']) {
      expect(hostedOffersClass(c), c).toBe(false)
    }
    // Every catalogue class is offered, or is one hosted refuses (C4: no Sailor class still needs the local engine).
    expect(NEEDS_LOCAL_ENGINE).toEqual({})
    for (const c of Object.keys(CATALOG)) {
      if (hostedOffersClass(c)) continue
      expect(isLocalOnlyClass(c) || isRetiredClass(c), c).toBe(true)
    }
  })

  describe('node search', () => {
    const g = globalThis as any
    let saved: { fetch: unknown, config: unknown }
    beforeEach(() => {
      saved = { fetch: g.$fetch, config: g.useRuntimeConfig }
      vi.resetModules()
      g.$fetch = vi.fn(async () => ({ ...CATALOG, MyCustomPackNode: { display_name: 'My custom', category: 'custom', python_module: 'custom_nodes.pack', input: {}, output: [] } }))
    })
    afterEach(() => { g.$fetch = saved.fetch; g.useRuntimeConfig = saved.config })

    async function searched(hosted: boolean): Promise<string[]> {
      g.useRuntimeConfig = () => ({ public: { hostedMode: hosted } })
      const { useNodeSearch } = await import('~/composables/useNodeSearch')
      const s = useNodeSearch()
      await s.fetchNodeTypes()
      return s.nodeTypes.value.map((n: { name: string }) => n.name)
    }

    it('hosted lists only the classes the runner takes, plus the cards', async () => {
      const names = await searched(true)
      expect(names.length).toBeGreaterThan(200)
      expect(names.filter(n => !hostedOffersClass(n))).toEqual([])
      expect(names).toEqual(expect.arrayContaining(['GenerateImageNode', 'SaveImage', 'Timeline']))
      expect(names).not.toContain('KSampler')
      expect(names).not.toContain('MyCustomPackNode')
    })

    it('locally the local-only classes and custom nodes stay offered', async () => {
      const names = await searched(false)
      expect(names).toEqual(expect.arrayContaining(['KSampler', 'CheckpointLoaderSimple', 'MyCustomPackNode', 'GenerateImageNode']))
    })
  })

  it('the sidebar fetches no blueprint and shows no blueprint tab or section in hosted', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'app', 'components', 'vue-canvas', 'NodesSidebar.vue'), 'utf8')
    expect(src).toMatch(/async function fetchBlueprints\(\) \{\n\s+if \(hosted\) return/)
    expect(src).toMatch(/<button\s+v-if="!hosted"[^>]*>\s*Blueprints\s*<\/button>/)
    expect(src).toContain('v-if="!hosted && blueprintTree.size > 0"')
    expect(src).toMatch(/const hosted = \(\(\) => \{\n\s+try \{ return useRuntimeConfig\(\)\.public\?\.hostedMode === true \}/)
  })
})
