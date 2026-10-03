import { test, expect, type Page } from '@playwright/test'
import { dropNode, waitForBackend, dismissStartModal } from './_helpers'

/**
 * 3D Studio — SVG import, end-to-end.
 *
 * Why this file exists at all: the render half of the feature (`d` → shapes →
 * ExtrudeGeometry) is covered by unit tests, but the IMPORT half runs on
 * paper.js, which touches browser globals at module-import time and so is
 * deliberately never loaded outside a browser. There is no unit-test seam for
 * it. Everything below the parse — stroke outlining above all — has this spec
 * as its only gate.
 *
 * The load-bearing case is the stroke-only icon (test 2). Lucide (this repo's
 * own icon set), Feather and Heroicons-outline are entirely `fill="none"`, so
 * an icon is the single most likely thing a user pastes, and without
 * `outlineStrokes` there is nothing with area to extrude. That test therefore
 * asserts EXTENT, not existence: an un-outlined path still produces an object
 * and still produces a row, so "a child appeared" passes whether the stroke
 * branch ran or not. See the note above `assertStrokesOutlinedIntoArea`.
 */

// ── setup ─────────────────────────────────────────────────────────────────────

/**
 * A local variant of tests/_helpers.ts's openBlankWorkflow that does NOT wait for
 * 'networkidle'. Against the live backend this suite runs against (the real dev server on
 * 127.0.0.1:3002), the app polls /api/health continuously, so 'networkidle'
 * never fires and the shared helper times out before it even reaches the
 * "Start a blank project" button. Kept local rather than patched into the shared
 * helper because other specs already depend on that helper's exact behavior.
 * (Copied verbatim from tests/scene3d-grouping.spec.ts, which documents the same
 * constraint.)
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
    // A project already auto-resumed.
  } else {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: /Start a blank project/i }).first().click()
      const ok = await vueFlow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
      if (ok) break
      if (attempt === 2) throw new Error('openBlankWorkflow: .vue-flow never appeared after 3 attempts')
    }
  }

  // Skipping now lands a Frame (Compositor); this spec drops its own
  // Scene3DStudio node and opens it by dispatched nodeId (not by index), so a
  // leftover Frame wouldn't break it — but the suite's own object-count
  // assertions (`allRows` etc.) are cleanest against a genuinely bare canvas.
  await dismissStartModal(page)
}

/**
 * Drop a Scene3DStudio node and open its studio. The studio is opened by
 * dispatching the same event the node's own Edit button dispatches
 * (Scene3DStudioNode.vue), rather than by clicking it, so this never depends on
 * which node a stray `.first()` picked up.
 *
 * Asserts the object list starts EMPTY. That is not ceremony: every count
 * assertion below is relative to "what the import added", so a scene that
 * arrived with objects already in it would make them vacuous.
 */
async function openStudio(page: Page) {
  await waitForBackend(page)
  await openBlankWorkflow(page)
  // Taller than the config default (1600x1000): at 1000px the freshly-added
  // node's footer lands behind the fixed "Ask about the graph" chat bar.
  await page.setViewportSize({ width: 1600, height: 1300 })

  await dropNode(page, 'Scene3DStudio')
  // dropNode's fixed 300ms is not enough here: the node's own render lands
  // later than that, and reading `data-id` too early yields null — which the
  // canvas's handler quietly ignores (`if (detail?.nodeId)`), so the studio
  // simply never opens and the failure surfaces 20s later as "no dialog".
  const nodeEl = page.locator('.vue-flow__node[data-id]').last()
  await nodeEl.waitFor({ state: 'attached', timeout: 20_000 })
  const nodeId = await nodeEl.getAttribute('data-id')
  expect(nodeId, 'Scene3DStudio node must carry a vue-flow id').toBeTruthy()
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('sailor:openScene3DStudio', { detail: { nodeId: id } }))
  }, nodeId)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('3D Studio', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(allRows(page)).toHaveCount(0)
  return dialog
}

// ── import helpers ───────────────────────────────────────────────────────────

/** Everything below is scoped to the studio dialog, not the page. The app
 *  behind the modal has its own 'Add' button in the toolbar, so an unscoped
 *  `getByRole('button', { name: 'Add' })` is a strict-mode violation rather
 *  than a wrong click — but scoping is the honest fix either way. */
function dlg(page: Page) { return page.getByRole('dialog') }

