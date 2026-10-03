import { test, expect, type Page } from '@playwright/test'
import { dropNode, waitForBackend, dismissStartModal, openFirstStudioCard } from './_helpers'

/**
 * Grouping — end-to-end.
 *
 * The assertion that matters is the world-transform invariant: group, move the
 * group, ungroup, and every child must end up exactly where the screen showed
 * it. A viewport that merely LOOKS right is not evidence — grouping fails in
 * precisely the way a screenshot cannot catch, so this reads numeric state out
 * of the properties panel.
 *
 * TWO INSTRUMENTS, and which one is evidence of what:
 *
 *   - the world-transform invariant is measured against the DOCUMENT
 *     (`window.__scene3dDoc()`, full precision). The panel rows read at the
 *     precision they DISPLAY — Position to one decimal — and that is right for a
 *     control and wrong for this: `groupObjects` puts the group at its children's
 *     centroid, which for three children lands off the 0.1 grid, so the children's
 *     local positions are off-grid too and a rounded reading cannot add back to the
 *     exact world position. This suite used to measure the invariant through
 *     `aria-valuenow` and passed only because the read was then raw; that made it a
 *     test of the panel's precision wearing an invariant's clothes.
 *   - the ROWS are still read where a row is the thing under test: that a typed
 *     value lands, and that the panel shows the object the tree selected. Those
 *     assert at display precision, with a tolerance of half a step.
 *
 * `groupObjects` always creates the group at identity rotation and unit scale
 * (pinned by scene3d-hierarchy.unit.spec.ts), so while they are grouped a child's
 * world position is exactly `group.position + child.local`; after `ungroupObject`
 * both children are back at the root, where local == world again.
 */

// ── setup ─────────────────────────────────────────────────────────────────────

/**
 * A local variant of tests/_helpers.ts's openBlankWorkflow that does NOT wait for
 * 'networkidle'. Against the live backend this suite runs against (the real dev server on 127.0.0.1:3002, not a mocked one), the app polls
 * /api/health continuously, so 'networkidle' never fires and the shared helper
 * times out entirely before it even reaches the "Start a blank project" button.
 * Kept local rather than patched into the shared helper because parallel sessions
 * are actively touching this repo and other specs already depend on the shared
 * helper's exact behavior — not this task's place to change it.
 * (Copied from tests/shader-fill.spec.ts, which documents the same constraint.)
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
    // longer than a plain SPA route change, and the first click occasionally
    // doesn't take, so retry rather than trusting a single one.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: /Start a blank project/i }).first().click()
      const ok = await vueFlow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
      if (ok) break
      if (attempt === 2) throw new Error('openBlankWorkflow: .vue-flow never appeared after 3 attempts')
    }
  }

  // Skipping now lands a Frame (Compositor) on the canvas. This suite's
  // object-row counts are read from the 3D Studio dialog, not the canvas
  // node list, but a leftover Frame is still noise a bare-canvas test
  // shouldn't carry — remove it before dropping this spec's own node.
  await dismissStartModal(page)
}

// ── studio helpers ───────────────────────────────────────────────────────────

type Vec3 = [number, number, number]

const AXES = ['Position X', 'Position Y', 'Position Z'] as const

/** The object-list row for `name`. Rows are rendered by Scene3DObjectRow.vue,
 *  which stamps `data-object-name` — matching on the attribute rather than on
 *  visible text keeps this unambiguous when a group and a child share a word. */
function row(page: Page, name: string) {
  return page.locator(`[data-testid="object-row"][data-object-name="${name}"]`)
}

/**
 * The Transform panel is drawn from the schema now (`SCENE_CONTROLS`' Transform group,
 * via panelPresentation.ts), so each axis is a `StudioRow` rather than an
 * `<input type="number">`. The labelled element is the row's TRACK — a `role="slider"`
 * div carrying `aria-valuenow` — and the number is only an `<input>` while typed entry
 * is open, which is why reading and writing take two different routes below.
 */
async function readRow(page: Page, label: string): Promise<number> {
  return Number(await page.getByLabel(label).getAttribute('aria-valuenow'))
}

/** Type an exact value into one row: click its readout to open the field, fill, Enter. */
async function typeRow(page: Page, label: string, value: string): Promise<void> {
  const row = page.getByLabel(label).locator('xpath=..')
  await row.locator('span.font-mono').last().click()
  const field = row.locator('input')
  await field.fill(value)
  await field.press('Enter')
}

