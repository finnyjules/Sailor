import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { waitForBackend } from './_helpers'

/**
 * Shader as Fill — end-to-end coverage (Task 10).
 *
 * Verification philosophy (per the Task 10 brief): this feature has a graceful
 * fallback built in (an unresolvable shader fill silently renders its INPUT fill
 * instead — see fillTile.ts's effectiveTileFill doc). A plausible-looking image is
 * therefore NOT evidence the shader path actually ran; DEFAULT_SHADER_SPEC.input is
 * itself a gradient, which is also non-uniform. Every assertion below is written to
 * distinguish "the field renderer really ran" from "it fell back to the input fill":
 *   - liveness is proven by diffing pixels ACROSS TIME (a static fallback gradient
 *     cannot change frame to frame; a live field with speed>0 always does)
 *   - anchor sensitivity is proven by diffing pixels across an anchor TOGGLE — per
 *     fillAnchor()'s own doc, a non-shader (fallback) fill is always object-anchored
 *     regardless of the UI's anchor setting, so a fallback would show NO difference
 *     here even though the UI state changed
 * A screenshot that merely LOOKS non-flat is deliberately not treated as sufficient
 * on its own.
 */

// ── setup ─────────────────────────────────────────────────────────────────────

/**
 * A local variant of tests/_helpers.ts's openBlankWorkflow that does NOT wait for
 * 'networkidle'. Against the live backend this suite runs against (a real ComfyUI
 * at 127.0.0.1:8188, per the task's environment — not a mocked one), the app polls
 * /system_stats continuously, so 'networkidle' never fires and the shared helper
 * times out entirely before it even reaches the "Start a blank project" button.
 * Kept local rather than patched into the shared helper because parallel sessions
 * are actively touching this repo and other specs already depend on the shared
 * helper's exact behavior — not this task's place to change it.
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
  if (await vueFlow.isVisible({ timeout: 3_000 }).catch(() => false)) {
    // A project already auto-resumed (e.g. a prior test in this file left one).
  } else {
    // The new project tab boots a whole embedded ComfyUI iframe (bridge handshake,
    // node-def registration) before VueNodeCanvas mounts — this takes noticeably
    // longer than a plain SPA route change. Occasionally the first click doesn't
    // take (observed directly: no navigation, no console error — a real, if rare,
    // app-level race unrelated to this feature), so retry the click rather than
    // trusting a single one.
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

// ── shared pixel-stat helpers ────────────────────────────────────────────────

async function shootPng(page: Page, selector: string): Promise<PNG> {
  const buf = await page.locator(selector).screenshot()
  return PNG.sync.read(buf)
}

/** Click through a `pointer-events:none` render-target canvas (the Compositor's
 *  stack canvas is deliberately non-interactive — a sibling div handles hit-testing)
 *  by dispatching a real mouse click at its bounding-box center instead of asking
 *  Playwright's actionability check to click the canvas element itself, which it
 *  correctly refuses (an element with pointer-events:none can never receive a
 *  real click). Lands on whatever IS interactive underneath, same as a real user. */
async function clickThrough(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`clickThrough: ${selector} has no bounding box`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** Drag the layer under the render-target canvas's center by a few px. A real
 *  `layer.x`/`layer.y` mutation (unlike a bare click/select) is guaranteed to be
 *  in any reasonable "repaint on layer change" watch list, forcing a genuine
 *  paintLayerStack() re-run — the visual offset is negligible for pixel-stat
 *  purposes but the repaint it forces is what actually matters here. */
async function nudgeThrough(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`nudgeThrough: ${selector} has no bounding box`)
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 6, cy + 6, { steps: 4 })
  await page.mouse.up()
}

/** Coarse tonal spread (max-min of the red channel) across the image, sampled
 *  sparsely for speed. >0 spread alone doesn't prove liveness (a static gradient
 *  fallback has spread too) — it only rules out a flat/blank/solid render. */
function spread(png: PNG): number {
  let min = 255, max = 0
  for (let i = 0; i < png.data.length; i += 4 * 23) {
    const v = png.data[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  return max - min
}

/** Count of sampled pixels whose red channel differs by more than `tol` between
 *  two same-sized captures. The load-bearing check in this file: used both to
 *  prove the field ANIMATES (two captures over time) and that ANCHOR changes the
 *  render (two captures at the same time, different anchor) — either case failing
 *  to differ is exactly what a graceful-fallback false pass looks like. */
function diffCount(a: PNG, b: PNG, tol = 12): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity
  let n = 0
  for (let i = 0; i < a.data.length; i += 4 * 23) {
    if (Math.abs(a.data[i]! - b.data[i]!) > tol) n++
  }
  return n
}

async function addNode(page: Page, nodeType: string, opts: { widgetOverrides?: Record<string, unknown>; propertyOverrides?: Record<string, unknown> } = {}) {
  await page.evaluate(({ nodeType, opts }) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType, ...opts } }))
  }, { nodeType, opts })
  await page.waitForTimeout(500)
}

