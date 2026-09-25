import { Page, expect } from '@playwright/test'

/**
 * Set a StudioSlider (the shared studio-row control) to an exact value by its
 * data-testid. The row is not a native `<input type=range>`, so `.fill()` does
 * not work: clicking the value readout (`[data-row-value]`) opens a typed-entry
 * `<input>`; we fill it and commit with Enter.
 */
export async function setStudioRow(page: Page, testid: string, value: number | string) {
  const row = page.locator(`[data-testid="${testid}"]`)
  await row.locator('[data-row-value]').click()
  const input = row.locator('input')
  await input.fill(String(value))
  await input.press('Enter')
}

/**
 * Fresh blank projects pop the "What do you want to make?" StartProjectModal
 * (StartProjectModal.vue), which covers the canvas (z-100). Every exit path —
 * a pick, "Start with an empty Frame", the close button or Esc — now leaves a
 * Frame (Compositor) node on the canvas; there is no more "skip to a bare
 * canvas" option. Tests written against a bare canvas after skipping still
 * need one, so this clicks the empty-Frame button, waits for the starter Frame
 * it leaves behind, and removes it.
 *
 * The Frame is built from the cached /object_info, but on a cold page that
 * schema may still be downloading (multi-MB, seconds under load), so wait for
 * it generously rather than for a fixed few seconds: returning before it lands
 * hands the spec a canvas the Frame will drop into later. Waits for the
 * backend first (see waitForBackend). Returns once the canvas is empty again.
 */
export async function dismissStartModal(page: Page) {
  const emptyFrame = page.getByTestId('start-empty-frame')
  if (!(await emptyFrame.isVisible({ timeout: 2_000 }).catch(() => false))) return
  // The Frame is built from /object_info (Compositor); with no schema the build
  // toasts and lands nothing. Every caller gets the backend, not just those that
  // remembered waitForBackend.
  await waitForBackend(page)
  await emptyFrame.click()
  await emptyFrame.waitFor({ state: 'hidden', timeout: 5_000 })
  const frame = page.locator('.vue-flow__node-artifact-frame')
  await frame.first().waitFor({ state: 'attached', timeout: 20_000 })
  await frame.first().click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.vue-flow__node')).toHaveCount(0)
}

/**
 * Open the home page and switch to a blank workflow so VueNodeCanvas is mounted.
 * The canvas listens for `sailor:openTimeline` and `sailor:openSmartLayout`
 * custom events to launch the respective full-screen editors.
 *
 * The VueFlow node canvas only mounts when the localStorage feature flag
 * `sailor:Comfy.VueNodes.Enabled` is set to 'true'. Playwright starts
 * fresh, so we seed it before navigation.
 */
export async function openBlankWorkflow(page: Page) {
  // SSR renders with `vueNodesEnabled = false` because localStorage isn't
  // available server-side. The composable updates the ref on first client-
  // side call but a race against the layout's v-if leaves the legacy iframe
  // mounted on first navigation. Cleanest fix: seed localStorage, then reload.
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Comfy.VueNodes.Enabled', 'true') } catch {}
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.reload()
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: /^Start a blank project$/ }).click()
  await page.locator('.vue-flow').first().waitFor({ state: 'visible', timeout: 20_000 })

  await dismissStartModal(page)
}

/** The timeline editor's full-screen overlay. Several modals share the
 *  `.fixed.inset-0.z-[100]` shell (intent picker, pose editor, …), so scope
 *  by the editor's header text to stay unambiguous in strict mode. */
export function timelineEditorOverlay(page: Page) {
  return page.locator('.fixed.inset-0.z-\\[100\\]').filter({ hasText: 'Timeline Editor' })
}

/** Wait for the timeline editor overlay to appear. */
export async function openTimelineEditor(page: Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('sailor:openTimeline', { detail: { nodeId: 'pw-fake' } })),
  )
  await timelineEditorOverlay(page).waitFor({ state: 'visible', timeout: 10_000 })
}

/** Wait for the SmartLayout editor overlay to appear (uses its own modal). */
export async function openSmartLayoutEditor(page: Page, nodeId: string) {
  await page.evaluate((id) =>
    window.dispatchEvent(new CustomEvent('sailor:openSmartLayout', { detail: { nodeId: id } })),
    nodeId,
  )
}

/**
 * Add a node to the canvas. Bypasses the synthetic HTML5 DnD path (whose
 * DataTransfer doesn't survive `dispatchEvent`) by using the existing
 * `sailor:addNode` custom event that VueNodeCanvas listens for.
 */
export async function dropNode(page: Page, nodeType: string) {
  await page.evaluate((type) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: type } }))
  }, nodeType)
  // The node renders on the next render tick.
  await page.waitForTimeout(300)
}

/** Wait for ComfyUI's /object_info to respond — proves the backend is ready. */
export async function waitForBackend(page: Page) {
  await expect.poll(async () => {
    const r = await page.request.get('/object_info').catch(() => null)
    return r?.status() ?? 0
  }, { timeout: 60_000, intervals: [1000, 2000, 3000] }).toBe(200)
}

/**
 * A settled data-URL snapshot of the Compositor's stack canvas.
 *
 * The stack redraws off a watcher and headless Chromium paints Canvas 2D in software, so a
 * single fixed delay is a guess. Read until two reads a beat apart agree instead: that is a
 * longer wait, never a looser assertion.
 *
 * Shared, not copied: the effect-stack suite and the stroke-stack suite both compare a
 * legacy-shaped layer against the new shape pixel for pixel, and two copies of a settle
 * loop is two places for "settled" to quietly come to mean different things.
 */
export async function stackPixels(page: Page): Promise<string> {
  const read = () => page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    return cv ? cv.toDataURL() : ''
  })
  let prev = await read()
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(250)
    const cur = await read()
    if (cur && cur === prev) return cur
    prev = cur
  }
  return prev
}

/** Open a blank project, drop a Compositor node and open its modal, then wait until the
 *  stack canvas AND the `__compositorSetLayers` seeding hook are both live. */
export async function openCompositor(page: Page): Promise<void> {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  await dropNode(page, 'Compositor')
  const nodeId = await page.locator('.vue-flow__node').first().getAttribute('data-id')
  expect(nodeId).toBeTruthy()
  await page.evaluate((id) =>
    window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), nodeId)
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 10_000 })
  await expect.poll(() => page.evaluate(() => typeof (window as any).__compositorSetLayers === 'function'),
    { timeout: 10_000 }).toBe(true)
}
