import { readFile, writeFile } from 'node:fs/promises'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { openHarness, renderExported, pixelDiff } from './_frameEmbedHelpers'
import { openBlankWorkflow, waitForBackend } from './_helpers'
import { externalRefs } from '../app/lib/embed/bundle'

test.describe('Frame embed — zero network', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  // 'shatter'/'boolean' (R9/R14c): both fixtures carry FrameSnapshot.needsOutlines: true, so
  // surfaces/frame.ts's mount() now `await warmPaperBoolean()`s — which does `import('paper')` —
  // BEFORE its first paint, every time, not merely on some cold/best-effort path. This proves that
  // AWAITED import resolves against the full bundle's own inlined paper-core module and never
  // reaches the network, however this fixture's needsOutlines flag routes it (currently 'frame',
  // never 'frame-lean' — see gather.ts's computeNeedsOutlines).
  // 'outline' / 'text-partner' (C1 / I1): outlined text and a text boolean partner — both reach
  // the outline-font loader, which must answer from the file, never /api/fonts/….
  // 'wired-clip' (Task 7): an animated wired studio baked into frames inside the file.
  for (const name of ['vector', 'image', 'backdrop', 'still', 'fill', 'standin', 'shatter', 'boolean', 'outline', 'text-partner', 'wired-clip']) {
    test(`the "${name}" export makes no request`, async ({ page, context }) => {
      const html = await page.evaluate(async (n) => {
        const H = (window as any).__frameEmbedHarness
        return await H.exportHtml(await H.snapshot(n))
      }, name)
      const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
      expect(requests).toEqual([])
    })
  }

  // Task 7: the wired clip PLAYS — the file's canvas differs between two moments — and it does so
  // from the frames inside the file (the zero-request check above covers the same fixture).
  test('an animated wired layer plays in the export instead of freezing', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('wired-clip')
      if (snap.wired[0]?.kind !== 'clip' || snap.wired[0].frames.length !== 6) throw new Error('the wired-clip fixture did not bake 6 frames')
      if (snap.still) throw new Error('a Frame with a wired clip must not be a still')
      return await H.exportHtml(snap)
    })
    const a = await renderExported(context, html, 0.1, { width: 1000, height: 500 })
    const b = await renderExported(context, html, 0.6, { width: 1000, height: 500 })
    expect(a.requests).toEqual([])
    expect(b.requests).toEqual([])
    const { differing } = await pixelDiff(page, a.png, b.png)
    expect(differing).toBeGreaterThan(1000)
  })

  // The gate on the gate: a snapshot with one inlined image removed must make the painter fall
  // back to the server URL, and this listener must see that request. Otherwise the tests above
  // prove nothing. The image removed is the image FILL: an image LAYER or clip frame missing from
  // the snapshot makes the adapter refuse to mount at all (the poster stays; see the contract
  // spec), so the fill is the path on which the painter itself still reaches for its URL.
  test('a missing inlined asset IS seen as a request', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('fill')
      const key = Object.keys(snap.assets.urls).find(k => k.startsWith('fillImage|'))
      if (!key) throw new Error('the fill fixture carries no inlined image fill')
      delete snap.assets.urls[key]
      return await H.exportHtml(snap)
    })
    // ignorePageErrorsMatching, not a blanket allow (fix round 2): this test deliberately makes
    // the painter reach for a missing asset — Chromium logs its own console.error for the
    // resulting failed request (ERR_NAME_NOT_RESOLVED, since EMBED_URL's origin never resolves),
    // which is proof the mechanism worked, not a defect — but any OTHER page error here would
    // still be a real one, and must still fail this test.
    const { requests } = await renderExported(
      context, html, 0.4, { width: 1000, height: 500 }, { ignorePageErrorsMatching: /ERR_NAME_NOT_RESOLVED/ },
    )
    expect(requests.some(u => u.includes('/view?'))).toBe(true)
  })
})

// ── Task 2 (live wired layers): an animated wired Gradient plays LIVE in the Frame export ────────
// End to end in the real app: a Gradient Studio node (animated: one hue track) wired into a Frame,
// the Frame editor's own export sheet, the downloaded file. The file carries the Gradient's own
// embed player, not frames; it makes no request; two frozen moments differ inside the Gradient's
// box; and the nested player draws at the box's size and the Gradient's own aspect — not the
// 512-square its adapter falls back to when mounted off-document, stretched into the box.