/** Paste `svg` into the studio's paste box and submit it. */
async function pasteSvg(page: Page, svg: string) {
  await dlg(page).getByRole('button', { name: /paste svg/i }).click()
  const box = dlg(page).getByPlaceholder('Paste <svg>…</svg>')
  await expect(box).toBeVisible()
  await box.fill(svg)
  const add = dlg(page).getByRole('button', { name: 'Add', exact: true })
  await expect(add).toBeEnabled()
  await add.click()
}

function row(page: Page, name: string) {
  return dlg(page).locator(`[data-testid="object-row"][data-object-name="${name}"]`)
}

/** Every object row in the studio, whatever its depth. */
function allRows(page: Page) { return dlg(page).locator('[data-testid="object-row"]') }

/** A paste is named 'SVG' by importSvgSource, so this is the group it creates. */
function groupRow(page: Page) { return row(page, 'SVG') }

/** The group row's own wrapper <div>, which (Scene3DObjectRow renders its
 *  subtree inside it) also contains every descendant row. */
function groupBlock(page: Page) { return groupRow(page).locator('xpath=..') }

/** Child rows of the imported group — every row in its block except the group's
 *  own. Rows expand by default (`expanded = ref(true)`), so no disclosure click. */
function childRows(page: Page) {
  return groupBlock(page).locator('[data-testid="object-row"]:not([data-object-name="SVG"])')
}

async function selectOnly(page: Page, name: string) {
  await row(page, name).click()
  await expect(row(page, name)).toHaveClass(/bg-white\/15/)
}

/** Read the Size row (scale × the geometry's own measured bounds — see
 *  `baseSize` in Scene3DStudioSurface.vue, which calls `baseSizeFor`, which
 *  BUILDS the geometry and takes its bounding box). Objects are created at unit
 *  scale, so for a fresh import this is the extruded geometry's real extent.
 *
 *  CAVEAT, and it is the whole reason the assertions below are shaped the way
 *  they are: the Size row is `Math.round(scale * (baseSize[i] || 1) * 100) / 100`,
 *  so an axis whose real extent is ZERO does not display 0 — it displays the
 *  scale, i.e. **1** for a fresh import. A degenerate object therefore reads
 *  LARGER than a correct one, and "Size > 0" is satisfied by the exact failure
 *  it is meant to catch. Measured, not assumed: with `outlineStrokes` disabled,
 *  Lucide `box`'s vertical-stroke child reads X = 1; with it enabled, 0.14. */
async function readSize(page: Page): Promise<[number, number, number]> {
  // The Transform panel is schema-drawn now (panelPresentation.ts), so each axis is a
  // `StudioRow`: the labelled element is the row's `role="slider"` track and the number
  // lives on `aria-valuenow`, not in an `<input>`.
  const n = async (label: string) =>
    Number(await dlg(page).getByLabel(label).getAttribute('aria-valuenow'))
  return [await n('Size X'), await n('Size Y'), await n('Size Z')]
}

/**
 * Every object's stored position, at full precision, from Scene3DStudioSurface.vue's
 * `__scene3dDoc` test hook.
 *
 * The Position row reads at the precision it DISPLAYS (one decimal), and the arrangement
 * assertion below has a threshold of 0.01 — half an order of magnitude BELOW what a
 * rounded row can even express, so two children legitimately 0.04 apart would both read
 * 0.0 and the check would fail on a correct import. Measure the document, which is what
 * the claim is actually about. (Same reasoning as tests/scene3d-grouping.spec.ts's
 * header.)
 */
async function docPositions(page: Page): Promise<Record<string, [number, number, number]>> {
  await expect.poll(async () => page.evaluate(
    () => typeof (window as any).__scene3dDoc === 'function'), { timeout: 10_000 }).toBe(true)
  return page.evaluate(() => Object.fromEntries(
    (window as any).__scene3dDoc().objects.map((o: any) => [o.name, o.position])))
}

/** One stroke width of a Lucide glyph in scene units after import, to an order
 *  of magnitude — the band below is deliberately wide, so this only has to be
 *  the right SIZE, not the exact number.
 *  Lucide draws at `stroke-width="2"`, and `importSvgSource` normalizes to
 *  `targetWidth: 1.5` scene units. Note the scale divisor is the drawing's own
 *  CONTENT-BOUNDS width, NOT the 24-unit viewBox: normalization is
 *  targetWidth / bounds.width, and Lucide icons sit inset from their viewBox
 *  (`box` spans about 18 units), so the real factor is ~1.5/18 and the real
 *  thickness lands near 0.167, plus the extruder's small bevel. Using 24 here
 *  understates it — kept only as the conservative lower anchor for the band,
 *  since a sparser icon with tighter bounds scales up further still.
 *  Derived from the source values, not pasted from a run. */