/** Read the selected object's LOCAL position out of the Transform panel — at the
 *  precision the panel SHOWS it, which is what makes it evidence about the UI and not
 *  about geometry. Half a step, the most a correct row can differ from the stored value. */
async function readPosition(page: Page): Promise<Vec3> {
  const out: number[] = []
  for (const label of AXES) out.push(await readRow(page, label))
  return out as Vec3
}
const ROW_TOL = 0.05

/**
 * The document itself, at full precision — the instrument for every world-transform
 * assertion below. Exposed by Scene3DStudioSurface.vue's `__scene3dDoc` test hook (see
 * its comment); polled because a click on a tree row and the doc write it triggers are
 * both Vue-reactive and this can otherwise run between them.
 */
type SceneObj = { name: string; position: Vec3; parentId?: string }
async function docObjects(page: Page): Promise<SceneObj[]> {
  await expect.poll(async () => page.evaluate(
    () => typeof (window as any).__scene3dDoc === 'function'), { timeout: 10_000 }).toBe(true)
  return page.evaluate(() => (window as any).__scene3dDoc().objects as SceneObj[])
}

/** One object's stored LOCAL position, by name. */
async function docPosition(page: Page, name: string): Promise<Vec3> {
  const objects = await docObjects(page)
  const o = objects.find((x) => x.name === name)
  expect(o, `${name} must exist in the document (have: ${objects.map((x) => x.name).join(', ')})`).toBeTruthy()
  return o!.position
}

/** Type a position into the Transform panel, one row at a time. */
async function writePosition(page: Page, p: Vec3) {
  for (let i = 0; i < 3; i++) await typeRow(page, AXES[i]!, String(p[i]))
}

/** Select a row and wait for the Transform panel to actually be showing THAT
 *  object before reading — the panel is driven by Vue reactivity, so a bare read
 *  straight after the click can race it. Keyed on the row's selected styling
 *  (`bg-white/15`), which is what tells us `selectedIds` has landed. */
async function selectOnly(page: Page, name: string) {
  await row(page, name).click()
  await expect(row(page, name)).toHaveClass(/bg-white\/15/)
}

/** Add a primitive from the viewport's add-menu. The menu click is scoped to the
 *  toolbar pill (`[data-prim-menu]`) so a kind label that also appears elsewhere
 *  in the inspector can never be picked up by accident. The pill is a face+caret
 *  split now (the face repeats the last-used kind, the caret opens the grid), so
 *  this goes through the caret — the face's label is the last kind, not the word
 *  "Primitive". */
async function addPrimitive(page: Page, label: string) {
  const toolbar = page.locator('[data-prim-menu]')
  await toolbar.getByTestId('prim-menu-toggle').click()
  // Scoped to the open MENU, not the pill: the face button wears the last-used
  // kind's label too, so a pill-wide name match is ambiguous by design.
  await toolbar.getByTestId('prim-menu').getByRole('button', { name: label, exact: true }).click()
}

// ── the test ─────────────────────────────────────────────────────────────────

