import { test, expect, type Page } from '@playwright/test'
import { dropNode, waitForBackend } from './_helpers'

/**
 * The ambientCG texture picker row — end-to-end.
 *
 * What this proves that a component test cannot: picking a tile actually calls the
 * server's fetch route (which downloads and unpacks the 1K set) BEFORE the id is
 * written to the material. So the assertion is two-part — the row shows a thumbnail,
 * AND a 200 came back from /api/scene3d/textures/fetch. A row that lit up without
 * that response would be the exact silent-fallback failure this ordering exists to
 * prevent: an id on the document with no maps on disk.
 */

/**
 * A local variant of tests/_helpers.ts's openBlankWorkflow that does NOT wait for
 * 'networkidle'. Against the live backend this suite runs against (a real ComfyUI at
 * 127.0.0.1:8188), the app polls /system_stats continuously, so 'networkidle' never
 * fires and the shared helper times out before it reaches the "Start a blank project"
 * button. Copied from tests/scene3d-grouping.spec.ts, which documents the same
 * constraint — kept local rather than patched into the shared helper because other
 * specs already depend on that helper's exact behaviour.
 */
async function openBlankWorkflow(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Comfy.VueNodes.Enabled', 'true') } catch {}
  })
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  const vueFlow = page.locator('.vue-flow').first()
  if (!(await vueFlow.isVisible({ timeout: 3_000 }).catch(() => false))) {
    // The new project tab boots a whole embedded ComfyUI iframe before the canvas
    // mounts, and the first click occasionally doesn't take — hence the retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: /Start a blank project/i }).first().click()
      const ok = await vueFlow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
      if (ok) break
      if (attempt === 2) throw new Error('openBlankWorkflow: .vue-flow never appeared after 3 attempts')
    }
  }

  const skipStartModal = page.getByRole('button', { name: /Skip — start with a blank canvas/i })
  if (await skipStartModal.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skipStartModal.click()
    await skipStartModal.waitFor({ state: 'hidden', timeout: 5_000 })
  }
}

/** Blank project → a Scene3DStudio node → its studio open → one Box, selected. */
async function openScene3DStudioWithBox(page: Page) {
  await waitForBackend(page)
  await openBlankWorkflow(page)
  // Taller than the config default: at 1000px the fresh node's Edit/Render footer
  // lands behind the fixed chat bar, which eats the click.
  await page.setViewportSize({ width: 1600, height: 1300 })

  await dropNode(page, 'Scene3DStudio')
  // The node's own Edit button dispatches `sailor:openScene3DStudio`.
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('3D Studio', { exact: true })).toBeVisible({ timeout: 15_000 })

  const toolbar = page.locator('[data-prim-menu]')
  await toolbar.getByTestId('prim-menu-toggle').click()
  await toolbar.getByTestId('prim-menu').getByRole('button', { name: 'Box', exact: true }).click()
  const box = page.locator('[data-testid="object-row"][data-object-name="Box"]')
  await expect(box).toHaveCount(1)
  await box.click()
  await expect(box).toHaveClass(/bg-white\/15/)
}

test('pick a wood texture from the panel', async ({ page }) => {
  await openScene3DStudioWithBox(page)

  const fetches: number[] = []
  page.on('response', (r) => { if (r.url().includes('/api/scene3d/textures/fetch')) fetches.push(r.status()) })

  await page.getByTestId('texture-picker-row').click()
  await page.getByTestId('texture-picker-search').fill('wood')
  const grid = page.getByTestId('texture-picker-grid')
  await expect(grid.locator('button').first()).toBeVisible()
  await grid.locator('button').first().click()

  // The row only shows a thumbnail once the id has been written, which the picker
  // does only after the fetch resolves.
  await expect(page.getByTestId('texture-picker-thumb')).toBeVisible({ timeout: 30_000 })
  expect(fetches).toContain(200)
})