/** The Frame's wired layer box in the exported canvas's pixels, from the file's own snapshot. */
function boxOf(snap: any, cw: number, ch: number): { x: number; y: number; w: number; h: number } {
  const v = snap.variants[0]
  const wl = v.layers.find((l: any) => l.kind === 'wired')
  const k = cw / v.width   // the viewport has the artboard's aspect, so Fit maps it edge to edge
  const w = wl.w * v.width * k, h = wl.w * (wl.lastAspect || 1) * v.width * k
  return { x: wl.x * cw - w / 2, y: wl.y * ch - h / 2, w, h }
}

/** Loads the file frozen at `t01` and reads every WebGL2 canvas it made (the nested players draw
 *  off-document, so they are found by hooking getContext) plus the Frame's own canvas size. */
async function probeGlCanvases(context: BrowserContext, html: string, t01: number, viewport: { width: number; height: number }) {
  const url = 'http://frame-embed-probe.invalid/'
  await context.addInitScript((t: number) => {
    ;(window as any).__SAILOR_FREEZE_T01__ = t
    const gl: HTMLCanvasElement[] = ((window as any).__glCanvases = [])
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: any[]) {
      if (kind === 'webgl2' && !gl.includes(this)) gl.push(this)
      return (orig as any).call(this, kind, ...rest)
    } as any
  }, t01)
  const p = await context.newPage()
  await p.route(url, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await p.setViewportSize(viewport)
  await p.goto(url)
  await p.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 30_000 })
  await p.waitForTimeout(300)
  const out = await p.evaluate(() => {
    const main = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement
    return {
      main: { w: main.width, h: main.height },
      gl: ((window as any).__glCanvases as HTMLCanvasElement[]).map(c => ({ w: c.width, h: c.height, inDocument: c.isConnected })),
    }
  })
  await p.close()
  return out
}

