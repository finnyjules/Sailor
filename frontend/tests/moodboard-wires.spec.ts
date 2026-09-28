import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { openBlankWorkflow, dropNode, waitForBackend } from './_helpers'
// The REAL run-path modules the app itself uses — not fixture re-implementations.
// (graphToPrompt can't load in the Playwright node context — its import chain
// reaches useVueNodes' Nuxt auto-imports — so THAT one runs in-page via the
// dev server's own module graph; see the (b) step.)
import { injectLoraStyleIntoPrompt as realInjectLoraStyle } from '../app/lib/graph/styleInject'
import { widgetSlots } from '../app/lib/graph/widgetOrder'
import { moodboardStyleBlock } from '../app/lib/taste/styleBlock'
import { MOODBOARD_DEFAULT_MODEL } from '../app/lib/graph/moodboardApply'

// This project is ESM (no __dirname global) — derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Moodboard wires E2E (moodboards Plan B, Task B5) — against the LIVE dev
 * server, everything real (the board is seeded via the real API routes, no
 * Fable call needed because the reading is seeded, not read):
 *
 *  (a) Generate-an-image node on a NON-ref model (flux-schnell) → apply the
 *      board via the node-face chip → legible auto-switch to nano-banana-pro
 *      (notice + Revert + "refs ✓"), style_refs JSON in the node state AND in
 *      the serialized workflow run through the REAL submit-time injector
 *      (the B3 technique), with a blanked-properties broken control; Revert
 *      restores the model and drops the refs; re-applying after that manual
 *      state never re-switches (manual choice wins).
 *  (b) Moodboard node references the board → its hidden reading_json /
 *      moodboard_id widgets sync, and the REAL graphToPrompt yields the
 *      Moodboard class_type carrying the reading (the B4 technique — the
 *      wire-DRAG itself needs vue-flow pointer gestures that synthetic events
 *      can't drive, so the serialization shape is the assertion).
 *  (c) Saving the board (modal Save) registers its first images as project
 *      @refs `mb-<slug>-0..2` — flat input-ROOT filenames (the /view endpoint
 *      basenames subpaths, so flat names are the shape that resolves in every
 *      app image widget), asserted in the persisted doc's assetRegistry, on
 *      disk, via /view, and through the Reference node's own picker + thumb.
 *
 * Page state is pulled through Vue's dev-only `__vueParentComponent` backlink
 * to reach VueNodeCanvas's defineExpose surface (getNodes / getWorkflow) — the
 * same objects the app itself serializes at Run (the A8 technique).
 */

// ── minimal in-memory PNG fixtures (A8's real-decoding PNG builder) ─────────
function crc32(buf: Buffer): number {
  let c: number
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function makePng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── page-state extraction (A8 technique, + widgetDefs for name-addressed writes) ──
interface PulledNode { properties: Record<string, any>, widgetsValues: any[], widgetDefs: { name: string }[] }
async function pullNodeData(page: Page, nodeId: string): Promise<PulledNode> {
  return await page.evaluate((id) => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    const n = c.exposed.getNodes().find((n: any) => String(n.id) === String(id))
    if (!n) throw new Error(`node ${id} not found`)
    return JSON.parse(JSON.stringify({
      properties: n.data?.properties ?? {},
      widgetsValues: n.data?.widgetsValues ?? [],
      widgetDefs: (n.data?.widgetDefs ?? []).map((d: any) => ({ name: d?.name })),
    }))
  }, nodeId)
}

/** All live nodes' identity/position — the wire steps assert find-or-create. */
async function pullAllNodes(page: Page): Promise<{ id: string, nodeType: string, properties: Record<string, any>, position: { x: number, y: number } }[]> {
  return await page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    return JSON.parse(JSON.stringify(c.exposed.getNodes().map((n: any) => ({
      id: String(n.id),
      nodeType: n.data?.nodeType ?? '',
      properties: n.data?.properties ?? {},
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
    }))))
  })
}

/** The live node's input index for a named input (handle = `input-<idx>`). */
async function inputIndexOf(page: Page, nodeId: string, inputName: string): Promise<number> {
  return await page.evaluate(({ id, inputName }) => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    const n = c.exposed.getNodes().find((n: any) => String(n.id) === String(id))
    if (!n) throw new Error(`node ${id} not found`)
    return ((n.data?.inputs ?? []) as any[]).findIndex((i: any) => i?.name === inputName)
  }, { id: nodeId, inputName })
}

async function fitCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.fitView === 'function')) c = c.parent
    c?.exposed.fitView()
  })
  await page.waitForTimeout(300)
}

/**
 * fitView() picks a single pan/zoom for the whole graph, and any card's
 * rendered height can nudge that transform enough to leave a port sitting
 * under fixed-position chrome (the bottom-centre prompt bar + toolbar stack,
 * `[data-testid="canvas-bottom-bar-stack"]` in app/layouts/default.vue) — the
 * port still has a real bounding box, but a synthetic mouse click at its
 * centre hits that stack instead. Ground truth is `elementFromPoint`, not the
 * bounding box: this checks the element actually on top at a point is (or is
 * inside) the handle with the given id.
 */
