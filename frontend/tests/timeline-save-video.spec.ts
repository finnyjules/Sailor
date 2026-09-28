import { test, expect, type Page } from '@playwright/test'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { openBlankWorkflow, waitForBackend, dismissStartModal } from './_helpers'

// The user's journey, locked forever: two video assets → Timeline (2 clips) →
// SaveVideo, built entirely through the real canvas UI, then RUN to a real
// .mp4 in output/video/.
//
// This guards the "SaveVideo received IMAGE, wants VIDEO" regression family:
// the Timeline exposes IMAGE `frames` (slot 0) and VIDEO `video` (slot 1), and
// any sloppy gesture — wire released on the node body, or within Vue Flow's
// 20px proximity snap of the WRONG handle — used to land on slot 0 and poison
// the graph. Both the SaveVideo hookup and the second clip hookup below use
// the body-drop gesture on purpose: the canvas must resolve them to the
// type-compatible ports (video → VIDEO, clip2 → IMAGE,VIDEO union), never
// index 0.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(thisDir, '../..')
const inputDir = path.join(repoRoot, 'input')
const outputVideoDir = path.join(repoRoot, 'output', 'video')
const FIXTURES = ['fixtest_clip_a.mp4', 'fixtest_clip_b.mp4']

/** Small fixture clips only — never chew on a user's real 1080p footage. */
function fixturesPresent(): boolean {
  return FIXTURES.every((f) => {
    const p = path.join(inputDir, f)
    return existsSync(p) && statSync(p).size < 5_000_000
  })
}

/** Right-click → Fit View, so every node + handle is on-screen for wiring. */
async function fitView(page: Page) {
  await page.locator('.vue-flow__pane').click({ button: 'right', position: { x: 80, y: 400 } })
  await page.getByText('Fit View').click()
  await page.waitForTimeout(300)
}

/** Drop a node (catalog type OR assets-panel video asset) at a specific FLOW
 *  coordinate via the canvas's real HTML5 drop path — the same handler the
 *  sidebar / assets-panel drags hit. The drop event is synthetic, so the
 *  target point may be outside the current viewport; we invert the pane
 *  transform to hand the handler the right clientX/Y. Retries because the
 *  async initial workflow load can wipe a node added too early
 *  (port-intent.spec.ts dance). */
async function dropAtFlowAndWait(
  page: Page,
  payload: { nodeType?: string; asset?: Record<string, unknown> },
  flow: { x: number; y: number },
  existing: number,
) {
  const nodes = page.locator('.vue-flow__node')
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await nodes.count() <= existing) {
      await page.evaluate(({ p, fx, fy }) => {
        const pane = document.querySelector('.vue-flow') as HTMLElement
        const tp = document.querySelector('.vue-flow__transformationpane') as HTMLElement
        if (!pane || !tp) throw new Error('.vue-flow not found')
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(tp.style.transform)
        const [tx, ty, zoom] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1]
        const rect = pane.getBoundingClientRect()
        const clientX = rect.left + fx * zoom + tx
        const clientY = rect.top + fy * zoom + ty
        const dt = new DataTransfer()
        if (p.asset) dt.setData('application/x-sailor-asset', JSON.stringify(p.asset))
        else dt.setData('text/plain', p.nodeType!)
        pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY }))
      }, { p: payload, fx: flow.x, fy: flow.y })
      await page.waitForTimeout(400)
    }
    try {
      await nodes.nth(existing).waitFor({ state: 'visible', timeout: 3000 })
      // Survive the late workflow-load wipe: confirm it's still there shortly after.
      await page.waitForTimeout(700)
      if (await nodes.count() > existing) return
    }
    catch { /* retry */ }
  }
  throw new Error(`Node ${JSON.stringify(payload)} did not render after retries`)
}

/** Drag from a source point to a target point with the mouse — the same
 *  gesture a user makes when wiring ports. */
async function dragWire(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(250)
}