const LUCIDE_STROKE = 2 * (1.5 / 24)

/**
 * The stroke branch's only gate: the icon's strokes came back as SOLIDS with
 * real 2D area, of about the right thickness.
 *
 * Why not simply "every child has non-zero size": because that passes with
 * `outlineStrokes` removed. A stroke-only path still arrives with a `d`, still
 * becomes an svgPath object, still gets a row, and — thanks to the `|| 1`
 * fallback documented on `readSize` — still reports a non-zero Size. Existence
 * is not evidence here and neither is non-zero-ness.
 *
 * What only outlining can produce is the right THICKNESS. Lucide's `box` glyph
 * ends with `M12 22V12`, a pure vertical segment: outlined it becomes a bar
 * exactly one stroke width across, and un-outlined it is a zero-width line
 * (which the panel then reports as 1). So the thinnest child in X pins the
 * difference — ~0.14 outlined versus 1 not, an order of magnitude apart, with
 * the assertion band nowhere near either boundary. Taking the MINIMUM keeps
 * this independent of the order children are created in.
 */
async function assertStrokesOutlinedIntoArea(page: Page) {
  const names = await childRows(page).evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-object-name') ?? ''))
  expect(names.length).toBeGreaterThan(0)

  const widths: number[] = []
  for (const name of names) {
    await selectOnly(page, name)
    // Poll once per object: the Size row is a computed that rebuilds the
    // geometry, so a bare read straight after the click can beat Vue's flush.
    await expect.poll(async () => (await readSize(page))[0], { timeout: 10_000 }).toBeGreaterThan(0)
    const [x, y, z] = await readSize(page)
    expect(x, `${name}: Size X`).toBeGreaterThan(0)
    expect(y, `${name}: Size Y`).toBeGreaterThan(0)
    // `buildGeometry` substitutes a 0.3 cube when a path yields no shapes at
    // all (`extrudePlaceholderGeometry`). That stand-in has area on every axis,
    // so without this check a child with NO geometry would read as a healthy
    // one — a different way for "it has size" to be a lie.
    const placeholder = [x, y, z].every((v) => Math.abs(v - 0.3) < 0.001)
    expect(placeholder, `${name}: is the 0.3 no-geometry placeholder cube, not real geometry`).toBe(false)
    widths.push(x)
  }

  // The vertical stroke, outlined: one stroke width across. The band spans
  // 0.0625..0.375, which comfortably brackets the real ~0.167 (see
  // LUCIDE_STROKE on why it is not 0.125) plus the bevel's ~0.015, and still
  // leaves a wide gap to the 1 that a non-outlined zero-width line reports.
  const thinnest = Math.min(...widths)
  expect(thinnest, 'the vertical stroke must outline into a bar about one stroke width across')
    .toBeGreaterThan(LUCIDE_STROKE * 0.5)
  expect(thinnest, 'a child measuring far more than one stroke width across means the stroke was never outlined')
    .toBeLessThan(LUCIDE_STROKE * 3)
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const TWO_FILLED =
  '<svg viewBox="0 0 20 10">' +
  '<path d="M0 0 H10 V10 H0 Z" fill="#ff0000"/>' +
  '<path d="M12 0 H20 V10 H12 Z" fill="#00ff00"/>' +
  '</svg>'

/** Lucide's `box` glyph, verbatim from this repo's own lucide-vue-next
 *  (v0.576.0, dist/esm/icons/box.js) — a real icon, not a hand-made
 *  approximation of one. Stroke-only, which is the whole point. */
const LUCIDE_BOX =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
  '<path d="m3.3 7 8.7 5 8.7-5"/>' +
  '<path d="M12 22V12"/>' +
  '</svg>'

/** 45 filled squares — over SVG_SPLIT_THRESHOLD (40), so import must ASK. */
const MANY_PATH_COUNT = 45
const MANY_PATHS =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MANY_PATH_COUNT * 4} 10">` +
  Array.from({ length: MANY_PATH_COUNT }, (_, i) =>
    `<path d="M${i * 4} 0 H${i * 4 + 3} V3 H${i * 4} Z" fill="#3b82f6"/>`).join('') +
  '</svg>'

/**
 * Explicitly `fill="none"`, no stroke — parses fine, yields nothing extrudable.
 *
 * The `fill="none"` is NOT decoration and must not be dropped. SVG's initial
 * value for `fill` is **black**, so a bare `<path d="…"/>` with no fill
 * attribute is a FILLED path, and paper.js reports it as one — verified against
 * the running app, where `<svg><path d="M0 0 L10 0"/></svg>` imports as a group
 * with one child rather than raising this error. (That child is a degenerate
 * zero-area line; see the task report.) Only an explicit `fill="none"` with no
 * stroke is genuinely nothing-to-extrude, which is the state this message
 * exists for.
 */
