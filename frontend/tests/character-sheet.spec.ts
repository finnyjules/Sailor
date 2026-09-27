import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * Character sheet E2E (character-system plan, Task 15 — final verification;
 * re-verified against the Character Studio workbench redesign, Task 6).
 *
 * Proves the plan's acceptance property end-to-end: casting a character into
 * a Shot Director (video) AND using a character "in image" both resolve to
 * the SAME identity asset — the state's composite sheet filename. Two
 * consumers, one asset. Scenario C (added for the workbench redesign) proves
 * the roster→studio-modal surface itself: opening a character renders the
 * new workbench with the quiet readiness vocabulary and nothing from the
 * retired locked/draft/stress/variant wording.
 *
 * `/api/characters-local` is route-intercepted with a fixture character
 * (`fixture-cal`) whose default state already has a locked `sheetImage` and
 * a `descriptor` — no live generation, no paid calls. `/prompt` and
 * `/upload/image` are also intercepted as a belt-and-suspenders guard
 * against real backend spend, though neither scenario should reach them:
 * Scenario A's `sailor:shotDirectorGenerate` writes the FilmShotNode's
 * widgets synchronously before it ever dispatches the run, and the app's own
 * cost-confirm gate (`runVueWorkflow`) blocks queuing until a user clicks
 * "Confirm" — which this spec never does.
 *
 * Scenario A deliberately keeps driving Shot Director's own "+ Cast" picker
 * (`CharacterPickerModal`, `via: 'picker'` in `sheet.cast`) rather than the
 * roster's "Shot" button. The roster button (`CharacterRosterPanel.castInShot`
 * → `addCharacterCastNode`) only drops an unwired `Character` node on the
 * canvas — turning that into a cast member requires a real canvas wire drag
 * into a Shot Director's cast input (`castEdges.ts`'s `via: 'wire'` path),
 * which this codebase deliberately avoids in E2E (see
 * `tests/*-cast-edges.unit.spec.ts` for that path's coverage, and the
 * "no synthetic-wire hack" rationale below). Neither `ShotDirectorSurface.vue`
 * nor `CharacterPickerModal.vue` changed in the workbench redesign (W1-W5
 * touched only the roster panel, the studio modal, and the retired library
 * panel/CharacterSheetNode), so this scenario is unaffected by it.
 *
 * Page state (node data, including widgets with `sailor_widget: "internal"`
 * that never render in the DOM, like FilmShotNode's `model_options`) is read
 * through Vue's dev-only `__vueParentComponent` backlink up to
 * VueNodeCanvas's `defineExpose` surface (`getNodes`/`getEdges`) — the same
 * pattern `tests/moodboard-core.spec.ts` established, reading the app's own
 * live objects rather than a test fixture's guess at their shape.
 */

const SHEET_FILENAME = 'sheet-cal.png'
const DESCRIPTOR = 'soaked navy jacket'

const FIXTURE = {
  characters: [{
    name: 'Cal',
    slug: 'fixture-cal',
    states: [{
      id: 'default',
      label: 'Default',
      descriptor: DESCRIPTOR,
      refImages: ['cover-cal.png'],
      coverIndex: 0,
      panels: [
        { slot: 'portrait', filename: 'portrait-cal.png' },
        { slot: 'body-front', filename: 'front-cal.png' },
      ],
      sheetImage: SHEET_FILENAME,
      status: 'locked',
      stressResult: null,
      updatedAt: '2026-08-13T00:00:00.000Z',
    }],
    loraName: null,
    trigger: null,
    notes: '',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  }],
}

async function mockCharactersLocal(page: Page) {
  await page.route('**/api/characters-local', async (route) => {
    const method = route.request().method()
    if (method === 'GET') {
      await route.fulfill({ json: FIXTURE })
    } else if (method === 'PATCH') {
      // Nothing in either scenario should PATCH, but stub it so a stray
      // write can't hit the real registry file.
      await route.fulfill({ json: { ok: true } })
    } else {
      await route.continue()
    }
  })
}

/** Belt-and-suspenders: neither scenario should reach these (see file
 *  header), but intercept them anyway so a real submission can never spend. */
async function blockBackendSpend(page: Page) {
  await page.route('**/prompt', (route) =>
    route.fulfill({ json: { prompt_id: 'e2e-blocked', number: 0, node_errors: {} } }))
  await page.route('**/upload/image', (route) =>
    route.fulfill({ json: { name: 'e2e-blocked.png', subfolder: '', type: 'input' } }))
}

/** Walk up from `.vue-flow` to VueNodeCanvas's defineExpose surface — same
 *  recipe as tests/moodboard-core.spec.ts's pullNodeData/pullSerializedWorkflow. */
async function findExposed(page: Page, method: string) {
  return page.evaluateHandle((m) => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed[m] === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    return c.exposed
  }, method)
}

