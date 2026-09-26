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
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { TemplateImageError, renderTemplatePng } from '~~/server/templates/renderPng'
import { TEMPLATE_SIZE_REFUSED, TemplateSizeError, templateToSatori } from '~~/server/templates/translate'
import { FETCH_REFUSED, FETCH_TIMEOUT, FETCH_TOO_LARGE, addressAllowed, safeImageFetcher } from '~~/server/templates/safeFetch'
import { RENDER_TIMEOUT, __renderChildPidForTests, __renderJobsForTests, __setRenderTimeoutForTests, svgToPngInProcess } from '~~/server/templates/renderProcess'
import { inlineTreeImages } from '~~/server/templates/inlineImages'
import { LAYOUT_MAX_TEXT, LAYOUT_TOO_BIG, LAYOUT_TOO_MANY_READERS, LAYOUT_TOO_MUCH_TEXT, layoutTextProblem } from '#shared/template-grid/limits'
import type { RenderRequest } from '~~/server/templates/schema'
import type { OutputFile } from '~~/server/runner/types'

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
beforeAll(async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
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
afterAll(() => { server.closeAllConnections(); server.close() })
afterEach(() => {
  hits = []
  vi.restoreAllMocks()
  __setFrameTimeoutForTests(null)
  __setRenderTimeoutForTests(null)
  vi.unstubAllEnvs()
})

// ── 1. treatments ────────────────────────────────────────────────────────────

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

  it('locally, a loopback /view on ComfyUI’s configured port (or the route’s own) is fetched; any other port, or hosted, is refused', async () => {
    await expect(safeImageFetcher({ hosted: false })(`${base}/view?filename=a.png&type=temp`)).rejects.toThrow(FETCH_REFUSED)
    const port = Number(new URL(base).port)
    expect((await safeImageFetcher({ hosted: false, viewPorts: [port] })(`${base}/view?filename=own.png`)).contentType).toBe('image/png')
    vi.stubEnv('SAILOR_COMFY_ORIGIN', base)
    const got = await safeImageFetcher({ hosted: false })(`${base}/view?filename=a.png&type=temp`)
    expect(got.contentType).toBe('image/png')
    await expect(safeImageFetcher({ hosted: true })(`${base}/view?filename=a.png`)).rejects.toThrow(FETCH_REFUSED)
    expect(hits).toEqual(['/view?filename=own.png', '/view?filename=a.png&type=temp'])
  })

  it('no connection is reused: an allowed /view, then another path on the same host, is refused', async () => {
    vi.stubEnv('SAILOR_COMFY_ORIGIN', base)
    const f = safeImageFetcher({ hosted: false })
    for (const host of [base, base.replace('127.0.0.1', 'localhost')]) {
      await f(`${host}/view?filename=a.png`)
      await expect(f(`${host}/admin?secret=1`)).rejects.toThrow(FETCH_REFUSED)
      await expect(f(`${host}/view/`)).rejects.toThrow(FETCH_REFUSED)
    }
    expect(hits).toEqual(['/view?filename=a.png', '/view?filename=a.png'])
  })

  it('refuses the IPv6 forms that carry an IPv4 address, and site-local', () => {
    for (const a of ['::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:7f00:1', '2002:7f00:1::1', '2001::1', 'fec0::1', '64:ff9b::7f00:1']) expect(addressAllowed(a), a).toBe(false)
  })

  it('checks every redirect again', async () => {
    vi.stubEnv('SAILOR_COMFY_ORIGIN', base)
    await expect(safeImageFetcher({ hosted: false })(`${base}/view?redirect=1`)).rejects.toThrow(FETCH_REFUSED)
    expect(hits).toEqual(['/view?redirect=1'])
  })

  it('stops at its byte cap and its timeout', async () => {
    vi.stubEnv('SAILOR_COMFY_ORIGIN', base)
    await expect(safeImageFetcher({ hosted: false, maxBytes: 1000 })(`${base}/view?big=1`)).rejects.toThrow(FETCH_TOO_LARGE)
    await expect(safeImageFetcher({ hosted: false, timeoutMs: 200 })(`${base}/view?slow=1`)).rejects.toThrow(FETCH_TIMEOUT)
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
  const gone = async (pid: number, ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try { process.kill(pid, 0) }
      catch { return true }
      await new Promise(r => setTimeout(r, 20))
    }
    return false
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

// ── 6 and 7 ──────────────────────────────────────────────────────────────────

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