async function isHandleTopmostAt(page: Page, x: number, y: number, handleId: string): Promise<boolean> {
  return await page.evaluate(({ x, y, handleId }) => {
    const el = document.elementFromPoint(x, y)
    return !!el?.closest(`[data-handleid="${handleId}"]`)
  }, { x, y, handleId })
}

/** A point inside the pane that clears every current node's box by a margin
 *  — used only as the wheel gesture's cursor position, never as a drag start
 *  (the default tool mode is Select, where a pointer-drag on the pane draws a
 *  selection box instead of panning; wheel is the pan gesture that works
 *  without switching tools). */
async function findClearPanePoint(page: Page): Promise<{ x: number, y: number }> {
  return await page.evaluate(() => {
    const pane = document.querySelector('.vue-flow__pane') as HTMLElement
    const paneBox = pane.getBoundingClientRect()
    const nodeBoxes = Array.from(document.querySelectorAll('.vue-flow__node')).map(el => el.getBoundingClientRect())
    const margin = 60
    for (let y = paneBox.top + margin; y < paneBox.bottom - margin; y += 40) {
      for (let x = paneBox.left + margin; x < paneBox.right - margin; x += 40) {
        const clear = nodeBoxes.every(b => x < b.left - 10 || x > b.right + 10 || y < b.top - 10 || y > b.bottom + 10)
        if (clear) return { x, y }
      }
    }
    return { x: paneBox.left + paneBox.width / 2, y: paneBox.top + paneBox.height / 2 }
  })
}

/** Pan the canvas UP by `dy` with a plain wheel gesture (see findClearPanePoint
 *  for why wheel, not a drag). Vertical-only: the bottom-bar-stack is
 *  horizontally centred and full-height-band, so the only reliable clearance
 *  is moving above its top edge, not sideways past it. */
async function panPaneUpBy(page: Page, dy: number): Promise<void> {
  const { x, y } = await findClearPanePoint(page)
  await page.mouse.move(x, y)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(150)
}

/** How far (in screen px) a point at `y` sits below the bottom-bar-stack's
 *  top edge, plus a safety margin — 0 (or negative) once it's clear. Returns
 *  0 when the stack isn't present (e.g. a non-project tab). */
async function overlapWithBottomStack(page: Page, y: number): Promise<number> {
  const stack = page.getByTestId('canvas-bottom-bar-stack')
  const box = await stack.boundingBox().catch(() => null)
  if (!box) return 0
  const margin = 24
  return y - (box.y - margin)
}

async function pullSerializedWorkflow(page: Page): Promise<any> {
  return await page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getWorkflow === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    return JSON.parse(JSON.stringify(c.exposed.getWorkflow()))
  })
}

/** Write a widget value BY NAME on a live node (the widgetDefs-resolved slot). */
async function setWidgetByName(page: Page, nodeId: string, name: string, value: any): Promise<void> {
  await page.evaluate(({ id, name, value }) => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    const n = c.exposed.getNodes().find((n: any) => String(n.id) === String(id))
    if (!n) throw new Error(`node ${id} not found`)
    const idx = (n.data?.widgetDefs ?? []).findIndex((d: any) => d?.name === name)
    if (idx < 0) throw new Error(`widget ${name} not found on ${id}`)
    n.data.widgetsValues[idx] = value
  }, { id: nodeId, name, value })
}

async function addNodeAndGetId(page: Page, nodeType: string): Promise<string> {
  const before = await page.locator('.vue-flow__node').evaluateAll(els => els.map(e => e.getAttribute('data-id')))
  await dropNode(page, nodeType)
  await expect.poll(async () => (await page.locator('.vue-flow__node').count())).toBe(before.length + 1)
  const after = await page.locator('.vue-flow__node').evaluateAll(els => els.map(e => e.getAttribute('data-id')))
  const id = after.find(id => !before.includes(id)) ?? ''
  expect(id).toBeTruthy()
  return id
}

/** Open the gallery on the node's moodboard target and pick the board. */
async function applyBoardViaGallery(page: Page, nodeId: string, boardName: string): Promise<void> {
  await page.evaluate((id) =>
    window.dispatchEvent(new CustomEvent('sailor:openLoraGallery', {
      detail: { nodeId: id, widgetName: 'style_block', kind: 'moodboard' },
    })), nodeId)
  const catalog = page.locator('.fixed.inset-0.z-\\[100\\]')
    .filter({ has: page.getByRole('button', { name: /^Moodboards/ }) })
  await expect(catalog).toBeVisible({ timeout: 10_000 })
  const card = catalog.getByRole('button', { name: new RegExp(boardName) }).first()
  await expect(card).toBeVisible()
  await card.click()
  await catalog.getByRole('button', { name: `Use ${boardName}` }).click()
  await expect(catalog).toBeHidden()
}