/** Pixels inside `box` whose any channel differs by more than `threshold` levels. */
async function regionDiff(page: Page, a: string, b: string, box: { x: number; y: number; w: number; h: number }, threshold = 8) {
  return await page.evaluate(async ([x, y, bx, th]) => {
    const load = (u: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [ia, ib] = await Promise.all([load(x as string), load(y as string)])
    const r = bx as { x: number; y: number; w: number; h: number }
    const x0 = Math.max(0, Math.ceil(r.x) + 2), y0 = Math.max(0, Math.ceil(r.y) + 2)
    const w = Math.min(ia.width - x0, Math.floor(r.w) - 4), h = Math.min(ia.height - y0, Math.floor(r.h) - 4)
    const data = (i: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
      const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(x0, y0, w, h).data
    }
    const da = data(ia), db = data(ib)
    let differing = 0
    for (let p = 0; p < da.length; p += 4) {
      if (Math.abs(da[p]! - db[p]!) > (th as number) || Math.abs(da[p + 1]! - db[p + 1]!) > (th as number)
        || Math.abs(da[p + 2]! - db[p + 2]!) > (th as number)) differing++
    }
    return { differing, total: da.length / 4 }
  }, [a, b, box, threshold] as const)
}

test.describe('Frame embed — a wired Gradient plays live', () => {
  test('the sheet says it plays live; the file carries its player, makes no request, animates, and keeps its shape', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000)
    // The export-time check's line (Task 5): it must have matched for the layer to play live.
    page.on('console', (m) => { if (/^\[Frame\] .*checked in/.test(m.text())) console.log(`[live-gradient] ${m.text()}`) })

    // An animated Gradient config: the embed harness's own fixture (the studio's defaults plus a
    // full hue sweep over 4 s), made 16:9 so a stretched square would show.
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() => (window as any).__embedHarnessGradientReady === true, undefined, { timeout: 30_000 })
    const cfg = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__embedHarnessGradient.config.cfg)))
    cfg.canvas.aspect = '16:9'

    await openBlankWorkflow(page)
    await waitForBackend(page)
    const ids = async () => await page.locator('.vue-flow__node').evaluateAll(els => els.map(e => e.getAttribute('data-id')))
    const before = new Set(await ids())
    await page.evaluate((c) => {
      window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'GradientStudio', propertyOverrides: { sailor_gradientStudio: c } } }))
    }, cfg)
    await expect.poll(async () => (await ids()).filter(i => !before.has(i)).length, { timeout: 10_000 }).toBe(1)
    const gradientId = (await ids()).find(i => !before.has(i))!
    const withGradient = new Set(await ids())
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('sailor:applyEffect', { detail: { nodeId: id, nodeType: 'Compositor', output: 'IMAGE' } }))
    }, gradientId)
    await expect.poll(async () => (await ids()).filter(i => !withGradient.has(i)).length, { timeout: 15_000 }).toBe(1)
    const frameId = (await ids()).find(i => !withGradient.has(i))!

    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), frameId)
    const stack = page.locator('[data-testid="compositor-stack-canvas"]')
    await stack.waitFor({ state: 'visible', timeout: 15_000 })
    // The editor's picture of the same Frame, kept beside the export's for a look by eye (the hue
    // sweeps with time, so they are compared for shape, not colour).
    await page.waitForTimeout(1_000)
    await stack.screenshot({ path: testInfo.outputPath('live-gradient-editor.png') })
    await page.locator('[data-testid="compositor-right-panel"]').getByRole('button', { name: /^Download/ }).click()
    await page.locator('[data-testid="frame-web-export"]').click()
    const sheet = page.locator('[data-testid="frame-web-export-sheet"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('One file · plays anywhere')).toBeVisible({ timeout: 120_000 })
    await expect(sheet.getByText(/ · plays live · adds \d/)).toBeVisible()
    await expect(sheet.getByText(/pre-rendered/)).toHaveCount(0)
    const line = await sheet.getByText(/ · plays live · adds \d/).innerText()
    await sheet.screenshot({ path: testInfo.outputPath('live-gradient-sheet.png') })

    const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download' }).click()])
    const html = await readFile((await download.path())!, 'utf8')
    const bytes = Buffer.byteLength(html, 'utf8')
    testInfo.annotations.push({ type: 'export', description: `${line} · file ${bytes} bytes` })
    console.log(`[live-gradient] sheet line "${line}", file ${bytes} bytes (${(bytes / 1024).toFixed(0)} KB)`)
    expect(externalRefs(html)).toEqual([])
    const start = html.indexOf('window.__SAILOR_SNAPSHOT__ = ')
    const outer = JSON.parse(html.slice(start + 'window.__SAILOR_SNAPSHOT__ = '.length, html.indexOf('</script>', start)).trim().replace(/;$/, ''))
    const snap = outer.config   // the Frame's own snapshot
    const entry = snap.wired[0]
    expect(entry).toMatchObject({ kind: 'live', surface: 'gradient', bundle: 'gradient', duration: 4 })
    expect(entry.width / entry.height).toBeCloseTo(16 / 9, 2)
    expect(html).toContain('__SAILOR_NESTED__')
    expect(bytes).toBeLessThan(2 * 1024 * 1024)   // a player and a config, not 120 frames

    const v = snap.variants[0]
    const vw = 1000, vh = Math.round(1000 * v.height / v.width)
    const a = await renderExported(context, html, 0, { width: vw, height: vh })
    const b = await renderExported(context, html, 0.5, { width: vw, height: vh })
    expect(a.requests).toEqual([])
    expect(b.requests).toEqual([])
    await writeFile(testInfo.outputPath('live-gradient-export-t0.png'), Buffer.from(a.png.split(',')[1]!, 'base64'))
    await writeFile(testInfo.outputPath('live-gradient-export-t05.png'), Buffer.from(b.png.split(',')[1]!, 'base64'))
    const dims = await page.evaluate(async (u) => await new Promise<[number, number]>((res) => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = u }), a.png)
    const box = boxOf(snap, dims[0], dims[1])
    const { differing, total } = await regionDiff(page, a.png, b.png, box)
    console.log(`[live-gradient] frame ${v.width}×${v.height}, canvas ${dims[0]}×${dims[1]}, box ${box.w.toFixed(0)}×${box.h.toFixed(0)}; t 0 vs 0.5: ${differing} of ${total} px differ`)
    expect(differing).toBeGreaterThan(total * 0.5)

    // Shape: the nested player's canvas is off-document, at the Gradient's own 16:9 and the box's
    // size in device pixels — the Frame hands it a box-sized picture, never a stretched square.
    const probe = await probeGlCanvases(context, html, 0.25, { width: vw, height: vh })
    console.log(`[live-gradient] main ${probe.main.w}×${probe.main.h}; webgl2 canvases ${JSON.stringify(probe.gl)}`)
    const pbox = boxOf(snap, probe.main.w, probe.main.h)
    const nested = probe.gl.filter(c => !c.inDocument)
    expect(nested.length).toBeGreaterThan(0)
    const player = nested.find(c => Math.abs(c.w / c.h - 16 / 9) < 0.01)
    expect(player, `no off-document 16:9 player canvas among ${JSON.stringify(nested)}`).toBeTruthy()
    expect(Math.abs(player!.w - Math.round(Math.max(pbox.w, pbox.h)))).toBeLessThanOrEqual(2)
    expect(nested.some(c => c.w === 512 && c.h === 512)).toBe(false)
  })
})

