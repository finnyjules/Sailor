import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { PNG } from 'pngjs'

// Frame Templates E2E (Task 9 of the Frame Templates feature). Tasks 6-8 built
// the UI (CompositorModal's "Templates" panel + slot-fill/freeze panel) and the
// pure lib (lib/frametemplate/{types,author,apply}.ts) that back it; each is
// covered by its own unit spec (frametemplate-{author,apply,store,update}.unit.
// spec.ts). None of those prove the RUNTIME wiring: that placing a template
// really lands pixels on the canvas, that a fill really reaches both the layer
// AND the persisted instance, that undo reverts them TOGETHER (not just one),
// and that a reshaped template really leaves an existing copy alone. This spec
// drives the real feature end-to-end through /dev/frame-lab, which mounts the
// REAL CompositorModal over a real Frame node (see app/pages/dev/frame-lab.vue)
// and exposes `window.__frameLab = { node, nodes, edges, save, reset }` for
// state assertions alongside pixel assertions on the real stack canvas.
//
// The stack canvas (`[data-testid="compositor-stack-canvas"]`) is a plain 2D
// canvas — unlike the WebGL renders in timeline-clip-edit.spec.ts, re-rendering
// the SAME state twice is expected to be byte-identical (no GPU nondeterminism),
// so NOISE_CEIL is calibrated tight and SIGNAL_FLOOR is calibrated from the
// logged diffs of the real edits below (each mutation is a full-frame duplicate
// or a whole-slot re-color, so the signal is large relative to noise).
test.describe.configure({ timeout: 180_000 })

function pngOf(dataUrl: string): PNG {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'))
}

function meanDiff(aUrl: string, bUrl: string): number {
  const a = pngOf(aUrl)
  const b = pngOf(bUrl)
  if (a.width !== b.width || a.height !== b.height) return 1
  let sum = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c]! - b.data[i + c]!) / 255
      n++
    }
  }
  return sum / n
}

/** Data-URL snapshot of the compositor's unified stack canvas (mirrors
 *  tests/compositor-post-effects.spec.ts's `stackPixels`: the layers→stack
 *  watch in CompositorModal.vue is async and undebounced, so give it a beat). */
async function stackPixels(page: Page): Promise<string> {
  await page.waitForTimeout(500)
  return await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    return cv.toDataURL()
  })
}

/** Read the live frame state off the dev-harness handle: the real
 *  `sailor_localLayers` array and the real `sailor_frametemplates` instances. */
async function frameState(page: Page): Promise<{ layers: any[]; templates: any[] }> {
  return await page.evaluate(() => {
    const fl = (window as any).__frameLab
    const props = fl.node.data.properties
    return { layers: props.sailor_localLayers ?? [], templates: props.sailor_frametemplates ?? [] }
  })
}

/** Click a layer row in the left panel by its exact rendered label. Rows render
 *  `layer.text` (for text layers) with no override, so as long as the label is
 *  unique in the current frame this reaches the same `onRowClick` the real UI
 *  uses (marks a slot while the save-template sheet is open, else selects). */
async function clickLayerRow(page: Page, label: string) {
  // Scoped to the LEFT layer panel: the right panel can show the same text as
  // a slot LABEL (e.g. "Plain text", defaulted from the layer's own content)
  // while a placed instance's fill panel is open, which would otherwise match too.
  await page.locator('[data-testid="compositor-left-panel"]').getByText(label, { exact: true }).click()
}

async function getTemplate(request: APIRequestContext, baseURL: string, id: string): Promise<any> {
  const res = await request.get(`${baseURL}/api/frame-templates`)
  expect(res.ok()).toBeTruthy()
  const { templates } = await res.json()
  const t = templates.find((x: any) => x.id === id)
  expect(t, `template ${id} must exist in the library`).toBeTruthy()
  return t
}

async function putTemplate(request: APIRequestContext, baseURL: string, template: any): Promise<void> {
  const res = await request.put(`${baseURL}/api/frame-templates/${template.id}`, { data: template })
  expect(res.ok()).toBeTruthy()
}

