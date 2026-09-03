import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { waitForBackend } from './_helpers'

/**
 * A generative catalog effect used as a Frame layer fill must paint the FIELD on the
 * Frame card, not the shader spec's fallback input gradient. Graceful fallback makes a
 * plausible-looking image worthless as evidence, so the assertion is a pixel diff
 * against the same layer painted with that very gradient: if the field ran, the two
 * cards differ; if it fell back, they are identical.
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
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: /Start a blank project/i }).first().click()
      const ok = await vueFlow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
      if (ok) break
      if (attempt === 2) throw new Error('openBlankWorkflow: .vue-flow never appeared after 3 attempts')
    }
  }
  const skip = page.getByRole('button', { name: /Skip — start with a blank canvas/i })
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skip.click()
    await skip.waitFor({ state: 'hidden', timeout: 5_000 })
  }
  // When a project auto-resumes (the branch above's "already visible" case),
  // its own async workflow-restore fetch can still be in flight — and it
  // REPLACES the entire node list wholesale once it lands. Observed directly:
  // sailor:addNode-ed nodes landed, then vanished, because the restore's
  // `nodes.value = ...` overwrite ran after our dispatch. Wait for the node
  // count to stop changing across two checks before touching the graph, so
  // we never race that overwrite.
  let prevCount = -1
  for (let i = 0; i < 20; i++) {
    const count = await page.locator('.vue-flow__node').count()
    if (count === prevCount) break
    prevCount = count
    await page.waitForTimeout(300)
  }
}

async function addFrame(page: Page, id: string, fill: unknown) {
  await page.evaluate(({ id, fill }) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', {
      detail: {
        nodeType: 'Compositor',
        propertyOverrides: {
          sailor_localLayers: [{
            id, kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.9, h: 0.9, radius: 0,
            fill, stroke: '', strokeWidth: 0,
          }],
        },
      },
    }))
  }, { id, fill })
  await page.waitForTimeout(500)
}

const GRADIENT = { type: 'gradient', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
const SHADER = {
  type: 'shader', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8,
  shader: { effectId: 'terrain_bands', params: {}, anchor: 'object', speed: 0, input: GRADIENT },
}

function diffCount(a: PNG, b: PNG, tol = 12): number {
  let n = 0
  for (let i = 0; i < Math.min(a.data.length, b.data.length); i += 4 * 23) {
    if (Math.abs(a.data[i]! - b.data[i]!) > tol) n++
  }
  return n
}

test('terrain_bands as a Frame layer fill paints the field, not the fallback gradient', async ({ page }) => {
  // This dev instance's backend (ComfyUI on :8188) is shared with other,
  // concurrently-running sessions' frontends — a single slow/contended attempt
  // inside the setup retry loop below can already approach the default 60s
  // test timeout on its own, leaving no room for the retry it's there for.
  // Give the whole test more headroom rather than shrinking the retry.
  test.setTimeout(120_000)
  await waitForBackend(page)
  await page.setViewportSize({ width: 1600, height: 2000 })

  const canvases = page.locator('[data-testid="frame-card-stack-canvas"]')

  // This dev instance auto-resumes an existing project on load, and that
  // resume's own async workflow-restore fetch can still be in flight when we
  // dispatch sailor:addNode — landing after us and replacing the whole node
  // list wholesale, which silently discards whatever we just added (confirmed
  // via a debug run: node count went 0 -> non-zero -> 0 again, alongside a 404
  // from the project-restore fetch racing a concurrently-run session on the
  // same shared ComfyUI backend). openBlankWorkflow's own stability-wait
  // (below) closes most of that window, but not all of it, so retry the whole
  // "fresh navigation, add both frames" sequence from scratch on a miss rather
  // than patching in extra dispatches — a partial retry risks leaving stray
  // duplicate Compositor nodes behind and breaking the exact-2 count this
  // assertion depends on. Each attempt starts from a fresh nodes.value (a new
  // navigation), so there is no accumulation to worry about.
  let ready = false
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    try {
      await openBlankWorkflow(page)
      await addFrame(page, 'll-gen-shader', SHADER)
      await addFrame(page, 'll-gen-gradient', GRADIENT)
      ready = await canvases.count().then((n) => n === 2)
    } catch (err) {
      // A transient UI hiccup mid-attempt (e.g. the "Start a blank project"
      // button losing visibility while another concurrently-running session
      // churns the same shared ComfyUI backend's project state) must not abort
      // the whole test — it's exactly what this retry exists to ride out.
      console.warn(`[frame-generative-fill] setup attempt ${attempt} threw:`, err)
    }
    if (!ready) await page.waitForTimeout(1_000)
  }
  await expect(canvases).toHaveCount(2, { timeout: 10_000 })
  // Let the catalog fetch land and the static repaint run.
  await page.waitForTimeout(2_500)

  const shaderShot = PNG.sync.read(await canvases.nth(0).screenshot())
  const gradientShot = PNG.sync.read(await canvases.nth(1).screenshot())
  expect(shaderShot.width).toBe(gradientShot.width)
  expect(shaderShot.height).toBe(gradientShot.height)

  // The load-bearing check: a fallback would render the same gradient on both cards.
  expect(diffCount(shaderShot, gradientShot)).toBeGreaterThan(40)
})