// ── Task 4 (live wired layers): a wired Space Type on a verified effect plays LIVE ────────────────
// End to end in the real app, like the Gradient case above: a Space Type node on a verified effect
// (its own default state: a 6 s loop, 16:9) wired into a Frame, the Frame editor's export sheet,
// the downloaded file. The file carries the effect's own player with its face inlined, makes no
// request, and moves inside the layer's box. An effect that is NOT verified still exports as
// frames (the fallback). tests/spacetype-live-parity.spec.ts is what fills the verified list.

/** Builds a blank project with one Space Type node holding `state`, wires it into a new Frame,
 *  opens the Frame's export sheet and downloads the file. */
async function exportWiredSpaceType(page: Page, state: unknown, shot: string): Promise<{ sheetText: string; html: string; bytes: number }> {
  await openWiredSpaceTypeFrame(page, state)
  return await exportOpenFrame(page, shot)
}

/** A blank project with one Space Type node holding `state`, wired into a new Frame whose editor
 *  is left open. */
async function openWiredSpaceTypeFrame(page: Page, state: unknown): Promise<void> {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  const ids = async () => await page.locator('.vue-flow__node').evaluateAll(els => els.map(e => e.getAttribute('data-id')))
  const before = new Set(await ids())
  await page.evaluate((s) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'SpaceType', propertyOverrides: { sailor_spaceType: s } } }))
  }, state)
  await expect.poll(async () => (await ids()).filter(i => !before.has(i)).length, { timeout: 10_000 }).toBe(1)
  const spaceTypeId = (await ids()).find(i => !before.has(i))!
  const withNode = new Set(await ids())
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('sailor:applyEffect', { detail: { nodeId: id, nodeType: 'Compositor', output: 'IMAGE' } }))
  }, spaceTypeId)
  await expect.poll(async () => (await ids()).filter(i => !withNode.has(i)).length, { timeout: 15_000 }).toBe(1)
  const frameId = (await ids()).find(i => !withNode.has(i))!

  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), frameId)
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(1_000)
}

/** The open Frame editor's export sheet, built and downloaded (the sheet closes on Download). */
async function exportOpenFrame(page: Page, shot: string): Promise<{ sheetText: string; html: string; bytes: number }> {
  await page.locator('[data-testid="compositor-right-panel"]').getByRole('button', { name: /^Download/ }).click()
  await page.locator('[data-testid="frame-web-export"]').click()
  const sheet = page.locator('[data-testid="frame-web-export-sheet"]')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('One file · plays anywhere')).toBeVisible({ timeout: 180_000 })
  await sheet.screenshot({ path: shot })
  const sheetText = await sheet.innerText()
  const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download' }).click()])
  const html = await readFile((await download.path())!, 'utf8')
  return { sheetText, html, bytes: Buffer.byteLength(html, 'utf8') }
}

function snapshotOf(html: string): any {
  const start = html.indexOf('window.__SAILOR_SNAPSHOT__ = ')
  return JSON.parse(html.slice(start + 'window.__SAILOR_SNAPSHOT__ = '.length, html.indexOf('</script>', start)).trim().replace(/;$/, '')).config
}