test.describe('Frame Templates — place / fill / restyle-update / reshape-skip / freeze', () => {
  const runId = `e2e-${Date.now().toString(36)}`
  const templateName = `E2E Card ${runId}`
  let templateId: string | null = null

  test.afterAll(async ({ request, baseURL }) => {
    // Clean up: the file-backed library at server/frame-templates/ is shared
    // across every dev server running from this checkout (parallel sessions
    // included), so leave nothing behind.
    if (templateId) {
      await request.delete(`${baseURL}/api/frame-templates/${templateId}`).catch(() => {})
    }
  })

  test('save, place, fill, restyle-update, reshape-skip, freeze, undo — all pixel- and state-verified', async ({ page, request, baseURL }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]', { timeout: 30_000 })
    const canvas = page.locator('[data-testid="compositor-stack-canvas"]')
    await canvas.waitFor({ state: 'visible', timeout: 15_000 })

    // ── Calibrate the noise floor: two captures of the SAME state must be
    // near-identical (2D canvas, no GPU nondeterminism — unlike the WebGL
    // renders in timeline-clip-edit.spec.ts). ──────────────────────────────
    const calibA = await stackPixels(page)
    const calibB = await stackPixels(page)
    const noise = meanDiff(calibA, calibB)
    console.log(`[frame-templates] no-op re-render mean diff = ${noise.toFixed(5)}`)
    const NOISE_CEIL = 0.01
    expect(noise, 'two renders of the same state must be near-identical').toBeLessThan(NOISE_CEIL)

    // ── Phase 1: author a template with one TEXT slot on the unique "Plain
    // text" layer from the frame-lab fixture. ──────────────────────────────
    await page.locator('[data-testid="templates-toggle"]').click()
    await page.locator('[data-testid="template-save-start"]').click()
    await page.locator('[data-testid="template-name-input"]').fill(templateName)
    await clickLayerRow(page, 'Plain text') // marks it as a slot (savingTemplate mode intercepts the click)
    await expect(page.locator('[data-testid="template-slot-picks"]')).toBeVisible()

    const putPromise = page.waitForResponse(resp => resp.url().includes('/api/frame-templates/') && resp.request().method() === 'PUT')
    await page.locator('[data-testid="template-save-confirm"]').click()
    await putPromise

    const listed = await getTemplate(request, baseURL!, (await (async () => {
      // We don't know the UI-minted id yet — look it up by name.
      const res = await request.get(`${baseURL}/api/frame-templates`)
      const { templates } = await res.json()
      const t = templates.find((x: any) => x.name === templateName)
      expect(t, 'the just-saved template must be findable by name').toBeTruthy()
      return t.id
    })()))
    templateId = listed.id
    expect(listed.version).toBe(1)
    expect(listed.slots).toHaveLength(1)
    const slotId = listed.slots[0].id

    // Delete the ORIGINAL "Plain text" layer so every future match of that
    // label refers unambiguously to a PLACED COPY (the template already holds
    // its own independent clone — deleting the live layer doesn't touch it).
    await clickLayerRow(page, 'Plain text')
    await page.keyboard.press('Delete')
    let state = await frameState(page)
    expect(state.layers.some((l: any) => l.text === 'Plain text')).toBe(false)

    // ── Phase 2: place a copy (Instance A) — proves placement changes pixels. ─
    const beforePlace = await stackPixels(page)
    await page.locator('[data-testid="template-place"]').click()
    const afterPlace = await stackPixels(page)
    const placeDiff = meanDiff(beforePlace, afterPlace)
    console.log(`[frame-templates] place mean diff = ${placeDiff.toFixed(5)}`)
    // Placing duplicates the whole captured frame on top of itself — a huge,
    // unambiguous signal. A single slot/layer edit touches far fewer pixels
    // (a headline's glyphs, or one rect's fill), so it gets its own, smaller
    // floor — both are calibrated from the diffs logged above/below, with a
    // wide margin over the measured 0.00000 noise floor.
    const SIGNAL_FLOOR = 0.05
    // A single slot/layer edit (a headline's glyphs, one rect's fill) touches
    // far fewer pixels than a whole-frame placement — measured ~0.0037-0.0121
    // below, comfortably above the 0.00000 noise floor.
    const EDIT_SIGNAL_FLOOR = 0.001
    expect(placeDiff, 'placing a template copy must change the composite').toBeGreaterThan(SIGNAL_FLOOR)

    state = await frameState(page)
    expect(state.templates).toHaveLength(1)
    const instanceAId = state.templates[0].instanceId
    expect(state.templates[0].templateVersion).toBe(1)

    // Close the templates panel — the slot-fill/freeze panel only renders when
    // it's closed (both live in the same v-else-if chain in the right panel).
    await page.locator('[data-testid="templates-toggle"]').click()

    // Select Instance A's placed slot layer (currently labeled "Plain text",
    // now unique again since the original was deleted) and fill its text slot.
    await clickLayerRow(page, 'Plain text')
    await expect(page.locator('[data-testid="template-instance-slots"]')).toBeVisible()

    const beforeFillA = await stackPixels(page)
    const slotInput = page.locator('[data-testid="template-slot-text"]')
    await slotInput.fill('FILLED HEADLINE')
    await page.keyboard.press('Tab') // blur → fires the input's @change handler
    const afterFillA = await stackPixels(page)
    const fillDiff = meanDiff(beforeFillA, afterFillA)
    console.log(`[frame-templates] fill-slot mean diff = ${fillDiff.toFixed(5)}`)
    expect(fillDiff, 'filling a text slot must change the composite').toBeGreaterThan(EDIT_SIGNAL_FLOOR)

    state = await frameState(page)
    let instA = state.templates.find((i: any) => i.instanceId === instanceAId)
    expect(instA.slotValues[slotId]).toBe('FILLED HEADLINE')
    const slotLayerA = state.layers.find((l: any) => l.id === instA.placedKeys[listed.slots[0].layerKey])
    expect(slotLayerA.text).toBe('FILLED HEADLINE')

    // ── Phase 3: place a SECOND copy (Instance B) for the undo-atomicity test,
    // fill its slot too, then undo — BOTH the layer pixels/text AND the
    // instance's persisted slotValue must revert together. This is the case
    // most likely to hide a real bug: the editor's history snapshot must
    // capture `sailor_frametemplates` alongside `sailor_localLayers`. ────────
    await page.locator('[data-testid="templates-toggle"]').click()
    await page.locator('[data-testid="template-place"]').click() // Instance B — its slot defaults back to the template's own text, "Plain text"
    await page.locator('[data-testid="templates-toggle"]').click()

    state = await frameState(page)
    expect(state.templates).toHaveLength(2)
    const instanceBId = state.templates.find((i: any) => i.instanceId !== instanceAId).instanceId

    await clickLayerRow(page, 'Plain text') // now uniquely Instance B's slot layer
    await expect(page.locator('[data-testid="template-instance-slots"]')).toBeVisible()

    const beforeFillB = await stackPixels(page)
    await page.locator('[data-testid="template-slot-text"]').fill('UNDO ME')
    await page.keyboard.press('Tab')
    const afterFillB = await stackPixels(page)
    expect(meanDiff(beforeFillB, afterFillB), 'filling instance B\'s slot must change pixels').toBeGreaterThan(EDIT_SIGNAL_FLOOR)

    state = await frameState(page)
    let instB = state.templates.find((i: any) => i.instanceId === instanceBId)
    expect(instB.slotValues[slotId]).toBe('UNDO ME')

    // Undo (toolbar button — deterministic across host OS, unlike a Meta/Ctrl
    // keypress). One undo pops exactly the fill (placement was a separate,
    // earlier history step).
    await page.locator('button[title="Undo (⌘Z)"]').click()
    const afterUndoB = await stackPixels(page)
    const undoDiff = meanDiff(afterUndoB, beforeFillB)
    console.log(`[frame-templates] undo reverts to pre-fill, diff = ${undoDiff.toFixed(5)} (vs filled state: ${meanDiff(afterUndoB, afterFillB).toFixed(5)})`)
    expect(undoDiff, 'undo must revert the pixels to the pre-fill state').toBeLessThan(NOISE_CEIL)
    expect(meanDiff(afterUndoB, afterFillB), 'undo must visibly differ from the filled state').toBeGreaterThan(EDIT_SIGNAL_FLOOR)

    state = await frameState(page)
    instB = state.templates.find((i: any) => i.instanceId === instanceBId)
    expect(instB.slotValues[slotId], 'undo must revert the PERSISTED slot value').toBe('Plain text')
    const slotLayerB = state.layers.find((l: any) => l.id === instB.placedKeys[listed.slots[0].layerKey])
    expect(slotLayerB.text, 'undo must revert the LAYER text — atomically with slotValues').toBe('Plain text')

    // ── Phase 4: restyle-update (v2). Bump the template's version with a
    // change to a LOCKED (non-slot) layer's fill — via the store directly, the
    // way a second editor session would land a v2 (no UI gesture for "re-save
    // over an existing template" exists yet). Instance A's already-filled slot
    // value must SURVIVE the update while the locked layer's new fill lands. ─
    const restyledColor = '#ff2d55'
    const t2 = await getTemplate(request, baseURL!, templateId!)
    const lockedEntry = t2.layers.find((tl: any) => tl.layer.id === 'strokecenter')
    expect(lockedEntry, 'fixture must still have the strokecenter locked layer captured in the template').toBeTruthy()
    expect(lockedEntry.layer.fill).not.toBe(restyledColor)
    lockedEntry.layer.fill = restyledColor
    t2.version = t2.version + 1
    await putTemplate(request, baseURL!, t2)

    // Trigger the update path: CompositorModal's onMounted re-checks staleness
    // and re-pulls the library, so close + reopen the modal (frame-lab's own
    // toggle) rather than a full page reload — a reload would drop the undo
    // history / selection state we're relying on above being real, not just
    // re-derived from scratch.
    await page.locator('[data-testid="frame-lab-toggle-modal"]').click() // close
    await page.locator('[data-testid="frame-lab-toggle-modal"]').click() // reopen
    await canvas.waitFor({ state: 'visible', timeout: 15_000 })
    await expect(page.locator('[data-testid="template-update-banner"]')).toBeVisible({ timeout: 10_000 })

    const beforeUpdate = await stackPixels(page)
    await page.locator('[data-testid="template-update-banner"]').getByText('Update all').click()
    const afterUpdate = await stackPixels(page)
    const updateDiff = meanDiff(beforeUpdate, afterUpdate)
    console.log(`[frame-templates] restyle-update mean diff = ${updateDiff.toFixed(5)}`)
    expect(updateDiff, 'a restyle update must change the locked layer\'s pixels').toBeGreaterThan(EDIT_SIGNAL_FLOOR)

    state = await frameState(page)
    instA = state.templates.find((i: any) => i.instanceId === instanceAId)
    expect(instA.templateVersion, 'instance A must move to v2').toBe(2)
    expect(instA.slotValues[slotId], 'the filled slot value must SURVIVE the restyle update').toBe('FILLED HEADLINE')
    const updatedSlotLayerA = state.layers.find((l: any) => l.id === instA.placedKeys[listed.slots[0].layerKey])
    expect(updatedSlotLayerA.text, 'the slot LAYER text must also survive').toBe('FILLED HEADLINE')
    const updatedLockedLayerA = state.layers.find((l: any) => l.id === instA.placedKeys[lockedEntry.key])
    expect(updatedLockedLayerA.fill, 'the locked layer must pick up the new template fill').toBe(restyledColor)

    // Instance B rode along too (both were stale-and-compatible at v1→v2).
    instB = state.templates.find((i: any) => i.instanceId === instanceBId)
    expect(instB.templateVersion).toBe(2)

    // ── Phase 5: reshape (v3) — remove the template's only slot. Both existing
    // copies become slot-INCOMPATIBLE (their slotKinds keys no longer match the
    // template's), so staleInstances must exclude them: no update offered, and
    // both copies stay exactly as they are at v2. ──────────────────────────────
    const t3 = await getTemplate(request, baseURL!, templateId!)
    t3.slots = []
    t3.version = t3.version + 1
    await putTemplate(request, baseURL!, t3)

    await page.locator('[data-testid="frame-lab-toggle-modal"]').click()
    await page.locator('[data-testid="frame-lab-toggle-modal"]').click()
    await canvas.waitFor({ state: 'visible', timeout: 15_000 })
    // Give the onMounted refresh a moment, then assert no banner — a reshaped
    // template must not offer an update to either existing copy.
    await page.waitForTimeout(800)
    await expect(page.locator('[data-testid="template-update-banner"]')).toHaveCount(0)

    const afterReshape = await stackPixels(page)
    expect(meanDiff(afterUpdate, afterReshape), 'a reshape that offers no update must leave existing copies\' pixels untouched').toBeLessThan(NOISE_CEIL)

    state = await frameState(page)
    instA = state.templates.find((i: any) => i.instanceId === instanceAId)
    instB = state.templates.find((i: any) => i.instanceId === instanceBId)
    expect(instA.templateVersion, 'instance A must stay pinned at v2 — reshape must not silently apply').toBe(2)
    expect(instB.templateVersion, 'instance B must stay pinned at v2 too').toBe(2)
    const untouchedSlotLayerA = state.layers.find((l: any) => l.id === instA.placedKeys[listed.slots[0].layerKey])
    expect(untouchedSlotLayerA.text, 'instance A\'s content must be untouched by the reshape').toBe('FILLED HEADLINE')

    // ── Phase 6: freeze instance A — drops its instance card but leaves its
    // layers exactly as they are (a placed copy is a real editable one). ──────
    await clickLayerRow(page, 'FILLED HEADLINE') // instance A's slot layer, unique label
    await expect(page.locator('[data-testid="template-instance-slots"]')).toBeVisible()
    const beforeFreeze = await frameState(page)
    const pixelsBeforeFreeze = await stackPixels(page)

    await page.locator('[data-testid="template-freeze"]').click()

    const afterFreeze = await frameState(page)
    const pixelsAfterFreeze = await stackPixels(page)
    expect(afterFreeze.templates, 'freeze must drop the instance card').toHaveLength(beforeFreeze.templates.length - 1)
    expect(afterFreeze.templates.some((i: any) => i.instanceId === instanceAId)).toBe(false)
    expect(afterFreeze.layers.length, 'freeze must NOT remove any layers').toBe(beforeFreeze.layers.length)
    expect(meanDiff(pixelsBeforeFreeze, pixelsAfterFreeze), 'freeze is metadata-only — pixels must not change').toBeLessThan(NOISE_CEIL)
    // The frozen layer is still there, just detached — plain layer editing still works on it.
    expect(afterFreeze.layers.some((l: any) => l.text === 'FILLED HEADLINE')).toBe(true)
  })
})
