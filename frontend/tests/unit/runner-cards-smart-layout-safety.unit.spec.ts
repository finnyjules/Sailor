/**
 * R1.6 fix round 1: Smart Layout's render made safe and kept exact.
 *   1. Photo treatments (duotone, grain) on an image layer bake as they do
 *      for Python's /view address (a real render, compared by pixels).
 *   2. A format under 1 × 1 pixel is refused plainly (runner and route), and
 *      the text fit's loops end.
 *   3. One safe image fetcher (route and runner): no loopback, private or
 *      link-local address, checked again on every redirect; a timeout and a
 *      byte cap.
 *   4. After the job's turn ends (watchdog, Stop), nothing more is written.
 *   5. satori and resvg on a worker the watchdog can terminate; the per-output
 *      and element caps.
 *   6. Preview names checked before any render.
 *   7. A float literal read as Python's str().
 */
import { createServer, type Server } from 'node:http'
import { spawn as realSpawn } from 'node:child_process'
import { serialize } from 'node:v8'
import { randomBytes } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { smartLayoutPixels } from '#shared/runner/smartLayout'
import { fitText } from '#shared/template-grid/text'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore } from '~~/server/runner/results'
import { __setFrameTimeoutForTests } from '~~/server/runner/compositor/worker'
import { PREVIEW_NAME_BAD, layerText, pyFloatStr, smartLayoutRenderer, smartLayoutRequests } from '~~/server/runner/cards/smartLayout'
import { GOOGLE_CACHE_MAX_BYTES, GOOGLE_CACHE_MAX_FAMILIES, GOOGLE_FAILED_MAX, TemplateImageError, __setGoogleFontsForTests, __setRenderDeadlineForTests, loadGoogleFamily, renderTemplatePng } from '~~/server/templates/renderPng'
import { TEMPLATE_SIZE_REFUSED, TemplateSizeError, templateToSatori } from '~~/server/templates/translate'
import { FETCH_REFUSED, FETCH_TIMEOUT, FETCH_TOO_LARGE, addressAllowed, localViewPorts, safeImageFetcher } from '~~/server/templates/safeFetch'
import { CHILD_EXIT_WAIT_MS, RENDER_CRASHED, RENDER_TIMEOUT, __renderChildPidForTests, __renderJobsForTests, __setRenderSpawnForTests, __setRenderTimeoutForTests, childEnv, svgToPngInProcess } from '~~/server/templates/renderProcess'
import { inlineTreeImages, tableTreeImages } from '~~/server/templates/inlineImages'
import { LAYOUT_BAD_IMAGE_ADDRESS, LAYOUT_STYLE_URL } from '#shared/template-grid/limits'
import { LAYOUT_BAD_SHAPE, LAYOUT_MAX_REMOTE_FONTS, LAYOUT_TOO_MANY_FONTS, layoutShapeProblem } from '#shared/template-grid/limits'
import { LAYOUT_IMAGES_TOO_LARGE, LAYOUT_MAX_TEXT, LAYOUT_TOO_BIG, LAYOUT_TOO_MANY_ELEMENTS, LAYOUT_TOO_MANY_READERS, LAYOUT_TOO_MANY_TREATED, LAYOUT_TOO_MUCH_TEXT, LAYOUT_TREATED_TOO_LARGE, LAYOUT_TREATMENT_FAILED, layoutTextProblem } from '#shared/template-grid/limits'
import type { RenderRequest } from '~~/server/templates/schema'
import type { OutputFile } from '~~/server/runner/types'
import { __setInputUploadsEngineRootForTests } from '~~/server/utils/inputUploads'
import { __setViewCacheDirForTests, viewCacheFile } from '~~/server/native/viewRead'

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
/** What a v2 layout needs besides its formats and elements. */
const GRID = { grid: { gutter: 4, margin: 8, baseline: 4 }, typeScale: { base: 12, ratio: 1.2 } }
const FX = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as {
  smart_layout: { execute: { name: string; files: Record<string, string>; frames: Record<string, { w: number; h: number; mode: string; px: string }> }[] }
}).smart_layout
const SNAP = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-smart-layout-render.json'), 'utf8')) as { request: RenderRequest; png_sha256: string }

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`

async function rgb(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await sharp(bytes).removeAlpha().raw().toBuffer())
}

/** A small v2 layout: the image layer full-bleed with a treatment, and a headline. */
function treatedLayout(treatment: Record<string, unknown> | null): string {
  return JSON.stringify({
    version: 2, id: 't', master: 'm', formats: { m: { w: 120, h: 100, label: 'Small' } },
    grid: { columns: 6, rows: 6, gutter: 4, margin: 8 }, typeScale: { base: 12, ratio: 1.2 },
    background: { fill: '#204060' },
    elements: [{
      id: 'image_layer_1', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true,
      style: { fit: 'cover', ...(treatment ? { treatment } : {}) }, content: '{{ props.image_layer_1 }}',
    }],
  })
}

/** Runs a Smart Layout node fed by a LoadImage of `file`, with the real renderer. */
async function runNode(inputs: Record<string, unknown>, files: Record<string, Uint8Array>, o: { hosted?: boolean; nodeId?: string } = {}) {
  const nodeId = o.nodeId ?? '17'
  const prompt: ApiPrompt = { [nodeId]: { class_type: 'SmartLayout', inputs: { aspects: '', brand_kit: '', ...inputs } } }
  const names = Object.keys(files)
  if (names.length) prompt.src = { class_type: 'LoadImage', inputs: { image: names[0], upload: 'image' } }
  const root = mkdtempSync(join(tmpdir(), 'runner-smart-layout-safety-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => !!o.hosted })
  const kept = new Map<string, Uint8Array>()
  const writes: string[] = []
  const plan: NodePlan = await planNode({
    prompt, nodeId, families: CARDS, gateOpen: false,
    filesFrom: link => link[0] === 'src' ? [{ filename: names[0]!, subfolder: '', type: 'input' }] : [],
    toUrl: async () => '',
  })
  const io: DeriveIO = {
    read: async f => files[f.filename] ?? kept.get(keyOf(f)) ?? results.read(f),
    keep: async (bytes) => {
      writes.push('keep')
      const f: OutputFile = { filename: `k${kept.size}.png`, subfolder: '', type: 'kept' }
      kept.set(keyOf(f), bytes)
      return f
    },
    saveAsset: async () => { throw new Error('no assets') },
    savePreview: async () => { throw new Error('no unique previews') },
    savePreviewAs: async (bytes, a) => { writes.push(`preview ${a.filename}`); return results.savePreviewAs(bytes, { filename: a.filename, userId: o.hosted ? 'user_1' : null }) },
    hosted: !!o.hosted, signal: new AbortController().signal, nodeId, runWorkflow: null, runPrompt: prompt,
  }
  const made = (plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)
  return { made: made as Promise<Derived>, kept, writes }
}

let server: Server
let base = ''
let hits: string[] = []
/** R10.8: the files a loopback /view names, read off disk (the engine folders of a scratch root). */
let viewPng: Buffer
let viewRoot = ''
beforeAll(async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
  viewPng = png
  const root = mkdtempSync(join(tmpdir(), 'r108-view-root-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  for (const name of ['own.png', 'a.png', 'wired.png', 'plain.png']) writeFileSync(join(root, 'output', name), png)
  writeFileSync(join(root, 'temp', 'a.png'), png)
  writeFileSync(join(root, 'output', 'big.png'), Buffer.alloc(4096))
  viewRoot = root
  // GET /view's kept copies (a scratch folder, never the real .cache/images).
  const cacheDir = join(root, 'view-cache')
  mkdirSync(cacheDir)
  __setViewCacheDirForTests(cacheDir)
  writeFileSync(viewCacheFile('gone.png', 'temp', ''), png)
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/view?redirect')) { res.writeHead(302, { location: '/internal-admin' }); res.end(); return }
    if (req.url?.startsWith('/view?slow')) return // never answers
    if (req.url?.startsWith('/view?big')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(4096)); return }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close(); __setViewCacheDirForTests(null) })
// After the setup file's own empty root (tests/unit/__setup__/engine-root-safety-net.ts).
beforeEach(() => { __setInputUploadsEngineRootForTests(viewRoot) })
afterEach(() => {
  hits = []
  vi.restoreAllMocks()
  __setFrameTimeoutForTests(null)
  __setRenderTimeoutForTests(null)
  vi.unstubAllEnvs()
})

/** Whether a process is gone within `ms`. */
const gone = async (pid: number, ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { process.kill(pid, 0) }
    catch { return true }
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

// ── 1. treatments ────────────────────────────────────────────────────────────


/** Step 4, C5: the safe fetcher with the route's own port (3002 here) as the one loopback /view it reads by name. */
const ownPort = (o: { maxBytes?: number } = {}) => safeImageFetcher({ hosted: false, viewPorts: [3002], ...o })

describe('photo treatments on an image layer (a real render)', () => {
  const c = FX.execute.find(e => e.name.startsWith('the starter'))!
  const name = Object.keys(c.files)[0]!
  const frame = c.frames.image_layer_1!

  for (const treatment of [{ kind: 'duotone' }, { kind: 'duotone', intensity: 0.5 }, { kind: 'grain', intensity: 0.6 }]) {
    it(`bakes ${JSON.stringify(treatment)} as the route does for Python's /view address`, async () => {
      const layout = treatedLayout(treatment)
      const { made, kept } = await runNode({ layout, image_layer_1: ['src', 0] }, { [name]: b64(c.files[name]!) })
      const out = await made
      const [file] = (out.values[0] as { files: OutputFile[] }).files
      // What Python's path renders: its /view address, answered with the saved
      // frame's pixels (PIL's bytes differ from sharp's; the pixels are the same).
      const pythonFrame = await sharp(b64(frame.px), { raw: { width: frame.w, height: frame.h, channels: frame.mode.length as 3 } }).png({ compressionLevel: 9 }).toBuffer()
      const [req] = smartLayoutRequests({ layout, aspects: '' }, { image_layer_1: 'http://127.0.0.1:8188/view?filename=smartlayout_image_layer_1_1.png&type=temp' })
      const route = await renderTemplatePng(req!, { fetcher: async () => ({ data: pythonFrame.buffer.slice(pythonFrame.byteOffset, pythonFrame.byteOffset + pythonFrame.byteLength) as ArrayBuffer, contentType: 'image/png' }) })
      const untreated = await renderTemplatePng(smartLayoutRequests({ layout: treatedLayout(null), aspects: '' }, { image_layer_1: 'http://x.test/view' })[0]!, {
        fetcher: async () => ({ data: pythonFrame.buffer.slice(pythonFrame.byteOffset, pythonFrame.byteOffset + pythonFrame.byteLength) as ArrayBuffer, contentType: 'image/png' }),
      })
      const ours = await rgb(kept.get(keyOf(file!))!)
      expect(Buffer.compare(ours, await rgb(route))).toBe(0)
      // The treatment is really there: the untreated render differs.
      expect(Buffer.compare(ours, await rgb(untreated))).not.toBe(0)
    }, 60_000)
  }
})

