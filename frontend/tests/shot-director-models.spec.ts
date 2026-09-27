import { test, expect, type Page, type Route } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * Shot Director per-model cast payloads, end to end (characters stage 3,
 * Task 11).
 *
 * Drives the real Shot Director surface: cast a character, pick Kling 3, make
 * a preview frame from the cast, use it as the first frame, Generate — then
 * switch to Veo 3.1, go back to references, Generate again. Each run is caught
 * at the network edge (the runner's `POST /api/runs`, or ComfyUI's `/prompt`
 * when the runner doesn't take the workflow) and the Film a shot node's
 * inputs are read from the captured body — what would actually leave the
 * browser, not a guess at the node's widgets.
 *
 * Every route that could spend is mocked: the character registry is a
 * fixture (same shape as character-sheet.spec.ts, plus a face-neutral panel),
 * the preview (`/api/inpaint/nano-gen`) returns a tiny PNG data URL, uploads
 * return a fixed name, `/view` serves the same PNG, both run routes answer
 * with a harmless fake id, take-check is stubbed, and any fal / replicate /
 * anthropic / AWS host is aborted.
 */

// 1×1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

const SHEET_FILENAME = 'sheet-cal.png'
const FACE = 'face-cal.png'
const PORTRAIT = 'portrait-cal.png'
const BODY_FRONT = 'front-cal.png'
const UPLOADED_FIRST_FRAME = 'e2e-first-frame.png'

const FIXTURE = {
  characters: [{
    name: 'Cal',
    slug: 'fixture-cal',
    states: [{
      id: 'default',
      label: 'Default',
      descriptor: 'soaked navy jacket',
      refImages: ['cover-cal.png'],
      coverIndex: 0,
      panels: [
        { slot: 'face-neutral', filename: FACE },
        { slot: 'portrait', filename: PORTRAIT },
        { slot: 'body-front', filename: BODY_FRONT },
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

interface CapturedRun { route: '/api/runs' | '/prompt'; body: any; raw: string }

const PAID_HOSTS = /(^|\.)(fal\.ai|fal\.run|fal\.media|replicate\.com|replicate\.delivery|anthropic\.com|amazonaws\.com)$/

async function mockEverything(page: Page, runs: CapturedRun[], counters: { nanoGen: number; uploads: number; takeCheck: number }) {
  // Anything bound for a paid provider straight from the browser is aborted.
  await page.route((url) => PAID_HOSTS.test(url.hostname), (route) => route.abort())

  await page.route('**/api/characters-local', async (route) => {
    const method = route.request().method()
    if (method === 'GET') await route.fulfill({ json: FIXTURE })
    else if (method === 'PATCH') await route.fulfill({ json: { ok: true } })
    else await route.continue()
  })
  await page.route('**/api/characters-local/take-check**', async (route) => {
    counters.takeCheck++
    await route.fulfill({ json: { scores: [] } })
  })
  await page.route('**/api/inpaint/nano-gen**', async (route) => {
    counters.nanoGen++
    await route.fulfill({ json: { images: [PNG_DATA_URL] } })
  })
  await page.route('**/upload/image', async (route) => {
    counters.uploads++
    await route.fulfill({ json: { name: UPLOADED_FIRST_FRAME, subfolder: '', type: 'input' } })
  })
  // Panel pictures don't exist on disk — the preview fetches them to data URLs.
  await page.route((url) => url.pathname === '/view', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }))

  const capture = async (route: Route, which: CapturedRun['route']) => {
    const raw = route.request().postData() ?? ''
    let body: any = null
    try { body = JSON.parse(raw) } catch {}
    runs.push({ route: which, body, raw })
  }
  await page.route((url) => url.pathname === '/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: {} })
    await capture(route, '/api/runs')
    const n = runs.length
    await route.fulfill({ json: { runId: `e2e-run-${n}`, legId: `e2e-leg-${n}`, promptIds: [`e2e-run-${n}.0`] } })
  })
  await page.route((url) => url.pathname === '/prompt' || url.pathname === '/api/prompt', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await capture(route, '/prompt')
    await route.fulfill({ json: { prompt_id: `e2e-blocked-${runs.length}`, number: 0, node_errors: {} } })
  })
}

/** The Film a shot node's API inputs, from either route's body shape. */
function filmShotInputs(run: CapturedRun): Record<string, any> {
  const prompts: any[] = run.route === '/api/runs' ? (run.body?.takes ?? []) : [run.body?.prompt]
  for (const p of prompts) {
    for (const node of Object.values<any>(p ?? {})) {
      if (node?.class_type === 'FilmShotNode') return node.inputs ?? {}
    }
  }
  throw new Error(`no FilmShotNode in the ${run.route} body`)
}

function viewUrlOf(filename: string): string {
  return `/view?${new URLSearchParams({ filename, type: 'input' })}`
}

async function openShotDirector(page: Page) {
  const card = page.locator('.vue-flow__node').filter({ hasText: 'Shot Director' }).first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.dblclick()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Shot Director' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

/** Generate, pass the app's own cost gate with a real click, and wait for the run to be caught. */
async function generateAndCapture(page: Page, dialog: ReturnType<Page['getByRole']>, runs: CapturedRun[]): Promise<CapturedRun> {
  const before = runs.length
  const generate = dialog.getByRole('button', { name: /Generate ·/ })
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  const runAnyway = page.getByRole('button', { name: 'Run anyway', exact: true })
  await expect.poll(async () => {
    if (runs.length > before) return true
    if (await runAnyway.isVisible().catch(() => false)) await runAnyway.click()
    return false
  }, { timeout: 20_000, intervals: [250, 500, 1000], message: 'Generate should send the run to /api/runs or /prompt' }).toBe(true)
  return runs[runs.length - 1]!
}

test.describe('Shot Director: each model gets its cast the way it takes it', () => {
  const runs: CapturedRun[] = []
  const counters = { nanoGen: 0, uploads: 0, takeCheck: 0 }

  test.beforeEach(async ({ page }) => {
    runs.length = 0
    counters.nanoGen = 0; counters.uploads = 0; counters.takeCheck = 0
    await mockEverything(page, runs, counters)
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await page.addStyleTag({ content: '#clerk-components { display: none !important; }' })
  })

  test('Kling 3 sends an element + made first frame; Veo 3.1 sends three pictures; never the sheet', async ({ page }) => {
    test.setTimeout(120_000)

    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'ShotDirector' } })))
    let dialog = await openShotDirector(page)

    // Cast Cal through the "+ Cast" picker.
    await dialog.getByRole('button', { name: '+ Cast', exact: true }).click()
    const picker = page.getByRole('heading', { name: 'Cast a character', exact: true })
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await page.getByText('Cal', { exact: true }).click()
    await expect(picker).toBeHidden()
    await expect(dialog.getByRole('button', { name: '×', exact: true })).toBeVisible()

    // Some words so the shot has an intent (and the preview can run).
    await dialog.getByPlaceholder('e.g. A woman in a red coat').fill('A man in a navy jacket')
    await dialog.getByPlaceholder('e.g. walks slowly toward camera').fill('walks slowly toward camera')

    // Kling 3: needs a first frame, and says so.
    await dialog.locator('select').filter({ has: page.locator('option', { hasText: 'Kling 3' }) }).selectOption({ label: 'Kling 3' })
    const klingIssue = dialog.getByText('Kling 3 needs a first frame. Make one from the cast or upload one.', { exact: true })
    await expect(klingIssue).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Generate ·/ })).toBeDisabled()

    // Make the preview from the cast (mocked nano-gen), then use it.
    await dialog.getByRole('button', { name: /Preview frame ·/ }).click()
    const useFirst = dialog.getByRole('button', { name: 'Use as first frame', exact: true })
    await expect(useFirst).toBeVisible({ timeout: 10_000 })
    expect(counters.nanoGen).toBe(1)
    await useFirst.click()
    await expect(klingIssue).toBeHidden({ timeout: 10_000 })
    expect(counters.uploads).toBe(1)

    // Run 1: Kling 3.
    const kling = await generateAndCapture(page, dialog, runs)
    const kIn = filmShotInputs(kling)
    expect(kIn.model).toBe('kling-v3')
    const kOpts = JSON.parse(kIn.model_options)
    expect(Array.isArray(kOpts.elements) && kOpts.elements.length).toBe(1)
    expect(kOpts.elements[0].frontal_image_url).toBe(viewUrlOf(FACE))
    expect(kOpts.image_url).toBe(viewUrlOf(UPLOADED_FIRST_FRAME))
    expect(kling.raw, 'the sheet grid is never sent').not.toContain(SHEET_FILENAME)

    // Veo 3.1: clear the first frame, back to references.
    dialog = await openShotDirector(page)
    await dialog.locator('select').filter({ has: page.locator('option', { hasText: 'Kling 3' }) }).selectOption({ label: 'Veo 3.1' })
    await dialog.getByRole('button', { name: 'Remove', exact: true }).first().click()
    await dialog.getByRole('button', { name: 'Reference', exact: true }).click()

    // Run 2: Veo 3.1.
    const veo = await generateAndCapture(page, dialog, runs)
    const vIn = filmShotInputs(veo)
    expect(vIn.model).toBe('veo-3.1')
    const vOpts = JSON.parse(vIn.model_options)
    expect(vOpts.image_urls).toEqual([viewUrlOf(FACE), viewUrlOf(PORTRAIT), viewUrlOf(BODY_FRONT)])
    expect(vOpts.image_url, 'references and a first frame are exclusive on Veo').toBeUndefined()
    expect(veo.raw, 'the sheet grid is never sent').not.toContain(SHEET_FILENAME)

    // Nothing else spent: one preview, one upload.
    expect(counters.nanoGen).toBe(1)
    expect(counters.uploads).toBe(1)

    test.info().annotations.push({ type: 'run routes', description: runs.map(r => r.route).join(', ') })
  })
})