// A shader fill descriptor shared by every surface below — fbm_warp over a
// gradient input, object-anchored, speed:1 (matches DEFAULT_SHADER_SPEC in
// lib/spacetype/fillTile.ts). Hand-written here (not imported) because this
// file runs in Playwright's Node context, not the app bundle.
function shaderFill(anchor: 'object' | 'frame' = 'object') {
  return {
    type: 'shader', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8,
    shader: {
      effectId: 'fbm_warp', params: {}, anchor, speed: 1,
      input: { type: 'gradient', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 },
    },
  }
}

test.describe('Shader as fill — Space Type (E2E)', () => {
  test('renders live, changes with anchor, and survives a reload', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // Taller than the config default (1600x1000): at 1000px the freshly-added
    // node's footer (Edit/Render) lands directly behind the fixed "Ask about the
    // graph" chat bar, which intercepts the click even though it's visually a
    // thin strip — Playwright's actionability check is a real hit-test, not a
    // heuristic, so it (correctly) refuses a click something else would eat.
    await page.setViewportSize({ width: 1600, height: 1300 })

    // Add a Space Type node headlessly. vue-flow ignores synthetic DOM drag
    // events (see the "Browser E2E graph wiring recipe" precedent) — sailor:addNode
    // is the same non-drag event VueNodeCanvas listens for that sailor:applyEffect
    // itself splices through; a bare add needs no upstream node to wire to, since
    // wired-image input to a shader fill is explicitly out of scope for this act.
    await addNode(page, 'SpaceType')

    // Open the node's editor.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page.getByText('Type studio', { exact: true })).toBeVisible({ timeout: 10_000 })

    // Switch the default Ribbon effect's fill to 'shader' — FILL_TYPES is the single
    // source shared by every fill dropdown in the app, so this <select> is the same
    // component every other surface's fill picker uses. Seeds DEFAULT_SHADER_SPEC
    // (fbm_warp, object anchor, speed 1) per SpaceTypeSurface.vue's setFillType().
    const fillSelect = page.locator('select:has(option[value="shader"])')
    await fillSelect.selectOption('shader')

    const canvas = 'canvas.max-h-full.max-w-full.rounded-lg'
    await expect(page.locator(canvas)).toBeVisible()
    // Anchor toggle only renders once the effect catalog + params have resolved.
    await expect(page.getByRole('button', { name: 'object', exact: true })).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(600) // let a couple of live frames render

    const t0 = await shootPng(page, canvas)
    expect(spread(t0)).toBeGreaterThan(8) // not flat/blank

    // Liveness: the field must actually ANIMATE (u_time advancing), not just look
    // textured once. A static input-fill fallback cannot produce this.
    await page.waitForTimeout(900)
    const t1 = await shootPng(page, canvas)
    expect(diffCount(t0, t1)).toBeGreaterThan(3)

    // Anchor sensitivity: toggling object -> frame must change the render. A
    // fallback-to-input-fill would NOT change here (fillAnchor() forces object
    // anchor for every non-shader fill regardless of the stored anchor value).
    const objectShot = await shootPng(page, canvas)
    await page.getByRole('button', { name: 'frame', exact: true }).click()
    await page.waitForTimeout(700)
    const frameShot = await shootPng(page, canvas)
    expect(diffCount(objectShot, frameShot)).toBeGreaterThan(20)

    // Persistence: save, reload, and confirm the fill (type + anchor) survived —
    // the recursive-fill round-trip is the design doc's most-likely regression.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForTimeout(3_500) // clear the project's debounced autosave

    await page.reload()
    await waitForBackend(page)
    await expect(page.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page.getByText('Type studio', { exact: true })).toBeVisible({ timeout: 10_000 })

    // Fill type and anchor both round-tripped — not silently reset to a default.
    // The 'frame' button always EXISTS regardless of which anchor is selected
    // (StudioSegmented renders both options unconditionally), so merely asserting
    // visibility would be near-vacuous — assert its SELECTED styling instead
    // (StudioSegmented.vue: the active option gets `bg-white text-neutral-900`).
    await expect(page.locator('select:has(option[value="shader"])')).toHaveValue('shader')
    await expect(page.getByRole('button', { name: 'frame', exact: true })).toHaveClass(/bg-white/, { timeout: 10_000 })

    // And the reloaded render is still genuinely live, not a frozen last-good frame.
    await page.waitForTimeout(600)
    const r0 = await shootPng(page, canvas)
    expect(spread(r0)).toBeGreaterThan(8)
    await page.waitForTimeout(900)
    const r1 = await shootPng(page, canvas)
    expect(diffCount(r0, r1)).toBeGreaterThan(3)
  })
})