async function spaceTypeDefaultState(page: Page, effectId: string): Promise<{ state: any; verified: string[] }> {
  await page.goto('/dev/spacetype-live-parity')
  await page.waitForFunction(() => (window as any).__parityHarnessReady === true, undefined, { timeout: 60_000 })
  return await page.evaluate((id) => {
    const H = (window as any).__parityHarness
    return { state: JSON.parse(JSON.stringify(H.defaultState(id))), verified: H.verified() }
  }, effectId)
}

test.describe('Frame embed — a wired Space Type plays live', () => {
  test('a verified effect: the sheet says it plays live; the file carries its player, makes no request and moves', async ({ page, context }, testInfo) => {
    test.setTimeout(300_000)
    const EFFECT = 'field'
    const { state, verified } = await spaceTypeDefaultState(page, EFFECT)
    expect(verified).toContain(EFFECT)
    expect(state.loopDuration).toBe(6)

    const { sheetText, html, bytes } = await exportWiredSpaceType(page, state, testInfo.outputPath('live-spacetype-sheet.png'))
    const line = sheetText.split('\n').find(l => / · plays live · adds \d/.test(l)) ?? ''
    testInfo.annotations.push({ type: 'export', description: `${line} · file ${bytes} bytes` })
    console.log(`[live-spacetype] sheet line "${line}", file ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
    expect(line).not.toBe('')
    expect(sheetText).not.toMatch(/pre-rendered/)

    expect(externalRefs(html)).toEqual([])
    const snap = snapshotOf(html)
    const entry = snap.wired[0]
    expect(entry).toMatchObject({ kind: 'live', surface: 'spacetype', bundle: `spacetype-${EFFECT}`, duration: 6 })
    expect(entry.config.font).toMatchObject({ family: 'Inter', weight: 700 })
    expect(entry.config.font.dataUrl.startsWith('data:font/ttf;base64,')).toBe(true)
    expect(html).toContain(`m["spacetype-${EFFECT}"]`)   // the effect's player, registered as a nested one
    expect(bytes).toBeLessThan(3 * 1024 * 1024)   // a player, a face and a config — not 180 frames

    const v = snap.variants[0]
    const vw = 1000, vh = Math.round(1000 * v.height / v.width)
    const a = await renderExported(context, html, 0, { width: vw, height: vh })
    const b = await renderExported(context, html, 0.5, { width: vw, height: vh })
    expect(a.requests).toEqual([])
    expect(b.requests).toEqual([])
    await writeFile(testInfo.outputPath('live-spacetype-export-t0.png'), Buffer.from(a.png.split(',')[1]!, 'base64'))
    await writeFile(testInfo.outputPath('live-spacetype-export-t05.png'), Buffer.from(b.png.split(',')[1]!, 'base64'))
    const dims = await page.evaluate(async (u) => await new Promise<[number, number]>((res) => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = u }), a.png)
    const box = boxOf(snap, dims[0], dims[1])
    const { differing, total } = await regionDiff(page, a.png, b.png, box)
    console.log(`[live-spacetype] frame ${v.width}×${v.height}, canvas ${dims[0]}×${dims[1]}, box ${box.w.toFixed(0)}×${box.h.toFixed(0)}; t 0 vs 0.5: ${differing} of ${total} px differ`)
    expect(box.w).toBeGreaterThan(dims[0] * 0.95)   // the layer fills the Frame
    expect(differing).toBeGreaterThan(total * 0.2)
  })

  // Task 5: every live layer is checked against the editor's picture when it is exported. A
  // verified effect in its default face (Inter 700) matches and plays live; the SAME Frame, after
  // the Space Type's face is switched to Inter at 600 (an optical-size face the file's static
  // instance does not match — Task 4 measured 6.5% of pixels off), is checked again, mismatches,
  // and exports as frames. The check's own console lines give its diffs and the time it adds.
  test('the export-time check: a verified effect plays live in its default face, and as frames in Inter 600', async ({ page, context }, testInfo) => {
    test.setTimeout(480_000)
    const EFFECT = 'field'
    const checks: string[] = []
    page.on('console', (m) => { if (/^\[Frame\] .*(plays live: |exports as frames: )/.test(m.text())) checks.push(m.text()) })
    const { state, verified } = await spaceTypeDefaultState(page, EFFECT)
    expect(verified).toContain(EFFECT)
    expect(state.params.font).toBe('Inter')

    // 1. Default face → the check matches → live.
    await openWiredSpaceTypeFrame(page, state)
    const t1 = Date.now()
    const live = await exportOpenFrame(page, testInfo.outputPath('check-live-sheet.png'))
    const liveMs = Date.now() - t1
    const liveLine = live.sheetText.split('\n').find(l => / · plays live · adds \d/.test(l)) ?? ''
    console.log(`[live-check] default face: sheet "${liveLine}", file ${live.bytes} bytes, export ${liveMs} ms`)
    expect(liveLine).not.toBe('')
    expect(live.sheetText).not.toMatch(/pre-rendered/)
    expect(externalRefs(live.html)).toEqual([])
    const liveEntry = snapshotOf(live.html).wired[0]
    expect(liveEntry).toMatchObject({ kind: 'live', bundle: `spacetype-${EFFECT}` })
    expect(liveEntry.config.font).toMatchObject({ family: 'Inter', weight: 700 })

    // 2. The same Frame, the Space Type switched to Inter 600 → the check mismatches → frames.
    const at600 = { ...state, params: { ...state.params, font: 'Inter', typeWeight: 600 } }
    await page.evaluate((s) => {
      window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', { detail: { match: 'SpaceType', patch: { properties: { sailor_spaceType: s } } } }))
    }, at600)
    await page.waitForTimeout(3_000)   // the node rebuilds and its face loads, as a person's edit would
    const t2 = Date.now()
    const frames = await exportOpenFrame(page, testInfo.outputPath('check-frames-sheet.png'))
    const framesMs = Date.now() - t2
    const framesLine = frames.sheetText.split('\n').find(l => / · pre-rendered · /.test(l)) ?? ''
    console.log(`[live-check] Inter 600: sheet "${framesLine}", file ${frames.bytes} bytes, export ${framesMs} ms`)
    expect(framesLine).not.toBe('')
    expect(frames.sheetText).not.toMatch(/plays live/)
    expect(externalRefs(frames.html)).toEqual([])
    expect(snapshotOf(frames.html).wired[0].kind).toBe('clip')
    expect(frames.html).not.toContain(`m["spacetype-${EFFECT}"]`)

    // The check's own lines: one match (default face), one mismatch (Inter 600), each timed.
    for (const c of checks) console.log(`[live-check] ${c}`)
    testInfo.annotations.push({ type: 'live-check', description: checks.join(' | ') })
    expect(checks.length).toBe(2)
    expect(checks[0]).toMatch(/plays live: its player matches the editor · checked in \d+ ms/)
    expect(checks[1]).toMatch(/exports as frames: its live player does not match the editor .* · checked in \d+ ms/)

    // Both files make zero requests when played.
    for (const [name, html] of [['live', live.html], ['frames', frames.html]] as const) {
      const v = snapshotOf(html).variants[0]
      const vw = 1000, vh = Math.round(1000 * v.height / v.width)
      const r = await renderExported(context, html, 0.3, { width: vw, height: vh })
      expect(r.requests, name).toEqual([])
      await writeFile(testInfo.outputPath(`check-${name}-export.png`), Buffer.from(r.png.split(',')[1]!, 'base64'))
    }
  })

  test('an effect that is not verified still exports as frames', async ({ page }, testInfo) => {
    test.setTimeout(400_000)
    // cascade: no "cannot carry" reason, but the parity spec measured it differing from the editor.
    const EFFECT = 'cascade'
    const { state, verified } = await spaceTypeDefaultState(page, EFFECT)
    expect(verified).not.toContain(EFFECT)

    const { sheetText, html, bytes } = await exportWiredSpaceType(page, state, testInfo.outputPath('frames-spacetype-sheet.png'))
    const line = sheetText.split('\n').find(l => / · pre-rendered · /.test(l)) ?? ''
    console.log(`[frames-spacetype] sheet line "${line}", file ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
    expect(line).not.toBe('')
    expect(sheetText).not.toMatch(/plays live/)
    expect(externalRefs(html)).toEqual([])
    const entry = snapshotOf(html).wired[0]
    expect(entry.kind).toBe('clip')
    expect(html).not.toContain(`m["spacetype-${EFFECT}"]`)   // no nested player was concatenated in
  })
})