test.describe('3D Studio — object grouping (E2E)', () => {
  test('group, move the group, ungroup — every child keeps its world position', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // Taller than the config default (1600x1000): at 1000px the freshly-added
    // node's footer (Edit/Render) lands directly behind the fixed "Ask about the
    // graph" chat bar, which intercepts the click even though it's visually a thin
    // strip — Playwright's actionability check is a real hit-test, so it (correctly)
    // refuses a click something else would eat.
    await page.setViewportSize({ width: 1600, height: 1300 })

    await dropNode(page, 'Scene3DStudio')

    // Open the studio via the node's own Edit button — that handler is literally
    // `window.dispatchEvent(new CustomEvent('sailor:openScene3DStudio', …))`
    // (Scene3DStudioNode.vue:79), so this is the brief's entry recipe driven
    // through the real UI, and it needs no scraping of the vue-flow node id.
    await openFirstStudioCard(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('3D Studio', { exact: true })).toBeVisible({ timeout: 15_000 })

    // A fresh Scene3DStudio node parses to defaultDoc(), whose `objects` is empty —
    // asserted so a seeded default can never make the counts below vacuous.
    await expect(page.locator('[data-testid="object-row"]')).toHaveCount(0)

    // ── two primitives, at deliberately DIFFERENT positions ──────────────────
    // Both primitives are created at [0, 0.5, 0]. Left there, the group's bounds
    // centre would coincide with both children and every child local would be
    // exactly zero — a state in which "forgot to rebase" and "rebased correctly"
    // produce the SAME numbers. Distinct positions are what make the assertion
    // at the end able to fail.
    const BOX_POS: Vec3 = [1.5, 0.5, -0.5]
    const SPHERE_POS: Vec3 = [-0.5, 2, 1]

    await addPrimitive(page, 'Box')
    await expect(row(page, 'Box')).toHaveCount(1)
    await selectOnly(page, 'Box')
    await writePosition(page, BOX_POS)

    await addPrimitive(page, 'Sphere')
    await expect(row(page, 'Sphere')).toHaveCount(1)
    await selectOnly(page, 'Sphere')
    await writePosition(page, SPHERE_POS)

    // Record the pre-group positions by READING them back, rather than trusting
    // what we typed — if a write silently didn't land, the invariant below would
    // otherwise be checked against a fiction.
    // Two readings, deliberately: the DOCUMENT is what the invariant is measured against,
    // and the ROW is checked separately to prove the typing actually landed rather than
    // the test asserting against a fiction.
    const boxBefore = await docPosition(page, 'Box')
    expect(boxBefore).toEqual(BOX_POS)
    const sphereBefore = await docPosition(page, 'Sphere')
    expect(sphereBefore).toEqual(SPHERE_POS)
    await selectOnly(page, 'Box')
    for (let i = 0; i < 3; i++) expect(await readRow(page, AXES[i]!)).toBeCloseTo(BOX_POS[i]!, 5)

    // ── group ────────────────────────────────────────────────────────────────
    await selectOnly(page, 'Box')
    await row(page, 'Sphere').click({ modifiers: ['Shift'] })
    await expect(page.getByRole('button', { name: 'Group', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Group', exact: true }).click()

    // A group row appeared, it reports two children, and both primitives now sit
    // INSIDE its subtree. Scene3DObjectRow renders a row's descendants as
    // siblings within the row's own wrapper <div>, so the wrapper containing the
    // group row must also contain both child rows — and, since the tree is
    // rendered from `rootObjects()`, three rows total means neither child is also
    // still being drawn at the root.
    const groupRow = row(page, 'Group')
    await expect(groupRow).toHaveCount(1)
    await expect(groupRow.locator('[data-testid="object-row-children"]')).toHaveText('2')
    const groupBlock = groupRow.locator('xpath=..')
    await expect(groupBlock.locator('[data-testid="object-row"][data-object-name="Box"]')).toHaveCount(1)
    await expect(groupBlock.locator('[data-testid="object-row"][data-object-name="Sphere"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="object-row"]')).toHaveCount(3)

    // The children are still where the user left them: their world position is
    // group.position + local while grouped (the group is created at identity
    // rotation / unit scale), so this is a real check, not bookkeeping.
    const groupBefore = await docPosition(page, 'Group')
    for (const [name, before] of [['Box', boxBefore], ['Sphere', sphereBefore]] as const) {
      const local = await docPosition(page, name)
      for (let i = 0; i < 3; i++) expect(local[i]! + groupBefore[i]!, `${name} axis ${i}`).toBeCloseTo(before[i]!, 5)
    }

    // ── move the group ───────────────────────────────────────────────────────
    const DELTA_X = 2.5
    const groupTarget = groupBefore[0]! + DELTA_X
    await selectOnly(page, 'Group')
    await typeRow(page, 'Position X', String(groupTarget))
    // The row is the thing under test here, so it is read as a row: at display precision.
    await expect
      .poll(async () => (await readPosition(page))[0])
      .toBeCloseTo(groupTarget, 1)
    // …and the document got the number verbatim, not the row's rounding of it.
    await expect
      .poll(async () => (await docPosition(page, 'Group'))[0], { timeout: 5_000 })
      .toBeCloseTo(groupTarget, 5)

    // ── ungroup ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Ungroup', exact: true }).click()
    await expect(row(page, 'Group')).toHaveCount(0)
    await expect(page.locator('[data-testid="object-row"]')).toHaveCount(2)

    // ── THE INVARIANT ────────────────────────────────────────────────────────
    // Back at the root, local == world again. Each child must read its original
    // world position shifted by exactly the offset the group was moved by — no
    // more (the group's transform applied twice), no less (the rebase skipped),
    // and nothing at all on the untouched axes.
    for (const [name, before] of [['Box', boxBefore], ['Sphere', sphereBefore]] as const) {
      const expected: Vec3 = [before[0]! + DELTA_X, before[1]!, before[2]!]
      for (let i = 0; i < 3; i++) {
        await expect
          .poll(async () => (await docPosition(page, name))[i]!, { timeout: 5_000 })
          .toBeCloseTo(expected[i]!, 5)
      }
      // And the panel agrees, to within what a one-decimal row can express.
      await selectOnly(page, name)
      const shown = await readPosition(page)
      for (let i = 0; i < 3; i++) expect(Math.abs(shown[i]! - expected[i]!), `${name} row ${i}`).toBeLessThanOrEqual(ROW_TOL)
    }
  })

  /**
   * Multi-selection fan-out. The unit tests pin the arithmetic
   * (`axisDeltaWrites` in scene3d-hierarchy.unit.spec.ts); this pins the WIRING,
   * which is where the bug actually lived — the panel was reading and writing
   * only the primary while material edits and the gizmo already fanned out, so
   * with three objects selected Color changed three and Position X changed one.
   *
   * Both halves have been shown to fail against a deliberately-broken control:
   * writing only `selectedIds.slice(-1)` leaves the Box at 1 instead of 8, and
   * restoring the unconditional `selectedIds = []` on a null select makes the
   * badge disappear on the shift-click miss.
   */
  test('a transform row applies the same delta to every selected object', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await page.setViewportSize({ width: 1600, height: 1300 })
    await dropNode(page, 'Scene3DStudio')
    await openFirstStudioCard(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('3D Studio', { exact: true })).toBeVisible({ timeout: 15_000 })

    const BOX: Vec3 = [1, 0.5, 0]
    const SPHERE: Vec3 = [-2, 3, 1]
    await addPrimitive(page, 'Box')
    await selectOnly(page, 'Box')
    await writePosition(page, BOX)
    await addPrimitive(page, 'Sphere')
    await selectOnly(page, 'Sphere')
    await writePosition(page, SPHERE)

    // Box, then shift-Sphere: the LAST entry is the primary, so the panel is
    // showing the Sphere's numbers.
    await selectOnly(page, 'Box')
    await row(page, 'Sphere').click({ modifiers: ['Shift'] })

    const badge = page.locator('[data-testid="multi-select-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('2 objects selected')
    // A row read, and rightly so: the claim is that the PANEL shows the primary.
    expect(await readPosition(page)).toEqual(SPHERE)

    // Typing 5 on the primary is a delta of +7. DELTA, not the absolute value:
    // if both objects were set to 5 they would land on top of each other, which
    // is the failure mode the spec's "same delta" wording exists to rule out.
    // Read off the DOCUMENT: this is an assertion about the fan-out's arithmetic,
    // not about what a row displays. (These values happen to sit on the row's own
    // 0.1 grid, so it would pass either way — but the instrument should match the
    // claim, or the next value that doesn't fails for a reason nobody expects.)
    await typeRow(page, 'Position X', '5')
    await expect.poll(async () => (await docPosition(page, 'Sphere'))[0], { timeout: 5_000 }).toBeCloseTo(5, 5)
    await expect.poll(async () => (await docPosition(page, 'Box'))[0], { timeout: 5_000 }).toBeCloseTo(BOX[0]! + 7, 5)
    // Untouched axes on the non-primary stayed put — a fan-out that copied the
    // whole vector would fail here and pass the X check above.
    expect((await docPosition(page, 'Box'))[1]).toBeCloseTo(BOX[1]!, 5)

    // A shift-click that MISSES everything must leave the selection alone: the
    // gesture that builds a multi-selection must never be the one that wipes it.
    // The point is derived from the canvas rect rather than hard-coded — the
    // viewport's top-LEFT corner is covered by a toolbar button, and clicking
    // that made an earlier version of this assertion vacuous.
    await selectOnly(page, 'Box')
    await row(page, 'Sphere').click({ modifiers: ['Shift'] })
    await expect(badge).toBeVisible()
    const canvas = dialog.locator('canvas').first()
    const rect = (await canvas.boundingBox())!
    await canvas.click({ position: { x: rect.width - 20, y: 20 }, modifiers: ['Shift'] })
    await expect(badge).toBeVisible()
  })
})