// ── 2. sizes under one pixel ─────────────────────────────────────────────────

describe('a format under 1 × 1 pixel', () => {
  const zero = (w: number, h: number) => JSON.stringify({ version: 2, id: 'z', master: 'z', formats: { z: { w, h } }, ...GRID, elements: [] })

  it('is refused by the translation at once, not worked on for ever', () => {
    for (const [w, h] of [[1080, 0], [0, 1080], [1080, 0.5], [-5, 100]] as const) {
      const req = smartLayoutRequests({ layout: zero(w, h), aspects: '', text_layer_1: 'Spring drop' }, {})[0]!
      expect(() => templateToSatori(req.template, req.aspect, req.props, req.brand, undefined, req.outputId)).toThrow(TemplateSizeError)
    }
  })

  it('fails the runner node plainly before any render; eligibility keeps it (the engine refuses it too)', async () => {
    const render = vi.spyOn(smartLayoutRenderer, 'render')
    await expect(planNode({
      prompt: { l: { class_type: 'SmartLayout', inputs: { layout: zero(1080, 0), aspects: '', brand_kit: '', text_layer_1: 'x' } } },
      nodeId: 'l', families: CARDS, gateOpen: false, filesFrom: () => [], toUrl: async () => '',
    })).rejects.toThrow(TEMPLATE_SIZE_REFUSED)
    expect(render).not.toHaveBeenCalled()
    expect(smartLayoutPixels({ layout: zero(1080, 0), aspects: '' })).toBe(0)
    expect(isRunnerEligible({ l: { class_type: 'SmartLayout', inputs: { layout: zero(1080, 0), aspects: '', brand_kit: '' } } }, CARDS)).toBe(true)
  })

  it('the route answers 400 in plain words', async () => {
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', async () => smartLayoutRequests({ layout: zero(1080, 0), aspects: '', text_layer_1: 'x' }, {})[0])
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      await expect(route({})).rejects.toMatchObject({ statusCode: 400, statusMessage: TEMPLATE_SIZE_REFUSED })
    }
    finally { vi.unstubAllGlobals() }
  })

  it('the text fit ends on a size that is not a finite number', () => {
    const r = fitText({ content: 'a long headline that never fits', maxFontSize: Infinity, w: 100, h: 10, lineHeight: 1.1, overflow: 'shrink' })
    expect(r.clipped).toBe(true)
    const huge = JSON.stringify({ version: 2, id: 'h', master: 'a', formats: { a: { w: 200, h: 200 } }, ...GRID, typeScale: { base: 28, ratio: 1e300 }, elements: [] })
    const req = smartLayoutRequests({ layout: huge, aspects: '', text_layer_1: 'Spring drop' }, {})[0]!
    expect(() => templateToSatori(req.template, req.aspect, req.props, req.brand, undefined, req.outputId)).not.toThrow()
  })
})

// ── 3. the safe fetcher ──────────────────────────────────────────────────────