function center(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('Timeline → SaveVideo end to end', () => {
  test('two videos → Timeline → SaveVideo wires type-correctly and renders a real video', async ({ page }) => {
    test.skip(!fixturesPresent(), 'small fixtest_clip_*.mp4 fixtures missing from input/')
    test.setTimeout(300_000)

    await waitForBackend(page)
    await openBlankWorkflow(page)
    await dismissStartModal(page)

    // ── Build the graph exactly as the user did ─────────────────────────────
    // Two Video artifact nodes carrying the fixture clips (the assets-panel
    // drop path), then Timeline and SaveVideo from the catalog drag path.
    // Flow-coordinate layout spreads them so every port stays reachable for
    // mouse wiring after one Fit View.
    await dropAtFlowAndWait(page, { asset: { kind: 'video', filename: FIXTURES[0], type: 'input' } }, { x: 0, y: 0 }, 0)
    await dropAtFlowAndWait(page, { asset: { kind: 'video', filename: FIXTURES[1], type: 'input' } }, { x: 0, y: 560 }, 1)
    await dropAtFlowAndWait(page, { nodeType: 'Timeline' }, { x: 640, y: 260 }, 2)
    await dropAtFlowAndWait(page, { nodeType: 'SaveVideo' }, { x: 1260, y: 260 }, 3)
    await fitView(page)

    const nodes = page.locator('.vue-flow__node')
    const videoA = nodes.nth(0)
    const videoB = nodes.nth(1)
    const timeline = nodes.nth(2)
    const saveVideo = nodes.nth(3)
    await expect(timeline.getByRole('button', { name: 'Open', exact: true })).toHaveCount(1)

    // Unique filename prefix per run: keeps the prompt out of ComfyUI's
    // result cache (identical prompts re-serve old outputs and no fresh file
    // would land) and makes the on-disk assertion exact.
    const runTag = `e2e_tl_${Date.now()}`
    const prefixInput = saveVideo.locator('input').first()
    await expect(prefixInput).toHaveValue(/video/)
    await prefixInput.fill(`video/${runTag}`)

    // ── Wire clip 1: Video A output → Timeline clip input (port-to-port) ───
    const aOut = (await videoA.locator('.vue-flow__handle.source').first().boundingBox())!
    const tIn0 = (await timeline.locator('.vue-flow__handle.target').first().boundingBox())!
    await dragWire(page, center(aOut), center(tIn0))
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)

    // ── Wire clip 2: Video B output → released on the Timeline node BODY ───
    // The sloppy gesture. The canvas must pick the next FREE union-compatible
    // clip input (input-1), not the occupied slot and not a wrong type.
    const bOut = (await videoB.locator('.vue-flow__handle.source').first().boundingBox())!
    const tBody = (await timeline.boundingBox())!
    await dragWire(page, center(bOut), center(tBody))
    await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
    // Grow-on-connect: a third clip input appears once two are occupied.
    await expect(timeline.locator('.vue-flow__handle.target')).toHaveCount(3)

    // ── Wire SaveVideo: drag from its VIDEO input, release on Timeline BODY ─
    // This is the exact gesture family that used to produce
    // "video, received_type(IMAGE) mismatch input_type(VIDEO)": anything but a
    // pixel-perfect drop on the green `video` handle landed on slot 0.
    const svIn = (await saveVideo.locator('.vue-flow__handle.target').first().boundingBox())!
    const tBody2 = (await timeline.boundingBox())!
    await dragWire(page, center(svIn), center(tBody2))
    await expect(page.locator('.vue-flow__edge')).toHaveCount(3)

    // Every edge in this graph carries VIDEO; an IMAGE-typed (blue) edge means
    // something auto-picked the Timeline's `frames` output again.
    await expect(page.locator('.vue-flow__edge path[stroke="#60a5fa"]')).toHaveCount(0)
    expect(await page.locator('.vue-flow__edge path[stroke="#4ade80"]').count()).toBeGreaterThan(0)

    // ── Run ─────────────────────────────────────────────────────────────────
    const baseline = new Set(existsSync(outputVideoDir) ? readdirSync(outputVideoDir) : [])
    const runStarted = Date.now()
    await page.getByRole('button', { name: 'Run', exact: true }).click()

    // No validation failure may surface (the old failure mode), and no node
    // may go red.
    await page.waitForTimeout(8_000)
    await expect(page.locator('[data-sonner-toast]', { hasText: 'Workflow validation failed' })).toHaveCount(0)
    await expect(page.locator('[data-sonner-toast]', { hasText: 'Couldn’t start run' })).toHaveCount(0)
    await expect(page.locator('.vue-flow__node .ring-red-500')).toHaveCount(0)

    // ── History: poll until the run completes with a video output ──────────
    interface HistoryFile { filename: string; subfolder?: string; type?: string }
    let videoFile: HistoryFile | null = null
    await expect.poll(async () => {
      const res = await page.request.get('/history').catch(() => null)
      if (!res?.ok()) return 'pending'
      const history = await res.json() as Record<string, any>
      for (const entry of Object.values(history)) {
        if (!entry?.status?.completed) continue
        for (const out of Object.values((entry.outputs ?? {}) as Record<string, any>)) {
          for (const files of Object.values(out as Record<string, any>)) {
            if (!Array.isArray(files)) continue
            for (const f of files) {
              // Specifically THIS run's SaveVideo artifact (unique prefix in
              // the video/ subfolder). The Timeline node ALSO emits its own
              // preview .mp4 at the output root — that one doesn't count.
              if (typeof f?.filename === 'string' && f.filename.startsWith(runTag)
                && f.filename.endsWith('.mp4') && f.subfolder === 'video' && !baseline.has(f.filename)) {
                videoFile = f
                return 'done'
              }
            }
          }
        }
      }
      return 'pending'
    }, { timeout: 180_000, intervals: [2000, 3000, 5000] }).toBe('done')

    expect(videoFile).not.toBeNull()
    const vf = videoFile! as HistoryFile

    // ── The artifact: a FRESH file in output/video/ with more than 1 frame ──
    expect(vf.subfolder).toBe('video')
    const onDisk = path.join(outputVideoDir, vf.filename)
    expect(existsSync(onDisk), `expected ${onDisk} on disk`).toBe(true)
    const size = statSync(onDisk).size
    expect(size).toBeGreaterThan(1_000)
    expect(statSync(onDisk).mtimeMs).toBeGreaterThan(runStarted - 1_000)

    // Frame count > 1, proven by decoding the served file in the browser:
    // duration at the Timeline's 30fps default must exceed one frame.
    const params = new URLSearchParams({ filename: vf.filename, subfolder: vf.subfolder ?? '', type: vf.type ?? 'output' })
    const duration = await page.evaluate(async (src) => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.src = src
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () => resolve()
        v.onerror = () => reject(new Error('video failed to load'))
        setTimeout(() => reject(new Error('metadata timeout')), 15_000)
      })
      return v.duration
    }, `/view?${params}`)
    expect(duration).toBeGreaterThan(2 / 30) // strictly more than one frame
  })
})