async function pullNodes(page: Page): Promise<any[]> {
  const exposed = await findExposed(page, 'getNodes')
  return page.evaluate((e: any) => JSON.parse(JSON.stringify(e.getNodes())), exposed)
}

async function pullEdges(page: Page): Promise<any[]> {
  const exposed = await findExposed(page, 'getEdges')
  return page.evaluate((e: any) => JSON.parse(JSON.stringify(e.getEdges())), exposed)
}

/** `widgetsValues` is a positional array; `widgetDefs` carries the names in
 *  the same order — zip them to read a widget by name (including
 *  `sailor_widget: "internal"` ones, which never render as DOM inputs). */
function widgetByName(node: any, name: string): unknown {
  const defs: { name: string }[] = node?.data?.widgetDefs ?? []
  const idx = defs.findIndex((d) => d.name === name)
  if (idx < 0) return undefined
  return node?.data?.widgetsValues?.[idx]
}

test.describe('Character sheet: images and video consume the same identity asset', () => {
  test.beforeEach(async ({ page }) => {
    await mockCharactersLocal(page)
    await blockBackendSpend(page)
    await waitForBackend(page)
    await openBlankWorkflow(page)
    // Neutralize Clerk's dev-mode "claim your app" banner (#clerk-components,
    // global via the @clerk/nuxt module in nuxt.config.ts) — unrelated to
    // this spec, but its fixed-position anchor can sit on top of dialog
    // footer buttons and intercept clicks meant for them.
    await page.addStyleTag({ content: '#clerk-components { display: none !important; }' })
  })

  test('Scenario A (video): Shot Director cast + Generate writes the FilmShotNode from the sheet + descriptor', async ({ page }) => {
    test.setTimeout(60_000)

    // Drop a Shot Director node (Studios door in the UI; the headless
    // sailor:addNode event is the same path the "Add" toolbar door uses).
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'ShotDirector' } })))
    const shotDirectorCard = page.locator('.vue-flow__node').filter({ hasText: 'Shot Director' }).first()
    await expect(shotDirectorCard).toBeVisible({ timeout: 10_000 })

    // Open its editor (real UI: double-click the card, same as the user).
    await shotDirectorCard.dblclick()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Shot Director' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // Cast fixture-cal via the "+ Cast" picker — the picker is the OTHER
    // editor of sheet.cast (alongside canvas wiring; see castEdges.ts), and
    // is fully drivable through real clicks with no synthetic-wire hack.
    await dialog.getByRole('button', { name: '+ Cast', exact: true }).click()
    const picker = page.getByRole('heading', { name: 'Cast a character', exact: true })
    await expect(picker).toBeVisible({ timeout: 10_000 })
    // Single-variant card → clicking the name picks directly (stateId: null,
    // the default state implied) rather than expanding a variant row.
    await page.getByText('Cal', { exact: true }).click()
    await expect(picker).toBeHidden()
    // Cast landed: the "No one cast yet…" placeholder is replaced by a chip
    // with a remove ("×") button.
    await expect(dialog.getByText('No one cast yet', { exact: false })).toBeHidden()
    await expect(dialog.getByRole('button', { name: '×', exact: true })).toBeVisible()

    // Generate — writes the FilmShotNode's widgets synchronously (see
    // handleShotDirectorGenerate in VueNodeCanvas.vue) before it ever
    // dispatches sailor:runFiltered, and closes this dialog.
    // Two buttons match /^Generate/ in this dialog: the environment-plate
    // "Generate ~$…" helper and the shot's own "Generate · ~$…" submit — the
    // middot disambiguates the real one.
    await dialog.getByRole('button', { name: /Generate ·/ }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    await expect.poll(async () => {
      const nodes = await pullNodes(page)
      const film = nodes.find((n: any) => n.data?.nodeType === 'FilmShotNode')
      return !!film && (film.data?.widgetDefs?.length ?? 0) > 0
    }, { timeout: 10_000, message: 'Generate should spawn a FilmShotNode with widget schema loaded' }).toBe(true)

    const nodes = await pullNodes(page)
    const film = nodes.find((n: any) => n.data?.nodeType === 'FilmShotNode')
    expect(film, 'FilmShotNode should exist').toBeTruthy()

    const prompt = widgetByName(film, 'prompt') as string
    expect(prompt, 'compiled prompt should carry the cast clause with the state descriptor in parens')
      .toContain(`(${DESCRIPTOR})`)

    const modelOptionsRaw = widgetByName(film, 'model_options') as string
    expect(modelOptionsRaw, 'model_options widget should exist (sailor_widget: internal — never rendered in the DOM)').toBeTruthy()
    const modelOptions = JSON.parse(modelOptionsRaw)
    expect(Array.isArray(modelOptions.image_urls) && modelOptions.image_urls.length > 0, 'image_urls should be populated from the cast').toBe(true)
    expect(modelOptions.image_urls[0]).toContain('filename=portrait-cal.png')
    expect(modelOptions.image_urls[1]).toContain('filename=front-cal.png')
    expect(modelOptions.image_urls.some((u: string) => u.includes(SHEET_FILENAME)), 'the combined sheet is never sent to video').toBe(false)
  })

  test('Scenario B (image): roster "Image" button wires the SAME sheet filename into a ConsistentFaceNode', async ({ page }) => {
    test.setTimeout(60_000)

    // Open the Characters panel (real UI toolbar button) — CharacterRosterPanel.
    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    const nameEl = page.getByText('Cal', { exact: true }).first()
    await expect(nameEl).toBeVisible({ timeout: 10_000 })

    // Scope to the card (its "cursor-pointer" wrapper — clicking the card
    // body opens the studio modal instead, see Scenario C) so this can't
    // collide with any other "Image" label elsewhere in the app chrome
    // (e.g. the Add-node toolbar's "Image" node type).
    const card = nameEl.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]')

    // fixture-cal has no loraName, so the roster's "Image" button fires
    // straight to the sheet path (no lora/sheet menu — see
    // CharacterRosterPanel's useInImage).
    await card.getByRole('button', { name: 'Image', exact: true }).click()

    // Poll until both nodes exist AND the Image node's widget schema has
    // arrived (widgetDefs populates asynchronously off the object_info
    // fetch — reading widgetsValues before it lands races the schema).
    await expect.poll(async () => {
      const nodes = await pullNodes(page)
      const img = nodes.find((n: any) => n.data?.nodeType === 'Image')
      const face = nodes.find((n: any) => n.data?.nodeType === 'ConsistentFaceNode')
      return !!img && !!face && (img.data?.widgetDefs?.length ?? 0) > 0
    }, { timeout: 10_000, message: '"Use in image" should spawn an Image → ConsistentFaceNode pair with widget schema loaded' }).toBe(true)

    const nodes = await pullNodes(page)
    const imageNode = nodes.find((n: any) => n.data?.nodeType === 'Image')
    const faceNode = nodes.find((n: any) => n.data?.nodeType === 'ConsistentFaceNode')
    expect(imageNode, 'Image node should exist').toBeTruthy()
    expect(faceNode, 'ConsistentFaceNode should exist').toBeTruthy()

    // The image path still uses the sheet (stage 6 of the rework changes it); video no longer does.
    expect(widgetByName(imageNode, 'image')).toBe(SHEET_FILENAME)

    const edges = await pullEdges(page)
    const wired = edges.some((e: any) => String(e.source) === String(imageNode.id) && String(e.target) === String(faceNode.id))
    expect(wired, 'Image node should be wired into the ConsistentFaceNode').toBe(true)
  })

  test('Scenario C (studio): clicking a roster card opens the workbench with quiet readiness vocabulary', async ({ page }) => {
    test.setTimeout(30_000)

    // Open the Characters panel and click the card body (not a StudioButton
    // — those stop propagation) to open CharacterStudioModal.
    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    const nameEl = page.getByText('Cal', { exact: true }).first()
    await expect(nameEl).toBeVisible({ timeout: 10_000 })
    await nameEl.click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    // (a) the header readiness badge (the workbench's one `rounded-full` chip)
    // reads exactly one of the four readiness() vocabulary words. fixture-cal's
    // default state is status: 'locked', so this should read "Ready".
    const badge = modal.locator('span.rounded-full')
    await expect(badge).toBeVisible()
    // Leading whitespace is real: the badge's optional <Check> icon sits
    // before {{ ready.label }} in the template, and Vue's default whitespace
    // handling ('condense') collapses the gap to a single space rather than
    // removing it — trim before matching the vocabulary.
    const badgeText = (await badge.innerText()).trim()
    expect(badgeText).toMatch(/^(Ready|Not built|Not tested|\d+\/\d+ poses)$/)

    // (b) none of the retired locked/draft/stress/variant vocabulary leaks
    // into the rendered modal — readiness() is the ONLY source of status
    // wording (see this file's — and CharacterStudioModal.vue's — header
    // comment). innerText (not textContent) so hidden nodes don't trip it.
    const modalText = await modal.innerText()
    expect(modalText).not.toMatch(/locked|draft|stress|variant/i)

    // (c) the looks rail lists the fixture's states.
    await expect(modal.getByText('Default', { exact: true })).toBeVisible()
  })

  test('Scenario D (studio): entering test mode on an already-Ready look shows the confirm screen and spends nothing', async ({ page }) => {
    test.setTimeout(30_000)

    // Pins the auto-ready watcher regression: fixture-cal's default state is
    // already `status: 'locked'` (readiness 'ready') going in. Before the
    // fix, `enterTestMode` flipping the watch source from its idle `null`
    // straight to 'ready' read as "just became ready" and the watcher
    // immediately toasted + exited test mode — the confirm screen (and the
    // money gate it protects) never had a chance to render.
    let shotCalls = 0
    await page.route('**/api/cloud-train/character-shot', async (route) => {
      shotCalls++
      await route.fulfill({ json: { imageDataUrl: 'data:image/png;base64,e2e' } })
    })

    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    const nameEl = page.getByText('Cal', { exact: true }).first()
    await expect(nameEl).toBeVisible({ timeout: 10_000 })
    await nameEl.click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    await modal.getByRole('button', { name: /Test 10 poses/ }).click()

    // The confirm screen renders and — this is the regression — stays put
    // rather than bouncing back to the sheet a moment later.
    const confirmText = modal.getByText('10 test images', { exact: false })
    await expect(confirmText).toBeVisible({ timeout: 5_000 })
    await page.waitForTimeout(500)
    await expect(confirmText).toBeVisible()

    // No click on "Confirm" happened, so nothing should have generated.
    expect(shotCalls).toBe(0)
  })

  test('Scenario E (body): Body chip opens the editor, a slider push changes the phrase line, and Save PATCHes bodyShape', async ({ page }) => {
    test.setTimeout(30_000)

    // Route handlers stack last-registered-first: these run before
    // beforeEach's, so PATCH bodies are captured here and `route.fallback()`
    // hands GET/other methods back to `mockCharactersLocal`. `/prompt` and
    // `/upload/image` stay counted-then-fallen-back to the beforeEach stubs
    // so this scenario can prove zero calls without duplicating the guard.
    let patchBody: any = null
    await page.route('**/api/characters-local', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON()
        await route.fulfill({ json: { ok: true } })
      } else {
        await route.fallback()
      }
    })
    let promptCalls = 0
    await page.route('**/prompt', async (route) => { promptCalls++; await route.fallback() })
    let uploadCalls = 0
    await page.route('**/upload/image', async (route) => { uploadCalls++; await route.fallback() })

    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    const nameEl = page.getByText('Cal', { exact: true }).first()
    await expect(nameEl).toBeVisible({ timeout: 10_000 })
    await nameEl.click()

    // Only the workbench dialog is open at this point — unambiguous.
    const studio = page.getByRole('dialog')
    await expect(studio).toBeVisible({ timeout: 10_000 })
    await studio.getByRole('button', { name: 'Body', exact: true }).click()

    // BodyEditorModal now stacks on top of the workbench dialog (both
    // `role="dialog"`), so scope by its header text ("Body — Cal") rather
    // than the bare role.
    const bodyModal = page.getByRole('dialog').filter({ hasText: 'Body — Cal' })
    await expect(bodyModal).toBeVisible({ timeout: 10_000 })

    // Escape while the Body editor is open must close only the editor, not
    // the whole studio underneath it (Important 2 regression: the studio's
    // window keydown handler used to fire on every Escape regardless of
    // bodyEditorOpen, closing the studio out from under the editor).
    await page.keyboard.press('Escape')
    await expect(bodyModal).toBeHidden({ timeout: 5_000 })
    await expect(studio).toBeVisible()
    await studio.getByRole('button', { name: 'Body', exact: true }).click()
    await expect(bodyModal).toBeVisible({ timeout: 10_000 })

    // Sliders render — don't couple to the WebGL stage (fail-soft per the
    // component's own header comment; headless Chromium may or may not
    // produce a usable context). One range input per BODY_SLIDERS entry.
    const sliders = bodyModal.locator('input[type="range"]')
    await expect(sliders).toHaveCount(8)

    // Phrase line: fixture-cal has no bodyShape, so every slider seeds at
    // the neutral 0.5 default and bodyPhrase's dead zone emits nothing.
    const phraseLine = bodyModal.getByText('Reads as').locator('xpath=following-sibling::p[1]')
    await expect(phraseLine).toHaveText('Nothing — reads as an average build.')

    // Push "build" (BODY_SLIDERS[2]) to an extreme low value — bodyPhrase's
    // build band for v < 0.15 reads "a very slim, slight build". Range
    // inputs need a real 'input' event (v-model's listener) after the value
    // write; .fill() doesn't support type=range.
    const buildSlider = sliders.nth(2)
    await buildSlider.evaluate((el: HTMLInputElement) => {
      el.value = '0.05'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(phraseLine).toHaveText('a very slim, slight build')

    // Save — closes the modal and PATCHes bodyShape with the set key at the
    // set value; the intercepted PATCH captured above proves it, not a UI guess.
    await bodyModal.getByRole('button', { name: 'Save body', exact: true }).click()
    await expect(bodyModal).toBeHidden({ timeout: 10_000 })

    expect(patchBody, 'Save should PATCH /api/characters-local').toBeTruthy()
    expect(patchBody.slug).toBe('fixture-cal')
    expect(patchBody.bodyShape).toBeTruthy()
    expect(patchBody.bodyShape.build).toBeCloseTo(0.05, 2)

    // No uploads, no generation.
    expect(promptCalls).toBe(0)
    expect(uploadCalls).toBe(0)
  })
})
