import { expect, test, type Page } from '@playwright/test'
import { waitForBackend } from './_helpers'

/**
 * Start modal — the blank-project rewrite (spec 2026-09-23). Two equal
 * halves ("Make it with AI" / "Make it by hand"), a real picture or live
 * still on every tile, and no more "skip to a bare canvas": every exit path
 * — a tile pick, "Start with an empty Frame", the close button, Esc, or a
 * backdrop click — lands a Frame (Compositor) node. Skipping leaves exactly
 * one, empty. Video is deliberately left unwired (the Frame has no video
 * input), so it's the one pick that lands 2 nodes with 0 edges.
 *
 * NOTE: openBlankWorkflow() from _helpers now dismisses this modal itself,
 * so these tests reimplement the open WITHOUT dismissing it, to interact
 * with the modal directly.
 */
async function openToModal(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Comfy.VueNodes.Enabled', 'true') } catch {}
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /^Start a blank project$/ }).click()
  await page.locator('.vue-flow').first().waitFor({ state: 'visible', timeout: 20_000 })
  await expect(page.getByText('What do you want to make?')).toBeVisible({ timeout: 5_000 })
}

/** The build waits for the tab's own load, which waits on /object_info (multi-MB;
 *  over 10 s on this machine under parallel-session load), so polls allow 30 s.
 *
 *  Wait for the canvas node count to settle: the canvas finishes loading its
 *  empty workflow asynchronously after mount and can wipe/replace `nodes`
 *  once that lands (see dropNodeAndWait's comment in port-intent.spec.ts), so
 *  a single read right after a pick can catch a value mid-flight. */
async function settledNodeCount(page: Page): Promise<number> {
  const nodes = page.locator('.vue-flow__node')
  let prev = -1
  for (let i = 0; i < 20; i++) {
    const count = await nodes.count()
    if (count === prev) return count
    prev = count
    await page.waitForTimeout(300)
  }
  return prev
}

test.describe('Start modal — the blank-project rewrite', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBackend(page)
    await openToModal(page)
  })

  test('shows both halves with the right tile counts, and no retired studios', async ({ page }) => {
    const ai = page.getByTestId('start-ai')
    const hand = page.getByTestId('start-hand')
    await expect(ai).toBeVisible()
    await expect(hand).toBeVisible()

    const aiIds = ['gen', 'style', 'edit', 'upscale', 'video']
    for (const id of aiIds) {
      await expect(page.getByTestId(`start-tile-${id}`)).toBeVisible()
    }
    expect(aiIds.length).toBe(5)

    const handIds = ['expressive', 'gradient', 'shader', 'pattern', 'shape', 'vectortype', 'scene3d', 'moodboard']
    let visibleHandCount = 0
    for (const id of handIds) {
      // 'expressive' (Space Type) is gated by a feature flag and may not render.
      if (await page.getByTestId(`start-tile-${id}`).isVisible().catch(() => false)) visibleHandCount++
    }
    expect(visibleHandCount).toBeGreaterThanOrEqual(7)

    // Retired: audio (speech, music, lip sync), Shot Director, and "Generate
    // a 3D model" are no longer on the modal.
    for (const gone of ['Shot Director', 'Lip-Sync', 'Generate music', 'Generate speech', 'Sync lips', 'Generate a 3D model']) {
      await expect(page.getByText(gone, { exact: false })).toHaveCount(0)
    }
  })

  test('picking Gradient closes the modal and lands a 2-node, 1-edge graph', async ({ page }) => {
    await page.getByTestId('start-tile-gradient').click()
    await expect(page.getByText('What do you want to make?')).toHaveCount(0)
    await expect.poll(() => settledNodeCount(page), { timeout: 30_000 }).toBe(2)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  })

  test('"Start with an empty Frame" leaves exactly one Frame and no edges', async ({ page }) => {
    await page.getByTestId('start-empty-frame').click()
    await expect(page.getByText('What do you want to make?')).toHaveCount(0)
    await expect.poll(() => settledNodeCount(page), { timeout: 30_000 }).toBe(1)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
  })

  test('Esc does the same as "Start with an empty Frame"', async ({ page }) => {
    await page.keyboard.press('Escape')
    await expect(page.getByText('What do you want to make?')).toHaveCount(0)
    await expect.poll(() => settledNodeCount(page), { timeout: 30_000 }).toBe(1)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
  })

  test('picking "Generate a video" lands 2 nodes but leaves it unwired', async ({ page }) => {
    await page.getByTestId('start-tile-video').click()
    await expect(page.getByText('What do you want to make?')).toHaveCount(0)
    await expect.poll(() => settledNodeCount(page), { timeout: 30_000 }).toBe(2)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
  })

  test('a build that lands after the modal closed stays clear of the user\'s node and leaves its selection', async ({ page }) => {
    // Shader waits on its starter-picture upload before it builds. Hold that
    // upload so the build lands well after the modal has closed, the way a
    // slow /object_info used to hold every pick.
    let released = false
    await page.route('**/upload/image', async (route) => {
      await new Promise(r => setTimeout(r, 4_000))
      released = true
      await route.continue()
    })
    page.on('filechooser', async () => { /* the Audio card body is a file button */ })

    await page.getByTestId('start-tile-shader').click()
    await expect(page.getByText('What do you want to make?')).toHaveCount(0)

    // Meanwhile the user places a node and selects it.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'Audio' } })))
    const mine = page.locator('.vue-flow__node-artifact-audio')
    await expect(mine).toBeVisible()
    const box = (await mine.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(mine).toHaveClass(/\bselected\b/)
    expect(released).toBe(false) // the build really is still pending

    // The build lands: Image → Shader → Frame, wired as before.
    const frame = page.locator('.vue-flow__node-artifact-frame')
    await expect(frame).toHaveCount(1, { timeout: 20_000 })
    await expect.poll(() => settledNodeCount(page), { timeout: 30_000 }).toBe(4)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(2)

    // The user's node keeps the selection, and the view did not move off it.
    await expect(mine).toHaveClass(/\bselected\b/)
    await expect(page.locator('.vue-flow__node.selected')).toHaveCount(1)
    const after = (await mine.boundingBox())!
    expect(Math.round(after.x)).toBe(Math.round(box.x))
    expect(Math.round(after.y)).toBe(Math.round(box.y))

    // No starter node overlaps it (graph positions, not screen boxes, so it
    // holds even for nodes scrolled out of view).
    const overlaps = await page.evaluate(() => {
      const rect = (el: Element) => {
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((el as HTMLElement).style.transform)!
        const r = (el as HTMLElement).getBoundingClientRect()
        const zoom = r.width / (el as HTMLElement).offsetWidth || 1
        return { x: +m[1]!, y: +m[2]!, w: r.width / zoom, h: r.height / zoom }
      }
      const all = [...document.querySelectorAll('.vue-flow__node')]
      const me = all.find(el => el.classList.contains('vue-flow__node-artifact-audio'))!
      const a = rect(me)
      return all.filter(el => el !== me).map(rect)
        .filter(b => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).length
    })
    expect(overlaps).toBe(0)
  })
})