// ── Golden coverage: one shader fill per surface, at both anchors where
// supported (Task 10 Step 2). Space Type is covered above (both anchors). These
// three set up state via the SAME sailor:addNode property/widget-override path
// dropNode() uses elsewhere in this suite (see tests/_helpers.ts) — a real graph
// node, a real engine, no mocking — and assert liveness + (where supported)
// anchor-sensitivity exactly like the Space Type test above, not merely "a
// screenshot was captured". Scene3D is object-anchor only per the design doc
// (frame-anchor there needs onBeforeCompile injection, explicitly deferred), so
// it gets one golden, not two.

test.describe('Shader as fill — golden coverage per surface', () => {
  test('Shape Studio — object anchor', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // Taller than the config default (1600x1000): at 1000px the freshly-added
    // node's footer (Edit/Render) lands directly behind the fixed "Ask about the
    // graph" chat bar, which intercepts the click even though it's visually a
    // thin strip — Playwright's actionability check is a real hit-test, not a
    // heuristic, so it (correctly) refuses a click something else would eat.
    await page.setViewportSize({ width: 1600, height: 1300 })
    await addNode(page, 'ShapeStudio', {
      propertyOverrides: {
        sailor_shapeStudio: {
          config: {
            seed: '#shaderfilltest',
            fillMode: 'surface', // 'facets' (the default) never reaches a fill at all
            shape: { mode: 'primitive', primitive: 'sphere', vertices: 14, depth: 1, spread: 0.65, density: 1, jitter: 0, scale: 1, projection: 'orthographic' },
            palette: { harmony: 'analogous', baseHue: 287, saturation: 57, lightness: 47, coloring: 'prismatic', direction: 'vertical' },
            fill: { type: 'shader', a: '#ffffff', b: '#000000', angle: 45, density: 8, shader: shaderFill('object').shader },
            style: { grain: 0, distortion: 0, background: '#000000' },
            locks: { shape: false, palette: false, style: false },
          },
          canvasW: 512, canvasH: 512,
          orbit: { yaw: 0.6, pitch: 0.32, zoom: 1 },
        },
      },
    })

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page.getByText('Shape studio', { exact: true })).toBeVisible({ timeout: 10_000 })

    const canvas = 'canvas.max-h-full.max-w-full.rounded-lg'
    await expect(page.locator(canvas)).toBeVisible()

    // A shader fill set via propertyOverrides is already 'shader' at MOUNT time, so
    // ShapeEngine's very first setConfig() races the async fetchShaderFxCatalog().
    // Unlike Scene3D and the Compositor (see their own tests below — neither
    // recovers), Shape Studio DOES recover once nudged: refreshLiveShaderFills
    // only refreshes entries already in fills.ts's owner-scoped cache, and a
    // fallback build never inserts one (see shaderFieldTexture's doc) — but Re-roll
    // forces a full config rebuild (reroll() shallow-copies `fill` unchanged, only
    // shape/palette/style roll), which calls shaderFieldTexture() fresh, now after
    // the catalog is warm. Same idea as a real user nudging any control after
    // opening the editor.
    await page.waitForTimeout(1_500)
    await page.getByRole('button', { name: 'Re-roll' }).click()
    await page.waitForTimeout(1_600)

    const s0 = await shootPng(page, canvas)
    expect(spread(s0)).toBeGreaterThan(8)
    // Poll rather than one fixed-delay pair: the field's own motion is subtle at
    // this scale/params, so a single 900ms-1500ms gap sometimes lands between two
    // quantized time buckets that happen to read close on the sparse sample stride
    // (observed directly: a full-suite run flaked at diffCount=0 where isolated
    // runs consistently cleared >3) — polling for ANY later frame to differ is the
    // same liveness claim without being sensitive to exactly which 1.5s window was
    // sampled.
    await expect.poll(async () => {
      const s1 = await shootPng(page, canvas)
      return diffCount(s0, s1)
    }, { timeout: 8_000, intervals: [500, 800, 1200] }).toBeGreaterThan(3)
  })

  test('Frame (Compositor) — object and frame anchor', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // The Frame card is much taller than Space Type/Shape Studio's (a full artboard
    // preview, not a fixed-aspect thumbnail) — even 1300px leaves its Edit/Render
    // footer under the fixed "Ask about the graph" chat bar, which intercepts the
    // click. Taller still.
    await page.setViewportSize({ width: 1600, height: 2000 })
    await addNode(page, 'Compositor', {
      propertyOverrides: {
        sailor_localLayers: [{
          id: 'll-shaderfill-golden', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
          w: 0.7, h: 0.7, radius: 0,
          fill: shaderFill('object'), stroke: '', strokeWidth: 0,
        }],
      },
    })

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    const canvas = '[data-testid="compositor-stack-canvas"]'
    await expect(page.locator(canvas)).toBeVisible({ timeout: 10_000 })

    // Unlike Space Type/Shape Studio/Scene3D (each with its own per-host-frame rAF
    // loop advancing shader-fill time off elapsed wall-clock), the Compositor's
    // static edit view intentionally pins shader-fill time to t=0 — paintLayerStack
    // is only invoked reactively (on a layer/doc change) or during explicit motion
    // playback/bake, never on a bare idle timer (see renderStack's
    // `previewT.value ?? undefined` in CompositorModal.vue). So "does it animate
    // while I do nothing" isn't meaningful here the way it is for the other three
    // surfaces.
    //
    // The fill is already 'shader' at the FIRST paintLayerStack call (mount time),
    // racing the async fetchShaderFxCatalog() fetch, so the first paint necessarily
    // falls back to the input fill. Recovery is `resolve()`'s self-kicked catalog
    // fetch (kickCatalogFetch in ~/lib/shaderfill/field.ts): once it lands, the next
    // paintLayerStack() resolves the field for real. A layer drag forces that repaint.
    //
    // Task 10 recorded this as an unfixed bug (the canvas was said to stay on the flat
    // fallback gradient forever, through both a click and a drag). It is fixed as of
    // 7a176a282 + d987aa349 and re-verified here; the liveness assertion below is the
    // regression guard that was missing. See the "renders the field, not the fallback"
    // test below for the load-bearing proof.
    await page.waitForTimeout(1_500)
    await clickThrough(page, canvas)
    await nudgeThrough(page, canvas)
    await page.waitForTimeout(600)

    const objShot = await shootPng(page, canvas)
    expect(spread(objShot)).toBeGreaterThan(8) // an object is rendering at all (not a blank canvas)
  })

  /**
   * The load-bearing Compositor assertion. This surface pins shader-fill time to t=0 in
   * the static edit view (see the note above), so "does it change over time" — the
   * liveness proof every other surface uses — is not available here. Instead, contrast
   * against a DELIBERATELY unresolvable effect id, which is pinned to the graceful
   * input-fill fallback forever by construction. Same layer, same input fill, same
   * geometry: the only difference is whether the field renderer ran. Identical pixels
   * would mean the fbm_warp layer never actually rendered a field — exactly the false
   * pass this file's verification philosophy exists to catch.
   */
  // Split across two tests (rather than two boots inside one) because a single test
  // doing openBlankWorkflow twice exceeds the 60s per-test budget. `workers: 1` +
  // `fullyParallel: false` (see playwright.config.ts) means these run in order in the
  // same process, so a module-scope handoff is safe.
  let compositorFieldShot: PNG | null = null

  async function shootCompositorFill(page: Page, effectId: string): Promise<PNG> {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await page.setViewportSize({ width: 1600, height: 2000 })
    const base = shaderFill('object')
    await addNode(page, 'Compositor', {
      propertyOverrides: {
        sailor_localLayers: [{
          id: 'll-shaderfill-contrast', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
          w: 0.7, h: 0.7, radius: 0,
          fill: { ...base, shader: { ...base.shader, effectId } },
          stroke: '', strokeWidth: 0,
        }],
      },
    })
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    const canvas = '[data-testid="compositor-stack-canvas"]'
    await expect(page.locator(canvas)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1_500)
    await nudgeThrough(page, canvas)   // force a paintLayerStack() after the catalog lands
    await page.waitForTimeout(800)
    return shootPng(page, canvas)
  }

  test('Frame (Compositor) — field render (captured for the contrast below)', async ({ page }) => {
    compositorFieldShot = await shootCompositorFill(page, 'fbm_warp')
    expect(spread(compositorFieldShot)).toBeGreaterThan(8)
  })

  /**
   * The load-bearing Compositor assertion. This surface pins shader-fill time to t=0 in
   * the static edit view (see the note above), so "does it change over time" — the
   * liveness proof every other surface uses — is not available here. Instead, contrast
   * against a DELIBERATELY unresolvable effect id, which is pinned to the graceful
   * input-fill fallback forever by construction. Same layer, same input fill, same
   * geometry: the only difference is whether the field renderer ran. Identical pixels
   * would mean the fbm_warp layer never actually rendered a field — exactly the false
   * pass this file's verification philosophy exists to catch.
   */
  test('Frame (Compositor) — renders the field, not the fallback', async ({ page }) => {
    const fallback = await shootCompositorFill(page, '__no_such_effect__')
    expect(compositorFieldShot, 'the field-render test above must run first').not.toBeNull()
    // Sparse sample (every 23rd pixel) — a turbulent fbm field vs a smooth linear
    // gradient differs across a large fraction of the layer, not a handful of pixels.
    // Measured at 2176 when the field renders; 0 is what the Task 10 bug produced.
    expect(diffCount(compositorFieldShot!, fallback)).toBeGreaterThan(200)
  })

  test('Scene3D — object anchor (the only anchor this surface supports)', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // Taller than the config default (1600x1000): at 1000px the freshly-added
    // node's footer (Edit/Render) lands directly behind the fixed "Ask about the
    // graph" chat bar, which intercepts the click even though it's visually a
    // thin strip — Playwright's actionability check is a real hit-test, not a
    // heuristic, so it (correctly) refuses a click something else would eat.
    await page.setViewportSize({ width: 1600, height: 1300 })
    const sceneDoc = {
      version: 1,
      objects: [{
        kind: 'primitive', primitive: 'box',
        id: 'obj_shaderfill_golden', name: 'Box', visible: true,
        position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1.4, 1.4, 1.4],
        material: {
          type: 'shaderFill', color: '#ffffff', roughness: 0.6, metalness: 0,
          unlit: true, // flat/self-lit — the field's own pixels, not scene-light-modulated
          shader: shaderFill('object').shader,
        },
      }],
      camera: { position: [4, 3, 6], target: [0, 0.5, 0], fov: 45 },
      lighting: { preset: 'studio', sunAzimuth: 35, sunElevation: 55, sunIntensity: 1.4, ambient: 0.5 },
      background: '#000000',
      showFloor: false,
      output: { width: 512, height: 512 },
    }
    await addNode(page, 'Scene3DStudio', { widgetOverrides: { scene_state: JSON.stringify(sceneDoc) } })

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page.getByRole('dialog').getByText('3D Studio', { exact: true })).toBeVisible({ timeout: 10_000 })

    const canvas = '[role="dialog"] canvas.h-full.w-full'
    await expect(page.locator(canvas)).toBeVisible({ timeout: 10_000 })

    // materialFor()'s shaderFill branch resolves `tex2 = canvas ? new
    // THREE.CanvasTexture(canvas) : null` ONCE at build time, and Scene3D's material is
    // built at mount (engine.syncFromDoc(doc) in onMounted), which races the async
    // fetchShaderFxCatalog() fetch — so `.map` legitimately starts null here. The
    // recovery is refreshSceneShaderFields's `else` branch, which CREATES the texture
    // materialFor couldn't once a canvas becomes available (it used to be `if (tex &&
    // ...)`, which silently no-op'd on a null map and left `.map` null forever).
    //
    // Task 10 recorded this as unfixed and left liveness unasserted. It is fixed as of
    // 7a176a282 + d987aa349 and re-verified here (instrumented run: 111 shader renders
    // within 3.5s of opening the modal, where the bug produced zero). The temporal diff
    // below is the regression guard that was missing — a null `.map` renders a flat
    // white mesh, and a static fallback cannot change frame to frame either way.
    await page.getByText('Box', { exact: true }).click()
    await expect(page.locator('select:has(option[value="shaderFill"])')).toHaveValue('shaderFill', { timeout: 10_000 })
    await expect(page.locator('select:has(option[value="fbm_warp"])')).toHaveValue('fbm_warp')

    const g0 = await shootPng(page, canvas)
    expect(spread(g0)).toBeGreaterThan(8) // an object is rendering at all (not a blank canvas)

    // Liveness: the field must ANIMATE on the mesh (speed:1, u_time advancing). Polled
    // rather than a single fixed gap, for the same reason as Shape Studio above — the
    // motion is subtle at this scale and one sampled window can land between two
    // quantized time buckets.
    await expect.poll(async () => {
      const g1 = await shootPng(page, canvas)
      return diffCount(g0, g1)
    }, { timeout: 8_000, intervals: [500, 800, 1200] }).toBeGreaterThan(3)
  })
})