/**
 * The live /object_info, with the B2–B4 schema guaranteed present. The dev
 * backend normally serves it already (it was restarted after B4 landed); a
 * PRE-restart backend lacks the appended inputs, in which case we append them
 * here exactly as the Python schema declares them (append-only contract) so
 * the REAL injector/serializer logic still runs against the true shape.
 */
async function pullObjectInfo(page: Page): Promise<Record<string, any>> {
  const res = await page.request.get('/object_info')
  expect(res.status()).toBe(200)
  const objectInfo = await res.json() as Record<string, any>

  const gen = objectInfo.GenerateImageNode
  expect(gen, 'GenerateImageNode must exist in /object_info').toBeTruthy()
  gen.input.optional = gen.input.optional ?? {}
  if (!gen.input.optional.style_block) {
    gen.input.optional.style_block = ['STRING', { multiline: true, default: '', sailor_widget: 'internal' }]
    gen.input.optional.style_refs = ['STRING', { default: '', sailor_widget: 'internal' }]
  }
  if (!objectInfo.Moodboard) {
    objectInfo.Moodboard = {
      input: {
        required: { reading_json: ['STRING', { multiline: true, default: '' }] },
        optional: { moodboard_id: ['STRING', { default: '' }] },
      },
      output: ['TASTE'],
      output_name: ['style'],
    }
  }
  return objectInfo
}

// ── run-scoped seeded state (created via the API, cleaned in afterAll) ──────
const runTag = Date.now()
const boardId = `wires-e2e-${runTag}`
const boardName = `Wires E2E ${runTag}`
const SUMMARY = 'B5 wires world of dusk chrome.'
const READING = {
  summary: SUMMARY,
  palette: [
    { name: 'Dusk Chrome', hex: '#8b93a7' },
    { name: 'Ember', hex: '#d96a3b' },
  ],
  avoids: ['flat daylight'],
}
let seededFolder = ''
let seededFiles: string[] = []

const inputRoot = path.resolve(__dirname, '../../input')
const flatFile = (i: number) => `mb_${boardId}_${i}.png`
const refName = (i: number) => `mb-${boardId}-${i}`

test.afterAll(async ({ request }) => {
  await request.delete(`/api/moodboards/${boardId}`).catch(() => {})
  if (/^moodboard_\d+$/.test(seededFolder)) {
    await fs.promises.rm(path.join(inputRoot, seededFolder), { recursive: true, force: true }).catch(() => {})
  }
  for (let i = 0; i < 3; i++) {
    await fs.promises.rm(path.join(inputRoot, flatFile(i)), { force: true }).catch(() => {})
  }
})