describe('the image fetcher (route and runner)', () => {
  it('refuses loopback, private, link-local, unique-local and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(addressAllowed(a), a).toBe(false)
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(addressAllowed(a), a).toBe(true)
    expect(addressAllowed('127.0.0.1', true)).toBe(true)
    expect(addressAllowed('10.0.0.1', true)).toBe(false)
  })

  it('refuses a local server address, by IP and by name, and never reaches it', async () => {
    const f = safeImageFetcher({ hosted: false })
    await expect(f(`${base}/internal-admin?secret=1`)).rejects.toThrow(FETCH_REFUSED)
    await expect(f(`${base.replace('127.0.0.1', 'localhost')}/internal-admin`)).rejects.toThrow(FETCH_REFUSED)
    await expect(f('file:///etc/passwd')).rejects.toThrow(FETCH_REFUSED)
    expect(hits).toEqual([])
  })

  it('locally, a loopback /view on the route’s own port is read off disk, never fetched; any other port (C5: the engine’s too), or hosted, is refused', async () => {
    await expect(safeImageFetcher({ hosted: false })(`${base}/view?filename=a.png&type=temp`)).rejects.toThrow(FETCH_REFUSED)
    const port = Number(new URL(base).port)
    const own = await safeImageFetcher({ hosted: false, viewPorts: [port] })(`${base}/view?filename=own.png`)
    expect(own.contentType).toBe('image/png')
    expect(Buffer.from(own.data).equals(viewPng)).toBe(true)
    // R10.8: read by name off disk, never connected to: the port needs nothing listening on it.
    const got = await ownPort()('http://127.0.0.1:3002/view?filename=a.png&type=temp')
    expect(got.contentType).toBe('image/png')
    expect(Buffer.from(got.data).equals(viewPng)).toBe(true)
    // Step 4, C5: the engine's port is no longer one Sailor reads by name.
    await expect(safeImageFetcher({ hosted: false })('http://127.0.0.1:8188/view?filename=a.png&type=temp')).rejects.toThrow(FETCH_REFUSED)
    // Read by name, under GET /view's own rules.
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=missing.png')).rejects.toThrow('image fetch failed (404)')
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=../a.png')).rejects.toThrow('image fetch failed (400)')
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=a.png&subfolder=..')).rejects.toThrow('image fetch failed (403)')
    await expect(safeImageFetcher({ hosted: true })(`${base}/view?filename=a.png`)).rejects.toThrow(FETCH_REFUSED)
    await expect(safeImageFetcher({ hosted: true })('http://127.0.0.1:8188/view?filename=a.png')).rejects.toThrow(FETCH_REFUSED)
    expect(hits).toEqual([])
  })

  it('a temp picture gone from disk is read from GET /view’s kept copy (fix round 1, M3)', async () => {
    const got = await ownPort()('http://127.0.0.1:3002/view?filename=gone.png&type=temp')
    expect(Buffer.from(got.data).equals(viewPng)).toBe(true)
    expect(got.contentType).toBe('image/png')
    // The copy is keyed by type too: an output of that name has none.
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=gone.png')).rejects.toThrow('image fetch failed (404)')
    // A refused name never reaches the copy.
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=../gone.png&type=temp')).rejects.toThrow('image fetch failed (400)')
    expect(hits).toEqual([])
  })

  it('an allowed /view is read off disk; another path on the same host is refused', async () => {
    const port = Number(new URL(base).port)
    const f = safeImageFetcher({ hosted: false, viewPorts: [port] })
    for (const host of [base, base.replace('127.0.0.1', 'localhost')]) {
      await f(`${host}/view?filename=a.png`)
      await expect(f(`${host}/admin?secret=1`)).rejects.toThrow(FETCH_REFUSED)
      await expect(f(`${host}/view/`)).rejects.toThrow(FETCH_REFUSED)
    }
    expect(hits).toEqual([])
  })

  it('refuses the IPv6 forms that carry an IPv4 address, and site-local', () => {
    for (const a of ['::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:7f00:1', '2002:7f00:1::1', '2001::1', 'fec0::1', '64:ff9b::7f00:1']) expect(addressAllowed(a), a).toBe(false)
  })

  it('a loopback /view is never asked, so it can’t redirect anywhere', async () => {
    const port = Number(new URL(base).port)
    await expect(safeImageFetcher({ hosted: false, viewPorts: [port] })(`${base}/view?redirect=1`)).rejects.toThrow('image fetch failed (404)')
    expect(hits).toEqual([])
  })

  it('stops at its byte cap (a file read off disk too)', async () => {
    await expect(ownPort({ maxBytes: 1000 })('http://127.0.0.1:3002/view?filename=big.png')).rejects.toThrow(FETCH_TOO_LARGE)
    expect(hits).toEqual([])
    // FETCH_TIMEOUT: a download's limit (no loopback answer is downloaded any more).
    expect(FETCH_TIMEOUT).toMatch(/20 seconds/)
  })

  it('the route’s render refuses a layout naming a local server, without fetching it', async () => {
    const req = smartLayoutRequests({ layout: JSON.stringify({ version: 2, id: 's', master: 'a', formats: { a: { w: 120, h: 120 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [{ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover' }, content: `${base}/internal-admin?secret=1` }] }), aspects: '' }, {})[0]!
    const e = await renderTemplatePng(req).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TemplateImageError)
    expect((e as Error).message).toBe(FETCH_REFUSED)
    expect(hits).toEqual([])
  })

  it('the runner node fails in the same words, without fetching it', async () => {
    const layout = JSON.stringify({ version: 2, id: 's', master: 'a', formats: { a: { w: 120, h: 120 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [{ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover' }, content: `${base}/view?x=1` }] })
    const { made } = await runNode({ layout }, {}, { hosted: true })
    await expect(made).rejects.toThrow(FETCH_REFUSED)
    expect(hits).toEqual([])
  })
})

// ── 4 and 5. the watchdog, the worker ────────────────────────────────────────

describe('the render process and the job’s turn', () => {
  it('a render past the Frame queue’s watchdog writes nothing after it', async () => {
    __setFrameTimeoutForTests(100)
    let finish!: () => void
    vi.spyOn(smartLayoutRenderer, 'render').mockImplementation(async () => {
      await new Promise<void>(r => { finish = r })
      return sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer().then(b => new Uint8Array(b))
    })
    const { made, writes } = await runNode({ layout: '', aspects: '320x50,728x90' }, {})
    await expect(made).rejects.toThrow(/longer than 2 minutes/)
    finish()
    await new Promise(r => setTimeout(r, 200))
    expect(writes).toEqual([])
  })

  it('the render process gives the route snapshot’s bytes, and the server keeps answering while it renders', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    const png = await renderTemplatePng({ ...SNAP.request, template: { ...(SNAP.request.template as object), formats: { ...((SNAP.request.template as { formats: object }).formats), big: { w: 2048, h: 2048 } } } as never, aspect: 'big', outputId: 'big' })
    clearInterval(timer)
    expect(png.length).toBeGreaterThan(0)
    expect(ticks).toBeGreaterThan(5)
    const again = await renderTemplatePng(SNAP.request)
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', again)).toString('hex')).toBe(SNAP.png_sha256)
  }, 60_000)

  const heavy = () => {
    const t = SNAP.request.template as { formats: object }
    return { ...SNAP.request, template: { ...t, formats: { ...t.formats, big: { w: 8192, h: 8192 } } } as never, aspect: 'big', outputId: 'big' }
  }

  it('a render past its limit is stopped: its process is killed and gone within a second; the next render works', async () => {
    await renderTemplatePng(SNAP.request)
    const pid = __renderChildPidForTests()!
    __setRenderTimeoutForTests(300)
    await expect(renderTemplatePng(heavy())).rejects.toThrow(RENDER_TIMEOUT)
    const stoppedAt = Date.now()
    expect(await gone(pid, 1000)).toBe(true)
    expect(Date.now() - stoppedAt).toBeLessThan(1000)
    __setRenderTimeoutForTests(null)
    const again = await renderTemplatePng(SNAP.request)
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', again)).toString('hex')).toBe(SNAP.png_sha256)
    expect(__renderChildPidForTests()).not.toBe(pid)
  }, 60_000)

  it('an abort (Stop) kills the render’s process within a second', async () => {
    await renderTemplatePng(SNAP.request)
    const pid = __renderChildPidForTests()!
    const ctl = new AbortController()
    const p = renderTemplatePng(heavy(), { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 300)
    await expect(p).rejects.toThrow('Stopped')
    expect(await gone(pid, 1000)).toBe(true)
  }, 60_000)

  it('width 1e9: refused plainly before any render; forced into the renderer, only its process dies', async () => {
    await expect(renderTemplatePng({ ...SNAP.request, width: 1e9, height: 1 })).rejects.toThrow(LAYOUT_TOO_BIG)
    const out = await svgToPngInProcess({ tree: { type: 'div', props: { style: { width: 1e9, height: 1, display: 'flex' } } }, width: 1e9, height: 1, fonts: [] }).catch((e: Error) => e)
    expect(out).toBeInstanceOf(Error)
    // The server (this process) is alive and the next render is exact.
    const again = await renderTemplatePng(SNAP.request)
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', again)).toString('hex')).toBe(SNAP.png_sha256)
  }, 60_000)

  it('the route stops its render when the client goes away', async () => {
    const { EventEmitter } = await import('node:events')
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const t = SNAP.request.template as { formats: object }
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', async () => ({ ...SNAP.request, template: { ...t, formats: { ...t.formats, big: { w: 8192, h: 8192 } } }, aspect: 'big', outputId: 'big' }))
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      await renderTemplatePng(SNAP.request)
      const pid = __renderChildPidForTests()!
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      const p = route({ node: { req: { socket: { localPort: 3999 } }, res } })
      setTimeout(() => res.emit('close'), 300)
      await expect(p).rejects.toMatchObject({ statusCode: 499 })
      expect(await gone(pid, 1000)).toBe(true)
    }
    finally { vi.unstubAllGlobals() }
  }, 60_000)

  it('an abort before its turn stops the render', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(svgToPngInProcess({ tree: { type: 'div', props: { style: { width: 10, height: 10 } } }, width: 10, height: 10, fonts: [] }, ctl.signal)).rejects.toThrow('Stopped')
  })
})

// ── Round 2: sizes, text, the grain bake ─────────────────────────────────────

describe('round 2: the renderer’s limits (route and runner)', () => {
  const plan = (layout: string, extra: Record<string, unknown> = {}) => planNode({
    prompt: { l: { class_type: 'SmartLayout', inputs: { layout, aspects: '', brand_kit: '', ...extra } } },
    nodeId: 'l', families: CARDS, gateOpen: false, filesFrom: () => [], toUrl: async () => '',
  })
  const sized = (w: number, h: number) => JSON.stringify({ version: 2, id: 'z', master: 'z', formats: { z: { w, h } }, ...GRID, elements: [] })

  it('each side at most 16384 and at most 8192² pixels: the translation, the route (400) and the runner refuse plainly', async () => {
    for (const [w, h] of [[16385, 10], [10, 16385], [8193, 8192], [1e9, 1]] as const) {
      const req = smartLayoutRequests({ layout: sized(w, h), aspects: '' }, {})[0]!
      expect(() => templateToSatori(req.template, req.aspect, req.props, req.brand, undefined, req.outputId), `${w}×${h}`).toThrow(LAYOUT_TOO_BIG)
      await expect(plan(sized(w, h)), `${w}×${h}`).rejects.toThrow(LAYOUT_TOO_BIG)
    }
    const req = smartLayoutRequests({ layout: sized(16384, 4096), aspects: '' }, {})[0]!
    expect(() => templateToSatori(req.template, req.aspect, req.props, req.brand, undefined, req.outputId)).not.toThrow()
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', async () => ({ ...SNAP.request, width: 20000, height: 10 }))
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      await expect(route({})).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_TOO_BIG })
    }
    finally { vi.unstubAllGlobals() }
  })

  it('at most 20,000 characters of text in all, and 8 elements per wired text: refused plainly', async () => {
    const reading = (n: number) => JSON.stringify({ version: 2, id: 'r', master: 'a', formats: { a: { w: 200, h: 200 } }, ...GRID, elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: 'text', content: '{{ props.text_layer_1 }}' })) })
    expect(layoutTextProblem(JSON.parse(reading(8)), { text_layer_1: 'x' })).toBeNull()
    expect(layoutTextProblem(JSON.parse(reading(9)), { text_layer_1: 'x' })).toBe(LAYOUT_TOO_MANY_READERS)
    expect(layoutTextProblem(JSON.parse(reading(2)), { text_layer_1: 'x'.repeat(LAYOUT_MAX_TEXT / 2) })).toBeNull()
    expect(layoutTextProblem(JSON.parse(reading(2)), { text_layer_1: 'x'.repeat(LAYOUT_MAX_TEXT / 2 + 1) })).toBe(LAYOUT_TOO_MUCH_TEXT)
    expect(layoutTextProblem({ elements: [{ content: 'y'.repeat(LAYOUT_MAX_TEXT + 1) }] })).toBe(LAYOUT_TOO_MUCH_TEXT)
    const render = vi.spyOn(smartLayoutRenderer, 'render')
    await expect(plan('', { aspects: '1x1', text_layer_1: 'x'.repeat(LAYOUT_MAX_TEXT + 1) })).rejects.toThrow(LAYOUT_TOO_MUCH_TEXT)
    await expect(plan(reading(9), { text_layer_1: 'x' })).rejects.toThrow(LAYOUT_TOO_MANY_READERS)
    expect(render).not.toHaveBeenCalled()
    const req = smartLayoutRequests({ layout: reading(9), aspects: '', text_layer_1: 'x' }, {})[0]!
    expect(() => templateToSatori(req.template, req.aspect, req.props, req.brand, undefined, req.outputId)).toThrow(LAYOUT_TOO_MANY_READERS)
  })

  it('translation within the limits stays well under 200 ms on the main thread (worst cases measured: ~21 ms)', () => {
    const grid = { grid: { gutter: 4, margin: 8, baseline: 4, columns: 12, rows: 400 }, typeScale: { base: 28, ratio: 3 } }
    const el = (i: number, content: string) => ({ id: `t${i}`, type: 'text', priority: 1, level: 'display', region: { col: 1, colSpan: 1, row: 1, rowSpan: 1 }, overflow: 'shrink', content })
    for (const t of [
      { version: 2, id: 'm', master: 'a', formats: { a: { w: 1080, h: 1080 } }, ...grid, elements: [el(0, 'w '.repeat(9999))] },
      { version: 2, id: 'm', master: 'a', formats: { a: { w: 1080, h: 1080 } }, ...grid, elements: Array.from({ length: 256 }, (_, i) => el(i, 'ab '.repeat(26))) },
    ]) {
      const t0 = performance.now()
      templateToSatori(t as never, 'a', {}, {}, undefined, undefined)
      expect(performance.now() - t0).toBeLessThan(200)
    }
  })

  it('a treated picture is baked once per (picture, treatment), not per element', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer()
    const img = (treatment: unknown) => ({ type: 'img', props: { src: 'http://pic.test/a.png', __treatment: treatment } })
    const duo = { kind: 'duotone', intensity: 1, ink: '#112233' }
    const grain = { kind: 'grain', intensity: 0.5, ink: '#112233' }
    const tree = { type: 'div', props: { children: [img(duo), img(duo), img(duo), img(grain), img(grain), img(null)] } }
    let fetches = 0
    const before = __renderJobsForTests()
    await inlineTreeImages(tree, async () => { fetches++; return { data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, contentType: 'image/png' } })
    expect(fetches).toBe(1)
    expect(__renderJobsForTests() - before).toBe(2)
    const srcs = (tree.props.children as { props: { src: string } }[]).map(c => c.props.src)
    expect(new Set(srcs).size).toBe(3)
  })
})

// ── Round 3 ──────────────────────────────────────────────────────────────────

describe('round 3', () => {
  /** A spawn that fails as EMFILE does: no send, an 'error', never an 'exit'. */
  const failingSpawn = (seen: { env?: NodeJS.ProcessEnv }[]) => ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
    seen.push(o)
    const p = Object.assign(new EventEmitter(), { pid: undefined, channel: undefined })
    setImmediate(() => p.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })))
    return p
  }) as never

  it('a spawn that fails (EMFILE) fails its render plainly and never wedges the next ones', async () => {
    await renderTemplatePng(SNAP.request)
    // The live child is let go, so the next job must spawn.
    const pid = __renderChildPidForTests()
    if (pid) process.kill(pid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 200))
    const seen: { env?: NodeJS.ProcessEnv }[] = []
    __setRenderSpawnForTests(failingSpawn(seen))
    await expect(svgToPngInProcess({ tree: { type: 'div', props: { style: { width: 10, height: 10 } } }, width: 10, height: 10, fonts: [] })).rejects.toThrow(RENDER_CRASHED)
    expect(seen.length).toBe(1)
    __setRenderSpawnForTests(null)
    const t0 = Date.now()
    const again = await renderTemplatePng(SNAP.request)
    expect(Date.now() - t0).toBeLessThan(CHILD_EXIT_WAIT_MS)
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', again)).toString('hex')).toBe(SNAP.png_sha256)
  }, 60_000)

  it('the child is spawned with a minimal environment: no API keys or secrets', async () => {
    expect(childEnv({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', FAL_KEY: 'k', NUXT_CLERK_SECRET_KEY: 's', OPENAI_API_KEY: 'o', NODE_OPTIONS: '--x' })).toEqual({ PATH: '/bin', HOME: '/h', TMPDIR: '/t' })
    vi.stubEnv('FAL_KEY', 'secret-test-value')
    const pid = __renderChildPidForTests()
    if (pid) process.kill(pid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 200))
    const seen: { env?: NodeJS.ProcessEnv }[] = []
    __setRenderSpawnForTests(failingSpawn(seen))
    await svgToPngInProcess({ tree: { type: 'div', props: {} }, width: 10, height: 10, fonts: [] }).catch(() => {})
    __setRenderSpawnForTests(null)
    expect(Object.keys(seen[0]!.env!).every(k => ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'windir'].includes(k))).toBe(true)
    expect(JSON.stringify(seen[0]!.env)).not.toContain('secret-test-value')
  })

  it('under nuxi dev (a Unix socket, no local port) the editor’s loopback /view on the app’s port is read', async () => {
    // A socket over a Unix path has no localPort, as nuxi dev's worker.
    const sockPath = join(mkdtempSync(join(tmpdir(), 'r16-sock-')), 's.sock')
    const unix = createNetServer(s => s.end())
    await new Promise<void>(r => unix.listen(sockPath, r))
    const client = connect(sockPath)
    await new Promise<void>(r => client.once('connect', () => r()))
    expect(client.localPort).toBeUndefined()
    client.destroy()
    unix.close()
    const port = Number(new URL(base).port)
    expect(localViewPorts({ localPort: undefined, env: { NUXT_PORT: String(port) } })).toEqual([port])
    expect(localViewPorts({ env: { NUXT_PORT: '3002' } })).toEqual([3002])
    // The app's configured port (round 4: never the Host header's).
    vi.stubEnv('NUXT_PORT', String(port))
    // Through the route: a wired picture at the app's own address.
    const layout = JSON.stringify({ version: 2, id: 's', master: 'a', formats: { a: { w: 120, h: 120 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [{ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover' }, content: `${base}/view?filename=wired.png` }] })
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', async () => smartLayoutRequests({ layout, aspects: '' }, {})[0])
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      const png = await route({ node: { req: { socket: {}, headers: { host: `127.0.0.1:${port}` } }, res: new EventEmitter() } })
      expect(png.length).toBeGreaterThan(0)
      // R10.8: read off disk by name, not asked of the port.
      expect(hits).toEqual([])
      // Round 4: a Host header naming the port no longer opens it.
      vi.stubEnv('NUXT_PORT', '1')
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `evil.test:${port}`]) {
        await expect(route({ node: { req: { socket: {}, headers: { host } }, res: new EventEmitter() } })).rejects.toMatchObject({ statusCode: 502, statusMessage: FETCH_REFUSED })
      }
      expect(hits).toEqual([])
    }
    finally { vi.unstubAllGlobals() }
  }, 60_000)

  const buf = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  const treatedTree = (srcs: string[], kind = 'grain') => ({ type: 'div', props: { children: srcs.map(src => ({ type: 'img', props: { src, __treatment: { kind, intensity: 0.5, ink: '#123456' } } })) } })

  it('at most 4 different treated pictures: refused before any fetch', async () => {
    let fetches = 0
    const tree = treatedTree(['a', 'b', 'c', 'd', 'e'].map(x => `http://pic.test/${x}.png`))
    await expect(inlineTreeImages(tree, async () => { fetches++; throw new Error('no') })).rejects.toThrow(LAYOUT_TOO_MANY_TREATED)
    expect(fetches).toBe(0)
  })

  it('a treated picture over 4096 × 4096 is refused from its header, before its bake is queued; no untreated fall-back', async () => {
    const big = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: '#808080' } }).png().toBuffer()
    const before = __renderJobsForTests()
    await expect(inlineTreeImages(treatedTree(['http://pic.test/big.png']), async () => ({ data: buf(big), contentType: 'image/png' }))).rejects.toThrow(LAYOUT_TREATED_TOO_LARGE)
    expect(__renderJobsForTests()).toBe(before)
    // A picture the bake can't read fails the render, not shown untreated.
    await expect(inlineTreeImages(treatedTree(['http://pic.test/bad.png']), async () => ({ data: buf(Buffer.from('not a picture')), contentType: 'image/png' }))).rejects.toThrow(LAYOUT_TREATMENT_FAILED)
    // One whose header reads but whose pixels don't (cut short): its bake fails, and so does the render.
    const whole = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()
    const cut = whole.subarray(0, whole.length - 20)
    expect((await sharp(cut).metadata()).width).toBe(64)
    await expect(inlineTreeImages(treatedTree(['http://pic.test/cut.png']), async () => ({ data: buf(Buffer.from(cut)), contentType: 'image/png' }))).rejects.toThrow(LAYOUT_TREATMENT_FAILED)
    // The route answers 400 for the limits.
    const layout = JSON.stringify({ version: 2, id: 's', master: 'a', formats: { a: { w: 120, h: 120 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [{ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover', treatment: { kind: 'grain' } }, content: 'http://pic.test/big.png' }] })
    const e = await renderTemplatePng(smartLayoutRequests({ layout, aspects: '' }, {})[0]!, { fetcher: async () => ({ data: buf(big), contentType: 'image/png' }) }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TemplateSizeError)
    expect((e as Error).message).toBe(LAYOUT_TREATED_TOO_LARGE)
  }, 60_000)

  it('Stop ends a bake: its process is killed within a second', async () => {
    const pic = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#808080' } }).png().toBuffer()
    await renderTemplatePng(SNAP.request)
    const pid = __renderChildPidForTests()!
    const ctl = new AbortController()
    const p = inlineTreeImages(treatedTree(['http://pic.test/a.png', 'http://pic.test/b.png']), async () => ({ data: buf(pic), contentType: 'image/png' }), { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 400)
    const t0 = Date.now()
    await expect(p).rejects.toThrow('Stopped')
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(await gone(pid, 1000)).toBe(true)
  }, 60_000)

  it('one deadline for the whole render, fetches included', async () => {
    __setRenderDeadlineForTests(300)
    try {
      const layout = JSON.stringify({ version: 2, id: 's', master: 'a', formats: { a: { w: 120, h: 120 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [{ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover' }, content: 'http://pic.test/slow.png' }] })
      // A download that never answers, ended only by the render's signal.
      const slow = (_url: string, o: { signal?: AbortSignal } = {}) => new Promise<never>((_r, j) => o.signal?.addEventListener('abort', () => j(new Error('Stopped'))))
      const t0 = Date.now()
      await expect(renderTemplatePng(smartLayoutRequests({ layout, aspects: '' }, {})[0]!, { fetcher: slow })).rejects.toThrow(RENDER_TIMEOUT)
      expect(Date.now() - t0).toBeLessThan(2000)
    }
    finally { __setRenderDeadlineForTests(null) }
  })

  it('at most 100 MB of pictures per render, counted as they arrive', async () => {
    const big = new ArrayBuffer(60 * 1024 * 1024)
    const tree = { type: 'div', props: { children: ['a', 'b'].map(x => ({ type: 'img', props: { src: `http://pic.test/${x}.png` } })) } }
    await expect(inlineTreeImages(tree, async () => ({ data: big, contentType: 'image/png' }))).rejects.toThrow(LAYOUT_IMAGES_TOO_LARGE)
    await expect(ownPort()('http://127.0.0.1:3002/view?filename=big.png', { budget: { left: 1000 } })).rejects.toThrow(LAYOUT_IMAGES_TOO_LARGE)
  })

  it('at most 256 elements, for the route too; the route’s body is limited', async () => {
    const crowded = { version: 2, id: 'c', master: 'a', formats: { a: { w: 64, h: 64 } }, ...GRID, elements: Array.from({ length: 257 }, (_, i) => ({ id: `e${i}`, type: 'shape', region: { col: 1, colSpan: 1, row: 1, rowSpan: 1 } })) }
    expect(() => templateToSatori(crowded as never, 'a', {}, {}, undefined, undefined)).toThrow(LAYOUT_TOO_MANY_ELEMENTS)
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      vi.stubGlobal('readBody', async () => ({ template: crowded, aspect: 'a' }))
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      await expect(route({ node: { req: { socket: {}, headers: {} }, res: new EventEmitter() } })).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_TOO_MANY_ELEMENTS })
      const readBody = vi.fn()
      vi.stubGlobal('readBody', readBody)
      await expect(route({ node: { req: { socket: {}, headers: { 'content-length': String(9 * 1024 * 1024) } }, res: new EventEmitter() } })).rejects.toMatchObject({ statusCode: 413 })
      const chunked = Object.assign(Readable.from([Buffer.alloc(5 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)]), { headers: { 'transfer-encoding': 'chunked' }, socket: {} })
      await expect(route({ node: { req: chunked, res: new EventEmitter() } })).rejects.toMatchObject({ statusCode: 413 })
      expect(readBody).not.toHaveBeenCalled()
    }
    finally { vi.unstubAllGlobals() }
  })

  it('refuses 2001:20::/28, 3fff::/20 and 5f00::/16', () => {
    for (const a of ['2001:20::1', '2001:2f::1', '3fff::1', '3fff:fff::1', '5f00::1', '5f00:ffff::1']) expect(addressAllowed(a), a).toBe(false)
    expect(addressAllowed('2001:4860:4860::8888')).toBe(true)
  })
})

// ── 6 and 7 ──────────────────────────────────────────────────────────────────

// ── Round 4 ──────────────────────────────────────────────────────────────────

describe('round 4', () => {
  const FRONTEND = resolve(__dirname, '../..')
  const buf4 = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  /** A v2 layout of `n` full-bleed image elements all showing `src`. */
  const repeated = (src: string, n: number, extra: Record<string, unknown> = {}) => ({
    version: 2, id: 'r', master: 'a', formats: { a: { w: 64, h: 64 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 },
    elements: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover', ...extra }, content: src })),
  })
  const routeWith = async (body: unknown) => {
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    vi.stubGlobal('readBody', async () => body)
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      return await route({ node: { req: { socket: {}, headers: {} }, res: new EventEmitter() } })
    }
    finally { vi.unstubAllGlobals() }
  }

  it('a real EMFILE spawn never signals the process group: a sentinel in the same group survives and later renders work', async () => {
    // Run in its own session and process group (detached → setsid), with a
    // hard fd limit and a sentinel `sleep` in that group. Nothing outside it
    // is ever signalled: the sentinel is ended by its own pid afterwards.
    const dir = mkdtempSync(join(tmpdir(), 'r16-emfile-'))
    const script = join(dir, 'child.mjs')
    writeFileSync(script, `
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
const [jitiPath, modPath] = process.argv.slice(2)
const { createJiti } = await import(jitiPath)
const rp = await createJiti(import.meta.url).import(modPath)
const job = { tree: { type: 'div', props: { style: { width: 10, height: 10, display: 'flex', background: '#f00' } } }, width: 10, height: 10, fonts: [] }
const out = {}
out.warm = (await rp.svgToPngInProcess(job)).length
const pid = rp.__renderChildPidForTests()
if (typeof pid === 'number' && pid > 0) process.kill(pid, 'SIGKILL')
await new Promise(r => setTimeout(r, 300))
const seen = []
rp.__setRenderSpawnForTests((...a) => { const p = spawn(...a); seen.push(p.pid ?? null); return p })
const fds = []
try { for (;;) fds.push(openSync('/dev/null', 'r')) } catch (e) { out.code = e.code }
out.failed = await rp.svgToPngInProcess(job).then(() => 'rendered', e => e.message)
for (const fd of fds) closeSync(fd)
out.spawnPid = seen[0] ?? null
await new Promise(r => setTimeout(r, 100))
out.after = []
for (let i = 0; i < 2; i++) out.after.push(await rp.svgToPngInProcess(job).then(b => b.length, e => e.message))
rp.__setRenderSpawnForTests(null)
process.stdout.write(JSON.stringify(out) + '\\n')
process.exit(0)
`)
    const pnpm = join(FRONTEND, 'node_modules/.pnpm')
    const jitiDir = readdirSync(pnpm).filter(d => /^jiti@2\./.test(d)).sort().pop()!
    const jiti = join(pnpm, jitiDir, 'node_modules/jiti/lib/jiti.mjs')
    const sh = realSpawn('/bin/sh', ['-c', 'ulimit -n 512; sleep 30 & echo "SENTINEL $!"; exec "$0" "$@"', process.execPath, script, jiti, join(FRONTEND, 'server/templates/renderProcess.ts')], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    })
    let out = ''
    sh.stdout!.on('data', (d: Buffer) => { out += d })
    sh.stderr!.resume()
    const [code, sig] = await new Promise<[number | null, string | null]>(r => sh.once('exit', (c, sg) => r([c, sg])))
    const sentinel = Number(/SENTINEL (\d+)/.exec(out)?.[1])
    expect(sentinel).toBeGreaterThan(0)
    let alive = false
    try { process.kill(sentinel, 0); alive = true }
    catch { /* gone */ }
    if (alive) process.kill(sentinel, 'SIGTERM')
    expect({ code, sig }).toEqual({ code: 0, sig: null })
    expect(alive).toBe(true)
    const r = JSON.parse(out.split('\n').find(l => l.startsWith('{'))!)
    expect(r.code).toBe('EMFILE')
    expect(r.spawnPid).toBeNull()  // the spawn really failed: a handle with no pid
    expect(r.failed).toBe(RENDER_CRASHED)
    expect(r.after).toEqual([r.warm, r.warm])
  }, 60_000)

  it('each distinct picture is sent to the render process once, however many elements show it', async () => {
    // A picture that doesn't compress: its bytes dominate the difference.
    const pic = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer()
    const sent: number[] = []
    const pid = __renderChildPidForTests()
    if (pid) process.kill(pid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 200))
    __setRenderSpawnForTests(((...a: Parameters<typeof realSpawn>) => {
      const p = realSpawn(...a)
      const send = p.send.bind(p)
      p.send = ((m: unknown, ...rest: unknown[]) => { sent.push(serialize(m).length); return (send as (...x: unknown[]) => boolean)(m, ...rest) }) as typeof p.send
      return p
    }) as never)
    try {
      for (const n of [1, 16]) {
        const png = await renderTemplatePng({ template: repeated('http://pic.test/a.png', n) as never, aspect: 'a' }, { fetcher: async () => ({ data: buf4(pic), contentType: 'image/png' }) })
        expect(png.length).toBeGreaterThan(0)
      }
    }
    finally { __setRenderSpawnForTests(null) }
    expect(sent.length).toBe(2)
    // One job holds the picture; sixteen elements showing it add only their nodes.
    expect(sent[0]!).toBeGreaterThan(pic.length)
    expect(sent[1]! - sent[0]!).toBeLessThan(pic.length / 4)
    // The same picture as a data: URI in the tree: once too.
    const tree = { type: 'div', props: { children: Array.from({ length: 8 }, () => ({ type: 'img', props: { src: `data:image/png;base64,${pic.toString('base64')}` } })) } }
    const table = await tableTreeImages(tree, async () => { throw new Error('no fetch') })
    expect(Object.keys(table).length).toBe(1)
    expect(new Set(tree.props.children.map(c => c.props.src)).size).toBe(1)
    expect(serialize({ tree, table }).length).toBeLessThan(pic.length * 2)
  }, 60_000)

  it('the pictures as shown count against the 100 MB budget: bytes × uses, and baked bytes', async () => {
    const one = new ArrayBuffer(10 * 1024 * 1024)
    const tree = (n: number) => ({ type: 'div', props: { children: Array.from({ length: n }, () => ({ type: 'img', props: { src: 'http://pic.test/big.png' } })) } })
    await expect(tableTreeImages(tree(9), async () => ({ data: one, contentType: 'image/png' }))).resolves.toBeTruthy()
    let fetches = 0
    await expect(tableTreeImages(tree(11), async () => { fetches++; return { data: one, contentType: 'image/png' } })).rejects.toThrow(LAYOUT_IMAGES_TOO_LARGE)
    expect(fetches).toBe(1)
    // A data: URI in the layout, repeated: counted the same way.
    const uri = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}`
    const t2 = { type: 'div', props: { children: Array.from({ length: 40 }, () => ({ type: 'img', props: { src: uri } })) } }
    await expect(tableTreeImages(t2)).rejects.toThrow(LAYOUT_IMAGES_TOO_LARGE)
    // Baked bytes: a flat picture fetched small, grain makes it big.
    const flat = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#808080' } }).png().toBuffer()
    const grain = { kind: 'grain', intensity: 0.5, ink: '#000' }
    const t3 = { type: 'div', props: { children: [1, 2, 3].map(() => ({ type: 'img', props: { src: 'http://pic.test/flat.png', __treatment: grain } })) } }
    const table = await tableTreeImages(structuredClone(t3), async () => ({ data: buf4(flat), contentType: 'image/png' }))
    const baked = (Object.values(table)[0] as { data: Uint8Array }).data.byteLength
    expect(baked).toBeGreaterThan(flat.length * 10)
    // Under a budget the fetched bytes fit and the baked ones × 3 don't: refused.
    const maxBytes = baked * 2
    expect(flat.length * 3).toBeLessThan(maxBytes)
    await expect(tableTreeImages(structuredClone(t3), async () => ({ data: buf4(flat), contentType: 'image/png' }), { maxBytes })).rejects.toThrow(LAYOUT_IMAGES_TOO_LARGE)
    // And for a render: refused plainly (the route answers 400), with nothing sent to the render process.
    const jobs = __renderJobsForTests()
    const e = await renderTemplatePng({ template: repeated('http://pic.test/big.png', 11) as never, aspect: 'a' }, { fetcher: async () => ({ data: one, contentType: 'image/png' }) }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TemplateSizeError)
    expect((e as Error).message).toBe(LAYOUT_IMAGES_TOO_LARGE)
    expect(__renderJobsForTests()).toBe(jobs)
  }, 60_000)

  it('a malformed layout answers 400 in plain words, never a server error', async () => {
    const v2 = (o: Record<string, unknown>) => ({ version: 2, id: 'm', master: 'a', formats: { a: { w: 64, h: 64 } }, ...GRID, elements: [], ...o })
    const cases: [string, unknown, string?][] = [
      ['empty', {}],
      ['v1, elements only', { elements: [] }],
      ['v1, aspects only', { aspects: { a: { w: 10, h: 10 } } }],
      ['v2, no formats', { version: 2, id: 'm', master: 'a', elements: [] }],
      ['v2, elements a number', v2({ elements: 5 })],
      ['a string', 'x'],
      ['a list', [1]],
      ['v2, a null element', v2({ elements: [null] })],
      ['v3, sections not a list', { ...v2({}), version: 3, sections: 3 }],
      ['v3, section children missing', { ...v2({}), version: 3, sections: [{ id: 's', region: { col: 1, colSpan: 1, row: 1, rowSpan: 1 } }] }],
      ['v2, a format that is a number', v2({ formats: { a: 5 } })],
      ['v2, an element style that is a string', v2({ elements: [{ id: 'e', type: 'shape', region: { col: 1, colSpan: 1, row: 1, rowSpan: 1 }, style: 'red' }] })],
    ]
    for (const [name, template] of cases) {
      const why = layoutShapeProblem(template)
      expect(why, name).toMatch(new RegExp(`^${LAYOUT_BAD_SHAPE}`))
      expect(() => templateToSatori(template as never, 'a', {}, {}, undefined, undefined), name).toThrow(TemplateSizeError)
      await expect(routeWith({ template, aspect: 'a' }), name).rejects.toMatchObject({ statusCode: 400, statusMessage: why })
    }
    // What the shape check lets through but the translation can't read: the backstop.
    const noRegion = { ...v2({}), version: 3, sections: [{ id: 's', children: [] }] }
    expect(layoutShapeProblem(noRegion)).toBeNull()
    await expect(routeWith({ template: noRegion, aspect: 'a' })).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_BAD_SHAPE })
    // An unknown aspect or format.
    await expect(routeWith({ template: v2({}), aspect: 'nope' })).rejects.toMatchObject({ statusCode: 400, statusMessage: 'This layout has no format named “nope”.' })
    await expect(routeWith({ template: { aspects: { a: { w: 10, h: 10 } }, elements: [] }, aspect: 'nope' })).rejects.toMatchObject({ statusCode: 400, statusMessage: 'This layout has no aspect named “nope”.' })
    // A well-formed layout still renders, and the snapshot holds.
    const png = await renderTemplatePng(SNAP.request)
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex')).toBe(SNAP.png_sha256)
  }, 60_000)

  describe('Google fonts', () => {
    const calls: string[] = []
    const REAL_FONT = readFileSync(join(FRONTEND, 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'))
    /** Google's CSS for any family, and a TTF of `ttfBytes`; `hang` never answers (until its signal ends it). */
    const google = (o: { ttfBytes?: number; hang?: boolean; ttfUrl?: string } = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url))
      if (o.hang) {
        return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true }))
      }
      if (String(url).startsWith('https://fonts.googleapis.com/')) {
        return new Response(`@font-face { font-weight: 400; src: url(${o.ttfUrl ?? 'https://fonts.gstatic.com/s/x.ttf'}) format('truetype'); }`)
      }
      return new Response(o.ttfBytes ? new Uint8Array(o.ttfBytes) : new Uint8Array(REAL_FONT))
    }) as typeof fetch
    /** A v1 layout (its per-aspect overrides do change the font): one text element per family. */
    const withFonts = (families: string[], overrides: Record<string, unknown> = {}) => ({
      id: 'f', aspects: { a: { w: 400, h: 400, label: 'A' }, b: { w: 400, h: 400, label: 'B' } },
      elements: families.map((f, i) => ({
        id: `t${i}`, type: 'text', anchor: 'top-left', offset: { x: 0, y: i * 10 }, size: { w: 200, h: 20 }, content: 'Hi', style: { fontFamily: f }, overrides,
      })),
    })
    afterEach(() => { calls.length = 0; __setGoogleFontsForTests({ fetch: null, timeoutMs: null, clear: true }) })

    it('families only from the rendered format; at most 16 to download, refused plainly past it', async () => {
      __setGoogleFontsForTests({ fetch: google(), clear: true })
      // 2,000 families named in other aspects' overrides: none fetched for aspect a.
      const overrides = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`o${i}`, { style: { fontFamily: `Nofont ${i}` } }]))
      const t = withFonts(['Inter'], { ...overrides, b: { style: { fontFamily: 'Remote B' } } })
      await renderTemplatePng({ template: t as never, aspect: 'a' })
      expect(calls).toEqual([])
      // Aspect b's own override is fetched, and only it.
      await renderTemplatePng({ template: t as never, aspect: 'b' })
      expect(calls).toEqual(['https://fonts.googleapis.com/css2?family=Remote+B:wght@400;700&display=swap', 'https://fonts.gstatic.com/s/x.ttf'])
      calls.length = 0
      // 17 remote families on the rendered format: refused before any fetch.
      const seventeen = Array.from({ length: LAYOUT_MAX_REMOTE_FONTS + 1 }, (_, i) => `Remote ${i}`)
      const e = await renderTemplatePng({ template: withFonts(seventeen) as never, aspect: 'a' }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(TemplateSizeError)
      expect((e as Error).message).toBe(LAYOUT_TOO_MANY_FONTS)
      expect(calls).toEqual([])
      await expect(routeWith({ template: withFonts(seventeen), aspect: 'a' })).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_TOO_MANY_FONTS })
      // 16 are fine.
      await renderTemplatePng({ template: withFonts(seventeen.slice(0, 16)) as never, aspect: 'a' })
      expect(calls.filter(c => c.startsWith('https://fonts.googleapis.com/')).length).toBe(16)
    }, 60_000)

    it('a hung font fetch ends with Stop, and on its own time limit', async () => {
      __setGoogleFontsForTests({ fetch: google({ hang: true }), clear: true })
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 300)
      const t0 = Date.now()
      await expect(renderTemplatePng({ template: withFonts(['Hung Family']) as never, aspect: 'a' }, { signal: ctl.signal })).rejects.toThrow('Stopped')
      expect(Date.now() - t0).toBeLessThan(2000)
      // The render's deadline too.
      __setRenderDeadlineForTests(300)
      try {
        await expect(renderTemplatePng({ template: withFonts(['Hung Family']) as never, aspect: 'a' })).rejects.toThrow(RENDER_TIMEOUT)
      }
      finally { __setRenderDeadlineForTests(null) }
      // Each fetch's own limit: the render carries on without the font.
      __setGoogleFontsForTests({ timeoutMs: 200 })
      const t1 = Date.now()
      const png = await renderTemplatePng({ template: withFonts(['Hung Family']) as never, aspect: 'a' })
      expect(png.length).toBeGreaterThan(0)
      expect(Date.now() - t1).toBeLessThan(5000)
    }, 60_000)

    it('both caches are bounded; a font file past 10 MB, or not from Google’s font host, is not used', async () => {
      __setGoogleFontsForTests({ fetch: (async () => new Response('nope', { status: 400 })) as typeof fetch, clear: true })
      for (let i = 0; i < GOOGLE_FAILED_MAX + 50; i++) await loadGoogleFamily(`Missing ${i}`)
      expect(__setGoogleFontsForTests({}).failed).toBe(GOOGLE_FAILED_MAX)
      __setGoogleFontsForTests({ fetch: google({ ttfBytes: 2 * 1024 * 1024 }) })
      for (let i = 0; i < GOOGLE_CACHE_MAX_FAMILIES + 20; i++) expect((await loadGoogleFamily(`Real ${i}`)).length).toBe(1)
      const sizes = __setGoogleFontsForTests({})
      expect(sizes.cachedBytes).toBeLessThanOrEqual(GOOGLE_CACHE_MAX_BYTES)
      expect(sizes.cached).toBeLessThanOrEqual(GOOGLE_CACHE_MAX_FAMILIES)
      expect(sizes.cached).toBeGreaterThan(0)
      __setGoogleFontsForTests({ fetch: google({ ttfBytes: 11 * 1024 * 1024 }), clear: true })
      expect(await loadGoogleFamily('Huge')).toEqual([])
      __setGoogleFontsForTests({ fetch: google({ ttfUrl: 'http://127.0.0.1:1/x.ttf' }), clear: true })
      expect(await loadGoogleFamily('Elsewhere')).toEqual([])
      expect(calls.some(c => c.startsWith('http://127.0.0.1'))).toBe(false)
    }, 60_000)
  })

  it('a localhost /view is read off disk: neither a 127.0.0.1 nor a [::1] listener on the port is reached', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const v4 = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png) })
    await new Promise<void>(r => v4.listen(0, '127.0.0.1', r))
    const port = (v4.address() as AddressInfo).port
    const v6 = createServer((_q, res) => { res.writeHead(426); res.end() })
    await new Promise<void>((r, j) => { v6.once('error', j); v6.listen(port, '::1', r) })
    try {
      for (let i = 0; i < 3; i++) {
        const got = await safeImageFetcher({ hosted: false, viewPorts: [port] })(`http://localhost:${port}/view?filename=a.png`)
        expect(Buffer.from(got.data).equals(viewPng)).toBe(true)
        expect(Buffer.from(got.data).equals(png)).toBe(false)
      }
      // Its addresses are still all checked: another path is refused.
      await expect(safeImageFetcher({ hosted: false, viewPorts: [port] })(`http://localhost:${port}/admin`)).rejects.toThrow(FETCH_REFUSED)
    }
    finally {
      v4.closeAllConnections(); v4.close()
      v6.closeAllConnections(); v6.close()
    }
  })
})

// ── Round 5 ──────────────────────────────────────────────────────────────────

describe('round 5: no picture reaches the renderer by address', () => {
  const at = (path: string) => `${base}${path}`
  const hostPort = () => new URL(base).host
  const v2 = (o: Record<string, unknown> = {}) => ({
    version: 2, id: 'a5', master: 'a', formats: { a: { w: 64, h: 64 } }, ...GRID, grid: { columns: 6, rows: 6, gutter: 4, margin: 8, baseline: 4 }, elements: [], ...o,
  })
  const image = (content: string) => ({ id: 'i', type: 'image', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, bleed: true, style: { fit: 'cover' }, content })
  const shape = (fill: string) => ({ id: 's', type: 'shape', shape: 'rect', priority: 4, region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 }, style: { fill } })
  const refusedBy = async (req: RenderRequest, words: string) => {
    const e = await renderTemplatePng(req).catch((x: unknown) => x)
    expect(e, JSON.stringify(req).slice(0, 300)).toBeInstanceOf(TemplateSizeError)
    expect((e as Error).message).toBe(words)
  }
  const routeWith = async (body: unknown) => {
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('setHeader', () => {})
    vi.stubGlobal('createError', (e: { statusCode: number; statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    vi.stubGlobal('readBody', async () => body)
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      return await route({ node: { req: { socket: {}, headers: {} }, res: new EventEmitter() } })
    }
    finally { vi.unstubAllGlobals() }
  }

  it('the render process has no network: satori can’t fetch an img src or a CSS url() itself', async () => {
    // Straight to the render process, past the parent's checks.
    const img = { type: 'div', props: { style: { width: 16, height: 16, display: 'flex' }, children: [{ type: 'img', props: { src: at('/view?child-img'), width: 16, height: 16 } }] } }
    await expect(svgToPngInProcess({ tree: img, width: 16, height: 16, fonts: [], images: {} })).rejects.toThrow('A picture in this layout is not one the renderer was given')
    const bg = { type: 'div', props: { style: { width: 16, height: 16, display: 'flex', backgroundImage: `url(${at('/view?child-bg')})` } } }
    await svgToPngInProcess({ tree: bg, width: 16, height: 16, fonts: [], images: {} }).catch(() => {})
    await new Promise(r => setTimeout(r, 200))
    expect(hits).toEqual([])
  }, 60_000)

  it('every odd picture address is refused plainly (400) before any request, for img sources and fills', async () => {
    const hp = '127.0.0.1:8188'   // even the engine's /view port: the odd forms never reach it
    expect(hostPort()).toBeTruthy()
    const srcs = [
      `http:${hp}/view?c`, `"http://${hp}/view?d"`, `'http://${hp}/view?e'`, `http:\\\\${hp}/view?f`,
      `HTTP://${hp}/view?b`, ` http://${hp}/view?g`, `https:${hp}/view?h`, `//${hp}/view?i`, '/view?filename=x.png', `http://${hp}\\view?j`, 'DATA:image/png;base64,AAAA',
    ]
    for (const src of srcs) {
      await refusedBy({ template: v2({ elements: [image(src)] }) as never, aspect: 'a' }, LAYOUT_BAD_IMAGE_ADDRESS)
      await refusedBy({ template: v2({ background: { image: src } }) as never, aspect: 'a' }, LAYOUT_BAD_IMAGE_ADDRESS)
      // Wired: the address comes from a prop.
      await refusedBy({ template: v2({ elements: [image('{{ props.pic }}')] }) as never, aspect: 'a', props: { pic: src } }, LAYOUT_BAD_IMAGE_ADDRESS)
    }
    // v1 image element.
    await refusedBy({ template: { id: 'v1', aspects: { a: { w: 64, h: 64, label: 'A' } }, elements: [{ id: 'i', type: 'image', anchor: 'top-left', offset: { x: 0, y: 0 }, size: { w: 64, h: 64 }, content: `http:${hp}/view?v1` }] } as never, aspect: 'a' }, LAYOUT_BAD_IMAGE_ADDRESS)
    const fills = [`url(http://${hp}/view?bg)`, `URL( 'http://${hp}/view?bg2' )`, `#000 url("https:${hp}/x")`, `url(/etc/passwd)`, `url(file:///etc/hosts)`]
    for (const fill of fills) {
      await refusedBy({ template: v2({ background: { fill } }) as never, aspect: 'a' }, LAYOUT_STYLE_URL)
      await refusedBy({ template: v2({ elements: [shape(fill)] }) as never, aspect: 'a' }, LAYOUT_STYLE_URL)
      await refusedBy({ template: v2({ background: { fill: '{{ brand.primary }}' } }) as never, aspect: 'a', brand: { primary: fill } }, LAYOUT_STYLE_URL)
      await refusedBy({ template: v2({ background: { fill: '{{ props.bg }}' } }) as never, aspect: 'a', props: { bg: fill } }, LAYOUT_STYLE_URL)
    }
    await refusedBy({ template: { id: 'v1', aspects: { a: { w: 64, h: 64, label: 'A' } }, elements: [{ id: 's', type: 'shape', shape: 'rect', anchor: 'top-left', offset: { x: 0, y: 0 }, size: { w: 64, h: 64 }, style: { fill: `url(http://${hp}/view?v1bg)` } }] } as never, aspect: 'a' }, LAYOUT_STYLE_URL)
    // The route answers 400, never 500.
    await expect(routeWith({ template: v2({ elements: [image(`HTTP://${hp}/view?r`)] }), aspect: 'a' })).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_BAD_IMAGE_ADDRESS })
    await expect(routeWith({ template: v2({ background: { fill: `url(http://${hp}/view?r2)` } }), aspect: 'a' })).rejects.toMatchObject({ statusCode: 400, statusMessage: LAYOUT_STYLE_URL })
    expect(hits).toEqual([])
    // Still fine: a plain address through the safe fetcher, and embedded pictures in a fill.
    const png = await renderTemplatePng({ template: v2({ elements: [image('http://127.0.0.1:3002/view?filename=plain.png')] }) as never, aspect: 'a' }, { fetcher: ownPort() })
    expect(png.length).toBeGreaterThan(0)
    // R10.8: read off disk, nothing asked of any port.
    expect(hits).toEqual([])
    const dot = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00f' } }).png().toBuffer()).toString('base64')
    const ok = await renderTemplatePng({ template: v2({ background: { fill: `url(data:image/png;base64,${dot})` }, elements: [shape(`url("data:image/png;base64,${dot}")`)] }) as never, aspect: 'a' })
    expect(ok.length).toBeGreaterThan(0)
  }, 60_000)

  it('a v3 layout saved without a type scale renders with the default one (the saved layout_test)', async () => {
    const layoutTest = { version: 3, id: 'layout_test', name: 'New Layout', master: '1x1', formats: { '1x1': { w: 1080, h: 1080, label: 'Square' } }, grid: { gutter: 0, margin: 72, baseline: 12, columns: 16, rows: 16 }, background: { fill: '#0a0a0a' }, elements: [{ id: 'text_wgxt2t', type: 'text', priority: 1, level: 'body', content: 'A new kind of skincare', region: { col: 2, colSpan: 14, row: 2, rowSpan: 14 }, style: { color: '#fff' } }], outputs: [{ id: '1x1', format: '1x1', label: 'Square' }], sections: [] }
    const png = await renderTemplatePng({ template: layoutTest as never, aspect: '1x1' })
    const withDefault = await renderTemplatePng({ template: { ...layoutTest, typeScale: { base: 28, ratio: 1.414 } } as never, aspect: '1x1' })
    expect(Buffer.compare(Buffer.from(png), Buffer.from(withDefault))).toBe(0)
    expect((await sharp(png).metadata()).width).toBe(1080)
  }, 60_000)

  it('plain words: an element’s style “is”, and a format or aspect name the layout doesn’t have', async () => {
    const el = (o: Record<string, unknown>) => ({ ...v2(), elements: [{ id: 'e', type: 'shape', region: { col: 1, colSpan: 1, row: 1, rowSpan: 1 }, ...o }] })
    expect(layoutShapeProblem(el({ style: 'red' }))).toBe(`${LAYOUT_BAD_SHAPE}: an element's style is not a set of values.`)
    expect(layoutShapeProblem(el({ overrides: 'x' }))).toBe(`${LAYOUT_BAD_SHAPE}: an element's overrides are not a set of values.`)
    expect(layoutShapeProblem(el({ regionByClass: 3 }))).toBe(`${LAYOUT_BAD_SHAPE}: an element's class regions are not a set of values.`)
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await expect(routeWith({ template: v2(), aspect: name })).rejects.toMatchObject({ statusCode: 400, statusMessage: `This layout has no format named “${name}”.` })
      await expect(routeWith({ template: { id: 'v1', aspects: { a: { w: 10, h: 10 } }, elements: [] }, aspect: name })).rejects.toMatchObject({ statusCode: 400, statusMessage: `This layout has no aspect named “${name}”.` })
    }
  }, 60_000)
})

describe('preview names and literals', () => {
  it('a label too long for its preview’s file name fails the node before any render', async () => {
    const render = vi.spyOn(smartLayoutRenderer, 'render')
    const layout = JSON.stringify({ version: 2, id: 'n', master: 'a', formats: { a: { w: 64, h: 64, label: 'x'.repeat(190) } }, ...GRID, elements: [] })
    await expect(planNode({
      prompt: { l: { class_type: 'SmartLayout', inputs: { layout, aspects: '', brand_kit: '' } } },
      nodeId: 'l', families: CARDS, gateOpen: false, filesFrom: () => [], toUrl: async () => '',
    })).rejects.toThrow(PREVIEW_NAME_BAD)
    expect(render).not.toHaveBeenCalled()
  })

  it('a number typed into a layer reads as Python’s str()', () => {
    expect([1, 1.5, 0.0001, 0.00001, -0.00001, 1e21, 1.2345678901234568e+20, 1e-7, 123.456].map(layerText))
      .toEqual(['1', '1.5', '0.0001', '1e-05', '-1e-05', '1e+21', '123456789012345680000', '1e-07', '123.456'])
    expect(pyFloatStr(1e16)).toBe('1e+16')
    expect(pyFloatStr(2.5e15)).toBe('2500000000000000.0')
    expect(smartLayoutRequests({ layout: '', aspects: '1x1', text_layer_1: 0.00001 }, {})[0]!.props).toEqual({ text_layer_1: '1e-05' })
  })
})