const NOTHING_TO_EXTRUDE =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0" fill="none"/></svg>'

const NOTHING_MSG = 'That SVG had nothing to extrude — no filled or stroked paths.'

// ── the tests ────────────────────────────────────────────────────────────────

test.describe('3D Studio — SVG import (E2E)', () => {
  test('two filled paths import as a group of two objects', async ({ page }) => {
    await openStudio(page)
    await pasteSvg(page, TWO_FILLED)

    await expect(groupRow(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(groupRow(page).locator('[data-testid="object-row-children"]')).toHaveText('2')
    await expect(childRows(page)).toHaveCount(2)
    // Group + two children and nothing else: neither child is ALSO drawn at the
    // root, which is what a missed parentId would look like.
    await expect(allRows(page)).toHaveCount(3)

    // ARRANGEMENT, not just count: TWO_FILLED's two paths are drawn 12 SVG
    // units apart (x=0..10 and x=12..20). Every path recentres its OWN
    // geometry on its own bbox (extrudeShapes, shared with text/shape), so if
    // the child object doesn't ALSO carry its own position, both land on the
    // origin — a group of two objects that still LOOK like a pile of one.
    // This is exactly the bug that shipped: a child-count assertion alone
    // passes whether or not the arrangement fix is present.
    const names = await childRows(page).evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-object-name') ?? ''))
    expect(names).toHaveLength(2)
    const positions = await docPositions(page)
    const xs = names.map((n) => positions[n]?.[0] ?? NaN)
    expect(xs.every(Number.isFinite), `both children must be in the document (have: ${Object.keys(positions).join(', ')})`).toBe(true)
    expect(Math.abs(xs[0]! - xs[1]!), 'the two children must sit at different Position X, not both at the origin').toBeGreaterThan(0.01)
  })

  test('a stroke-only Lucide icon outlines into extrudable area', async ({ page }) => {
    await openStudio(page)
    await pasteSvg(page, LUCIDE_BOX)

    await expect(groupRow(page)).toHaveCount(1, { timeout: 20_000 })
    // No error: a stroke-only icon must not be mistaken for "nothing to extrude".
    await expect(dlg(page).getByText(NOTHING_MSG)).toHaveCount(0)
    const children = await childRows(page).count()
    expect(children).toBeGreaterThan(0)

    // THE assertion — see assertStrokesOutlinedIntoArea's comment. Neither
    // existence nor non-zero-ness is evidence here; thickness is.
    await assertStrokesOutlinedIntoArea(page)
  })

  test('an SVG over the split threshold offers a choice, and merging yields one object', async ({ page }) => {
    await openStudio(page)
    await pasteSvg(page, MANY_PATHS)

    // The choice panel, not a silent import of 45 meshes.
    await expect(dlg(page).getByText(`This SVG has ${MANY_PATH_COUNT} paths.`)).toBeVisible({ timeout: 20_000 })
    await expect(dlg(page).getByRole('button', { name: 'Separate objects' })).toBeVisible()
    // Nothing has been committed yet — the choice is a real gate, not a
    // post-hoc notice.
    await expect(allRows(page)).toHaveCount(0)

    await dlg(page).getByRole('button', { name: 'One merged object' }).click()

    await expect(groupRow(page)).toHaveCount(1)
    await expect(groupRow(page).locator('[data-testid="object-row-children"]')).toHaveText('1')
    await expect(childRows(page)).toHaveCount(1)
    await expect(allRows(page)).toHaveCount(2)
    // The choice panel is gone, so it can't be re-committed by a stray click.
    await expect(dlg(page).getByText(`This SVG has ${MANY_PATH_COUNT} paths.`)).toHaveCount(0)
  })

  test('an SVG with nothing to extrude reports it and adds nothing', async ({ page }) => {
    await openStudio(page)
    await pasteSvg(page, NOTHING_TO_EXTRUDE)

    await expect(dlg(page).getByText(NOTHING_MSG)).toBeVisible({ timeout: 20_000 })
    // The specific message matters: "could not read that SVG" would send someone
    // looking for a syntax error that isn't there.
    await expect(dlg(page).getByText('Could not read that SVG.')).toHaveCount(0)
    // And nothing landed in the doc — not even an empty group.
    await expect(allRows(page)).toHaveCount(0)
  })
})
