import { test, expect, type Page } from '@playwright/test'
import { dropNode, waitForBackend } from './_helpers'

/**
 * The "graceful fallback hides an integration failure" rule (memory
 * graceful-fallback-hides-integration-failure): the picker spec
 * (scene3d-texture-picker.spec.ts) only proves the picker row lit up with a
 * thumbnail after a 200 came back from the fetch route. It does NOT prove the
 * texture actually reached the rendered surface — a material that silently
 * kept its old maps while the id on the document changed would still pass
 * that test. This spec closes that gap: it hashes the 3D canvas before and
 * after picking a texture and asserts the pixels actually changed.
 */

/**
 * A local variant of tests/_helpers.ts's openBlankWorkflow that does NOT wait for
 * 'networkidle'. Against the live backend this suite runs against (a real ComfyUI at
 * 127.0.0.1:8188), the app polls /system_stats continuously, so 'networkidle' never
 * fires and the shared helper times out before it reaches the "Start a blank project"
 * button. Copied from tests/scene3d-texture-picker.spec.ts (itself copied from
 * tests/scene3d-grouping.spec.ts) — kept local rather than hoisted into a shared
 * helpers/scene3d module, per the same specs' precedent.
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

/**
 * Downscale the live WebGL canvas onto a small 2D canvas and read it back as a
 * data URL. The engine's renderer is created with `preserveDrawingBuffer: true`
 * (frontend/app/lib/scene3d/engine.ts), so the backbuffer is still readable via
 * drawImage after the frame has been presented — no forced-render hook needed.
 */
async function canvasHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[data-scene3d]') as HTMLCanvasElement | null
      ?? document.querySelector('canvas') as HTMLCanvasElement
    const off = document.createElement('canvas'); off.width = 64; off.height = 64
    off.getContext('2d')!.drawImage(c, 0, 0, 64, 64)
    return off.toDataURL()
  })
}

/**
 * Sample a handful of pixels from the live canvas and report whether they are
 * all pure black. Guards against the exact failure mode this spec exists to
 * catch: two blank/black captures would trivially satisfy "the hashes differ
 * from each other" as false, but they'd ALSO trivially satisfy "the hashes
 * are equal" if the capture pipeline is broken in a way that always returns
 * the same black frame — either way a black capture proves nothing about the
 * texture, so it's asserted against directly rather than left to the diff.
 */
async function isBlankBlack(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[data-scene3d]') as HTMLCanvasElement | null
      ?? document.querySelector('canvas') as HTMLCanvasElement
    const off = document.createElement('canvas'); off.width = 32; off.height = 32
    const ctx = off.getContext('2d')!
    ctx.drawImage(c, 0, 0, 32, 32)
    const { data } = ctx.getImageData(0, 0, 32, 32)
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return false
    }
    return true
  })
}

test('a textured box renders differently from a plain one', async ({ page }) => {
  await openScene3DStudioWithBox(page)
  await page.waitForTimeout(500)
  const plain = await canvasHash(page)
  expect(await isBlankBlack(page), 'plain capture must not be a blank black frame').toBe(false)

  // This spec's own premise, asserted rather than assumed: the poll-until-differ
  // loop below only proves a texture reached the pixels if an UNCHANGED scene
  // renders identically frame to frame. Today it does — the default post stack
  // has grain off and nothing else animates — but a future time-varying default
  // (animated grain, a drifting env, a subtle idle rotation) would make the loop
  // succeed on its very first iteration and the spec would pass without a single
  // texel ever being bound. Two captures a few hundred ms apart, before anything
  // is picked, catch that: if they differ, the diff below means nothing and this
  // guard fails loudly instead of the real assertion passing for free.
  await page.waitForTimeout(400)
  expect(await canvasHash(page), 'an unpicked scene must render identically frame to frame — otherwise the diff below proves nothing').toBe(plain)

  // The picker's search splits on whitespace and requires every word to match
  // the set's name/category/tags (TexturePicker.vue's `filtered`); ambientCG's
  // catalog names this set "Wood 095" (a space, not "Wood095"), and its tags
  // carry the number separately ("095"). "wood 095" is the query that uniquely
  // resolves to this one set — confirmed against the live catalog endpoint.
  await page.getByTestId('texture-picker-row').click()
  await page.getByTestId('texture-picker-search').fill('wood 095')
  await page.getByTestId('texture-picker-grid').locator('button').first().click()
  await expect(page.getByTestId('texture-picker-thumb')).toBeVisible({ timeout: 15_000 })

  // Wait for the maps to decode and the material to flip needsUpdate, polling
  // for the hash to actually change rather than sleeping a fixed amount — the
  // machine this runs on can be heavily loaded. Ceiling matches the brief's
  // fallback guidance (15s) plus the 1.5s the brief's fixed wait used.
  let textured = plain
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    textured = await canvasHash(page)
    if (textured !== plain) break
    await page.waitForTimeout(250)
  }

  expect(await isBlankBlack(page), 'textured capture must not be a blank black frame').toBe(false)
  expect(textured).not.toBe(plain)
})