test('moodboard wires: chip apply auto-switch + refs payload → revert → manual-choice wins → twin serialization → @refs on save', async ({ page }) => {
  test.setTimeout(180_000)

  await waitForBackend(page)

  await test.step('seed a moodboard via the real API (3 images + entry with reading)', async () => {
    // Three uploads: the first mints the folder, the rest re-target it.
    const fixtures: [string, [number, number, number]][] = [
      ['a_dusk.png', [139, 147, 167]],
      ['b_ember.png', [217, 106, 59]],
      ['c_coal.png', [40, 40, 44]],
    ]
    for (const [name, rgb] of fixtures) {
      const multipart: Record<string, any> = {
        images: { name, mimeType: 'image/png', buffer: makePng(48, 48, rgb) },
      }
      if (seededFolder) multipart.folder = seededFolder
      const res = await page.request.post('/api/moodboards/images', { multipart })
      expect(res.status()).toBe(200)
      seededFolder = (await res.json()).folder
    }
    expect(seededFolder).toMatch(/^moodboard_\d+$/)

    const listRes = await page.request.get(`/api/moodboards/images?folder=${encodeURIComponent(seededFolder)}`)
    seededFiles = (await listRes.json()).files
    expect(seededFiles.length).toBe(3)

    const now = new Date().toISOString()
    const putRes = await page.request.put(`/api/moodboards/${boardId}`, {
      data: {
        id: boardId, name: boardName, createdAt: now, updatedAt: now,
        folder: seededFolder, reading: READING,
      },
    })
    expect(putRes.status()).toBe(200)
  })

  await openBlankWorkflow(page)
  const objectInfo = await pullObjectInfo(page)
  const expectedBlock = moodboardStyleBlock(READING)

  // ── (a) chip apply on a non-ref model: auto-switch + refs ride-along ──────
  let genNodeId = ''
  await test.step('Generate-an-image node on flux-schnell (a NON-ref model)', async () => {
    genNodeId = await addNodeAndGetId(page, 'GenerateImageNode')
    await setWidgetByName(page, genNodeId, 'model', 'flux-schnell')
    const { widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)
    expect(widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]).toBe('flux-schnell')
  })

  let styleRefsJson = ''
  let mbWireNodeId = ''
  await test.step('chip apply IS wiring: board node find-or-created LEFT of the generator + REAL TASTE edge + auto-switch + refs', async () => {
    const nodesBefore = await page.locator('.vue-flow__node').count()
    await applyBoardViaGallery(page, genNodeId, boardName)

    // The wire effects run AFTER the edge lands, so this poll gates both.
    await expect.poll(async () =>
      (await pullNodeData(page, genNodeId)).properties.sailor_moodboard ?? null).toBe(boardId)
    const { properties, widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)

    // The switch: model widget flipped to the moodboard default, previous
    // model recorded in the marker (legible + revertable).
    expect(widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]).toBe(MOODBOARD_DEFAULT_MODEL)
    // nano-banana-2 verified live 2026-08-07: full pattern-level transfer at
    // roughly half pro's price, so the cheap tier is the default.
    expect(MOODBOARD_DEFAULT_MODEL).toBe('nano-banana-2')
    expect(properties.sailor_moodboard_switched).toBe('flux-schnell')

    // The refs payload: {folder, files[≤3]} over the seeded board's images.
    styleRefsJson = String(properties.style_refs ?? '')
    const refs = JSON.parse(styleRefsJson)
    expect(refs.folder).toBe(seededFolder)
    expect(refs.files).toEqual(seededFiles.slice(0, 3))

    // Applying IS wiring: NO property block — the wire is the single carrier
    // of the prose (an implementation still writing properties.aesthetic on
    // the chip path fails here).
    expect('aesthetic' in properties).toBe(false)

    // The board's Moodboard node was auto-created beside (LEFT of) the
    // generator — one new node, carrying the board id as its identity.
    expect(await page.locator('.vue-flow__node').count()).toBe(nodesBefore + 1)
    const all = await pullAllNodes(page)
    const mb = all.find(n => n.nodeType === 'Moodboard' && n.properties.sailor_moodboard === boardId)
    expect(mb, 'chip apply must create the board node').toBeTruthy()
    mbWireNodeId = mb!.id
    const gen = all.find(n => n.id === genNodeId)!
    expect(mb!.position.x).toBeLessThan(gen.position.x)
    expect(mb!.position.y).toBe(gen.position.y)

    // The REAL edge, in the serialized workflow: style_in carries a link whose
    // origin is the board node's TASTE output.
    const workflow = await pullSerializedWorkflow(page)
    const genLg = (workflow.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    const styleIn = (genLg.inputs as any[]).find((i: any) => i.name === 'style_in')
    expect(styleIn?.link, 'style_in must carry a REAL link').not.toBeNull()
    const link = (workflow.links as any[]).find((l: any) => l[0] === styleIn.link)
    expect(String(link[1])).toBe(mbWireNodeId)
    expect(link[5]).toBe('TASTE')

    // …and through the REAL graphToPrompt (the Run path's converter, in-page):
    // inputs.style_in = [moodboardNodeId, 0] — the B4 technique, now made by a
    // chip pick instead of a hand-built fixture.
    const prompt = await page.evaluate(async () => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getWorkflow === 'function')) c = c.parent
      if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
      const workflow = JSON.parse(JSON.stringify(c.exposed.getWorkflow()))
      const objectInfo = JSON.parse(JSON.stringify(c.exposed.getObjectInfo()))
      const mod = await import(/* @vite-ignore */ '/_nuxt/lib/graph/graphToPrompt.ts')
      return mod.graphToPrompt(workflow, objectInfo)
    })
    expect(prompt[genNodeId]?.inputs?.style_in).toEqual([mbWireNodeId, 0])
    expect(prompt[mbWireNodeId]?.class_type).toBe('Moodboard')
    expect(JSON.parse(prompt[mbWireNodeId]!.inputs.reading_json).summary).toBe(SUMMARY)
  })

  await test.step('the chip is legible: switch notice + Revert + "refs ✓"', async () => {
    const nodeEl = page.locator(`.vue-flow__node[data-id="${genNodeId}"]`)
    await page.evaluate(() => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.fitView === 'function')) c = c.parent
      c?.exposed.fitView()
    })
    await expect(nodeEl.getByTestId('generate-moodboard-switch-notice')).toBeVisible()
    await expect(nodeEl.getByTestId('generate-moodboard-refs-badge')).toBeVisible()
    await expect(nodeEl.getByTestId('generate-moodboard-revert')).toBeVisible()
  })

  await test.step('the REAL injector skips style_block on a WIRED node (single carrier), still writes style_refs', async () => {
    const workflow = await pullSerializedWorkflow(page)
    const gen = (workflow.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    expect(gen, 'serialized workflow must contain the Generate node').toBeTruthy()
    expect(gen.properties?.style_refs).toBe(styleRefsJson)
    // The wire path never writes the property block.
    expect(gen.properties?.aesthetic).toBeUndefined()

    const slots = widgetSlots('GenerateImageNode', objectInfo)
    const blockIdx = slots.findIndex(s => s.name === 'style_block')
    const refsIdx = slots.findIndex(s => s.name === 'style_refs')
    expect(blockIdx).toBeGreaterThan(-1)
    expect(refsIdx).toBeGreaterThan(-1)

    const injected = JSON.parse(JSON.stringify(workflow))
    realInjectLoraStyle(injected, objectInfo)
    const injGen = (injected.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    // style_in is CONNECTED ⇒ the twin's execute output carries the prose over
    // the wire; the injector must leave style_block EMPTY (no double-prepend).
    expect(String(injGen.widgets_values[blockIdx] ?? '')).toBe('')
    // …while refs still ride the property channel (file paths never wire),
    expect(String(injGen.widgets_values[refsIdx])).toBe(styleRefsJson)
    // …on the switched model.
    const modelIdx = slots.findIndex(s => s.name === 'model')
    expect(injGen.widgets_values[modelIdx]).toBe(MOODBOARD_DEFAULT_MODEL)

    // BROKEN CONTROL: sever the link on a copy and hand the node a property
    // block — the injector MUST write it then. Proves the skip above is
    // LINK-driven, not vacuous (e.g. from an empty style composition).
    const control = JSON.parse(JSON.stringify(workflow))
    const controlGen = (control.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    for (const i of controlGen.inputs ?? []) if (i.name === 'style_in') i.link = null
    controlGen.properties.aesthetic = expectedBlock
    realInjectLoraStyle(control, objectInfo)
    expect(String(controlGen.widgets_values[blockIdx])).toBe(expectedBlock)
  })

  await test.step('Revert restores the model and drops the refs (board stays applied)', async () => {
    // With the auto-created board node beside it, the whole-graph fit parks
    // the generator's footer (where Revert lives) under the bottom-right
    // floating panels. Stack the board BELOW the generator so the fitted view
    // shrinks and the notice row lands in clear canvas (the Reference-node
    // step's reposition pattern).
    await page.evaluate(({ genId, mbId }) => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
      if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
      const nodes = c.exposed.getNodes()
      const gen = nodes.find((n: any) => String(n.id) === String(genId))
      const mb = nodes.find((n: any) => String(n.id) === String(mbId))
      if (gen && mb) mb.position = { x: gen.position.x - 320, y: gen.position.y + 650 }
    }, { genId: genNodeId, mbId: mbWireNodeId })
    await page.waitForTimeout(200)
    await fitCanvas(page)

    const nodeEl = page.locator(`.vue-flow__node[data-id="${genNodeId}"]`)
    await nodeEl.getByTestId('generate-moodboard-revert').click()

    await expect.poll(async () => {
      const { widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)
      return widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]
    }).toBe('flux-schnell')
    const { properties } = await pullNodeData(page, genNodeId)
    expect(properties.sailor_moodboard_switched).toBeUndefined()
    expect(properties.style_refs).toBeUndefined()
    expect(properties.sailor_moodboard).toBe(boardId) // the style block survives revert
    await expect(nodeEl.getByTestId('generate-moodboard-switch-notice')).toBeHidden()
  })

  await test.step('re-applying after the manual state never re-switches (manual choice wins) and never duplicates node or edge', async () => {
    await applyBoardViaGallery(page, genNodeId, boardName)
    // The wire effects re-run async — refs land as '' (flux takes none).
    await expect.poll(async () =>
      (await pullNodeData(page, genNodeId)).properties.style_refs ?? null).toBe('')
    // Board applied with NO marker == the model is the user's own choice.
    const { properties, widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)
    expect(widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]).toBe('flux-schnell')
    expect(properties.sailor_moodboard_switched).toBeUndefined()
    await expect(page.locator(`.vue-flow__node[data-id="${genNodeId}"]`)
      .getByTestId('generate-moodboard-switch-notice')).toBeHidden()

    // FIND-or-create: the same board re-picked reuses its node and its edge.
    const all = await pullAllNodes(page)
    expect(all.filter(n => n.nodeType === 'Moodboard').length).toBe(1)
    const workflow = await pullSerializedWorkflow(page)
    expect((workflow.links as any[]).filter((l: any) => l?.[5] === 'TASTE').length).toBe(1)
  })

  await test.step('✕ removes the TASTE edge — the board node STAYS, the chip empties', async () => {
    await fitCanvas(page)
    const nodeEl = page.locator(`.vue-flow__node[data-id="${genNodeId}"]`)
    await nodeEl.getByTestId('generate-moodboard-chip-clear').click()

    await expect.poll(async () =>
      (await pullNodeData(page, genNodeId)).properties.sailor_moodboard ?? null).toBe(null)
    const { properties } = await pullNodeData(page, genNodeId)
    expect(properties.style_refs).toBeUndefined()
    expect(properties.sailor_moodboard_switched).toBeUndefined()

    // The edge is gone from the serialized graph; the board node survives.
    const workflow = await pullSerializedWorkflow(page)
    const genLg = (workflow.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    expect((genLg.inputs as any[]).find((i: any) => i.name === 'style_in')?.link ?? null).toBeNull()
    expect((workflow.links as any[]).filter((l: any) => l?.[5] === 'TASTE').length).toBe(0)
    expect((workflow.nodes as any[]).some(n =>
      n.type === 'Moodboard' && String(n.id) === mbWireNodeId)).toBe(true)
    await expect(nodeEl.getByTestId('generate-moodboard-chip-add')).toBeVisible()
  })

  await test.step('manual TASTE drag (real pointer gesture) re-wires: chip fills + auto-switches', async () => {
    await fitCanvas(page)
    const styleInIdx = await inputIndexOf(page, genNodeId, 'style_in')
    expect(styleInIdx).toBeGreaterThan(-1)
    const srcHandle = page.locator(
      `.vue-flow__node[data-id="${mbWireNodeId}"] .vue-flow__handle[data-handleid="output-0"]`)
    const tgtHandle = page.locator(
      `.vue-flow__node[data-id="${genNodeId}"] .vue-flow__handle[data-handleid="input-${styleInIdx}"]`)
    let src = await srcHandle.boundingBox()
    let tgt = await tgtHandle.boundingBox()
    expect(src, 'moodboard style handle must be on screen').toBeTruthy()
    expect(tgt, 'generator style_in handle must be on screen').toBeTruthy()

    // fitView() can leave a port sitting under the bottom-centre prompt-bar +
    // toolbar stack (see overlapWithBottomStack above) — the port still has a
    // real bounding box, but a synthetic click at its centre would hit that
    // stack instead. The stack is anchored to the viewport bottom and doesn't
    // move when the canvas pans, so panning UP by however much either
    // endpoint overlaps it reliably clears both; verify with elementFromPoint
    // (the ground truth for "what's actually clickable there"), not just the
    // bounding box, before dragging.
    for (let attempt = 0; attempt < 8; attempt++) {
      const sy0 = src!.y + src!.height / 2
      const ty0 = tgt!.y + tgt!.height / 2
      const overlap = Math.max(await overlapWithBottomStack(page, sy0), await overlapWithBottomStack(page, ty0))
      if (overlap <= 0) break
      // The canvas is zoomed out well below 1x here, so a wheel delta of N
      // moves the viewport by less than N screen px — over-ask so this
      // converges in a couple of iterations instead of creeping.
      await panPaneUpBy(page, overlap * 3)
      src = await srcHandle.boundingBox()
      tgt = await tgtHandle.boundingBox()
      expect(src, 'moodboard style handle must be on screen after pan').toBeTruthy()
      expect(tgt, 'generator style_in handle must be on screen after pan').toBeTruthy()
    }

    const sx = src!.x + src!.width / 2, sy = src!.y + src!.height / 2
    const tx = tgt!.x + tgt!.width / 2, ty = tgt!.y + tgt!.height / 2
    expect(await isHandleTopmostAt(page, sx, sy, 'output-0'),
      'moodboard style handle must be the topmost element at its centre').toBe(true)
    expect(await isHandleTopmostAt(page, tx, ty, `input-${styleInIdx}`),
      'generator style_in handle must be the topmost element at its centre').toBe(true)

    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 6 })
    await page.mouse.move(tx, ty, { steps: 6 })
    await page.mouse.up()

    // Same side effects as the chip apply: identity + auto-switch + marker +
    // refs (the ✕ above cleared the manual-choice state, so the switch fires).
    await expect.poll(async () =>
      (await pullNodeData(page, genNodeId)).properties.sailor_moodboard ?? null,
    { timeout: 10_000 }).toBe(boardId)
    const { properties, widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)
    expect(widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]).toBe(MOODBOARD_DEFAULT_MODEL)
    expect(properties.sailor_moodboard_switched).toBe('flux-schnell')
    expect(JSON.parse(String(properties.style_refs)).folder).toBe(seededFolder)
    // The wire path never writes the property block.
    expect('aesthetic' in properties).toBe(false)

    const workflow = await pullSerializedWorkflow(page)
    const genLg = (workflow.nodes as any[]).find(n => n.type === 'GenerateImageNode')
    expect((genLg.inputs as any[]).find((i: any) => i.name === 'style_in')?.link).not.toBeNull()
  })

  await test.step('manually deleting the TASTE edge empties the chip (board node stays)', async () => {
    // One edge on the canvas at this point — select it with a real click ON
    // the path (bbox-center can miss a bezier; getScreenCTM maps a true
    // path point to screen coords), then the delete key (vue-flow's own
    // removal path → the edge-change hook).
    // 30% along the path, NOT the midpoint — the midpoint hosts the edge's
    // hover "+" (insert-node) affordance, which swallows the click.
    const clickPoint = await page.locator('.vue-flow__edge path').first().evaluate((el) => {
      const path = el as unknown as SVGPathElement
      const p = path.getPointAtLength(path.getTotalLength() * 0.3)
      const sp = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!)
      return { x: sp.x, y: sp.y }
    })
    await page.mouse.click(clickPoint.x, clickPoint.y)
    await expect(page.locator('.vue-flow__edge.selected')).toHaveCount(1)
    await page.keyboard.press('Backspace')

    await expect.poll(async () =>
      (await pullNodeData(page, genNodeId)).properties.sailor_moodboard ?? null,
    { timeout: 10_000 }).toBe(null)
    const { properties, widgetsValues, widgetDefs } = await pullNodeData(page, genNodeId)
    expect(properties.style_refs).toBeUndefined()
    expect(properties.sailor_moodboard_switched).toBeUndefined()
    // The model is left where the apply put it — no silent model change on
    // clear (the picker shows what you're on).
    expect(widgetsValues[widgetDefs.findIndex(d => d.name === 'model')]).toBe(MOODBOARD_DEFAULT_MODEL)

    const workflow = await pullSerializedWorkflow(page)
    expect((workflow.links as any[]).filter((l: any) => l?.[5] === 'TASTE').length).toBe(0)
    expect((workflow.nodes as any[]).some(n =>
      n.type === 'Moodboard' && String(n.id) === mbWireNodeId)).toBe(true)
    await expect(page.locator(`.vue-flow__node[data-id="${genNodeId}"]`)
      .getByTestId('generate-moodboard-chip-add')).toBeVisible()
  })

  // ── (b) the Moodboard node twin: widget sync + serialization shape ────────
  let mbNodeId = ''
  await test.step('Moodboard node references the board → hidden widgets sync by name', async () => {
    mbNodeId = await addNodeAndGetId(page, 'Moodboard')
    await page.evaluate(({ id, boardId }) => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
      const n = c.exposed.getNodes().find((n: any) => String(n.id) === String(id))
      if (!n) throw new Error(`node ${id} not found`)
      n.data.properties = { ...(n.data.properties ?? {}), sailor_moodboard: boardId }
    }, { id: mbNodeId, boardId })

    await expect.poll(async () => {
      const { widgetsValues, widgetDefs } = await pullNodeData(page, mbNodeId)
      const idx = widgetDefs.findIndex(d => d.name === 'reading_json')
      return String(widgetsValues[idx >= 0 ? idx : 0] ?? '')
    }, { timeout: 10_000 }).toContain(SUMMARY)
    const { widgetsValues, widgetDefs } = await pullNodeData(page, mbNodeId)
    const idIdx = widgetDefs.findIndex(d => d.name === 'moodboard_id')
    expect(widgetsValues[idIdx >= 0 ? idIdx : 1]).toBe(boardId)
  })

  await test.step('the serialized workflow carries the twin: reading_json + class_type Moodboard (B4 technique)', async () => {
    const workflow = await pullSerializedWorkflow(page)
    const mb = (workflow.nodes as any[]).find(n => n.type === 'Moodboard')
    expect(mb, 'serialized workflow must contain the Moodboard node').toBeTruthy()
    const readingValue = (mb.widgets_values as any[]).find(v => typeof v === 'string' && v.includes(SUMMARY))
    expect(readingValue, 'widgets_values must carry the reading JSON').toBeTruthy()
    expect(JSON.parse(readingValue).palette).toEqual(READING.palette)

    // The REAL graphToPrompt (the Run path's converter), executed IN-PAGE via
    // the dev server's module graph, over the REAL serialized workflow and the
    // app's own live objectInfo: the node survives as a real class_type with
    // the reading on its reading_json input. The wire DRAG itself needs real
    // vue-flow pointer gestures (synthetic drags are ignored), so the link
    // shape is covered by the graph-to-prompt unit spec; the E2E asserts the
    // twin's serialization from REAL page state.
    const prompt = await page.evaluate(async () => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getWorkflow === 'function')) c = c.parent
      if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
      const workflow = JSON.parse(JSON.stringify(c.exposed.getWorkflow()))
      const objectInfo = JSON.parse(JSON.stringify(c.exposed.getObjectInfo()))
      // Pre-restart tolerance: a backend without the B4 twin lacks Moodboard
      // in /object_info — patch in the twin's declared schema (append-only
      // contract) so the real converter still runs. No-op on a live schema.
      if (!objectInfo.Moodboard) {
        objectInfo.Moodboard = {
          input: {
            required: { reading_json: ['STRING', { multiline: true, default: '' }] },
            optional: { moodboard_id: ['STRING', { default: '' }] },
          },
          output: ['TASTE'],
          output_name: ['style'],
        }
      }
      const mod = await import(/* @vite-ignore */ '/_nuxt/lib/graph/graphToPrompt.ts')
      return mod.graphToPrompt(workflow, objectInfo)
    })
    const entry = prompt[String(mb.id)]
    expect(entry?.class_type).toBe('Moodboard')
    expect(JSON.parse(entry!.inputs.reading_json).summary).toBe(SUMMARY)
    expect(entry!.inputs.moodboard_id).toBe(boardId)
  })

  // ── (c) @refs exposure on save ────────────────────────────────────────────
  await test.step('modal Save registers mb-<slug>-0..2 into the project @refs registry', async () => {
    await page.evaluate((id) =>
      window.dispatchEvent(new CustomEvent('sailor:openMoodboard', { detail: { nodeId: id } })), mbNodeId)
    const modal = page.getByTestId('moodboard-modal')
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('mb-summary')).toHaveValue(SUMMARY, { timeout: 10_000 })
    await expect(modal.getByTestId('mb-save')).toBeEnabled()
    await modal.getByTestId('mb-save').click()

    // The flat copies land in the input ROOT (the shape /view can serve).
    await expect.poll(() => [0, 1, 2].every(i => fs.existsSync(path.join(inputRoot, flatFile(i)))),
      { timeout: 10_000 }).toBe(true)

    // The registry (persisted ProjectDoc.assetRegistry) carries the names.
    await expect.poll(async () => await page.evaluate(() => {
      const raw = sessionStorage.getItem('sailor:workflows')
      const docs = raw ? JSON.parse(raw) : {}
      const merged: Record<string, any> = {}
      for (const doc of Object.values<any>(docs)) Object.assign(merged, doc?.assetRegistry ?? {})
      return merged
    }), { timeout: 10_000 }).toMatchObject({
      [refName(0)]: { filename: flatFile(0) },
      [refName(1)]: { filename: flatFile(1) },
      [refName(2)]: { filename: flatFile(2) },
    })

    // Each registered filename RESOLVES in ComfyUI's input dir via /view —
    // the whole point of the flatten (subpath filenames 404 here).
    for (let i = 0; i < 3; i++) {
      const res = await page.request.get(`/view?filename=${encodeURIComponent(flatFile(i))}&type=input`)
      expect(res.status(), `${flatFile(i)} must resolve via /view type=input`).toBe(200)
    }

    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(modal).toBeHidden()
  })

  await test.step('the Reference node sees and loads the new @refs (user-visible resolution)', async () => {
    const refNodeId = await addNodeAndGetId(page, 'Reference')
    const refEl = page.locator(`.vue-flow__node[data-id="${refNodeId}"]`)
    // The exposed fitView always fits the WHOLE graph, which parks this node
    // behind the floating prompt bar at the bottom (it intercepts the picker
    // clicks). Move the node ABOVE the rest first, so after the fit its picker
    // list drops into clear canvas.
    await page.evaluate((id) => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
      if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
      const nodes = c.exposed.getNodes()
      const minY = Math.min(...nodes.map((n: any) => n.position?.y ?? 0))
      const me = nodes.find((n: any) => String(n.id) === String(id))
      me.position = { x: me.position?.x ?? 0, y: minY - 500 }
    }, refNodeId)
    await page.waitForTimeout(200) // let vue-flow ingest the new position…
    await page.evaluate(() => {   // …then fit, so the fit sees the moved node
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.fitView === 'function')) c = c.parent
      c?.exposed.fitView()
    })
    await page.waitForTimeout(400)
    await refEl.getByRole('button', { name: 'Pick a reference…' }).click()
    await refEl.getByRole('button', { name: `@${refName(0)}` }).click()
    // The thumb <img> really decodes — filename resolution proven in the app's
    // own widget, not just via a raw HTTP probe.
    const thumb = refEl.locator(`img[src*="${flatFile(0)}"]`)
    await expect(thumb).toBeVisible()
    await expect.poll(async () =>
      await thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    { timeout: 10_000 }).toBe(true)
  })

  await test.step('cleanup: strip this run\'s registry names from the live doc (best-effort)', async () => {
    await page.evaluate((names) => {
      try {
        let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
        while (c && !(c.setupState && ('activeProjectDoc' in c.setupState))) c = c.parent
        const docRef = c?.setupState?.activeProjectDoc
        const doc = docRef && typeof docRef === 'object' && 'value' in docRef ? docRef.value : docRef
        if (!doc?.assetRegistry) return
        const next = { ...doc.assetRegistry }
        for (const n of names) delete next[n]
        doc.assetRegistry = next
        c?.setupState?.persistWorkflows?.()
      } catch { /* best-effort — session-scoped state dies with the context anyway */ }
    }, [refName(0), refName(1), refName(2)])
  })
})
