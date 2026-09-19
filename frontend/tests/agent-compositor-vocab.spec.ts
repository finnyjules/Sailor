import { expect, test, type Page } from '@playwright/test'

/**
 * Compositor agent vocabulary — the F-cap slice, proven end to end.
 *
 * Tasks 1–3 taught the compositor command surface the deferred F5–F8 vocab
 * (print recipes + luminance mask, shader/backdrop curated looks, and the novel
 * `animateDial` op). Their unit specs prove the pure surface accepts each
 * command; this spec proves the WHOLE plumbing — model plan → useCompositorAgent
 * → applyCompositorCommand → the local-layer editor → persisted node props —
 * actually lands each new-vocab command on a real frame.
 *
 * The planner (/api/agent-plan) is MOCKED with page.route() exactly like
 * agent-fastlane.spec.ts (returns { text: <json-string> } that parseAgentResponse
 * decodes into { reasoning, commands[], message }), so these are deterministic
 * and cost nothing. The visual self-review (/api/agent-review, fire-and-forget)
 * is stubbed to an empty critique so it never touches a real backend.
 *
 * Harness: the REAL CompositorModal over a real Frame node via /dev/frame-lab
 * (same as frame-templates.spec.ts). It exposes `window.__frameLab.node` so the
 * persisted `sailor_motion.motionx` can be read back — and its save()+reload path
 * proves animateDial round-trips through persistence — while `__compositorLayers`
 * / `__compositorSetLayers` read and seed the live layer stack.
 */
function planText(commands: unknown[], message = ''): string {
  return JSON.stringify({ reasoning: '', commands, message })
}

async function seedAgentKey(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-fcap') } catch {}
  })
}

/** Seed a single known layer so the mocked plan targets a stable id. Returns
 *  once the seed has round-tripped through the editor's commit (read-back). */
async function seedSingleLayer(page: Page, layer: Record<string, unknown>) {
  await page.evaluate((l) => { (window as any).__compositorSetLayers([l]) }, layer)
  await expect.poll(() => page.evaluate(() =>
    (window as any).__compositorLayers().map((x: any) => x.id)), { timeout: 10_000 })
    .toEqual([layer.id])
}

/** Expand the collapsed prompt pill, type a phrase, submit. */
async function askAgent(page: Page, phrase: string) {
  await page.locator('[data-testid="compositor-prompt-pill"]').click()
  const input = page.getByPlaceholder(/Tighten the layout/i)
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(phrase)
  await input.press('Enter')
}

const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers())
const motionBands = (page: Page) => page.evaluate(() =>
  ((window as any).__frameLab?.node?.data?.properties?.sailor_motion?.motionx) ?? [])

test.describe('Compositor agent vocabulary (F-cap)', () => {
  test.beforeEach(async ({ page }) => {
    await seedAgentKey(page)
    // The visual self-review is best-effort; stub it to an empty critique so it
    // resolves instantly and never reaches a real /api/agent-review backend.
    await page.route('**/api/agent-review', async (route) => {
      await route.fulfill({ json: { text: JSON.stringify({ assessment: '', issues: [], fixes: [] }) } })
    })
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]', { timeout: 30_000 })
    await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => page.evaluate(() => typeof (window as any).__compositorSetLayers === 'function'),
      { timeout: 10_000 }).toBe(true)
  })

  test('recipe: a mocked plan lands a risograph effect with its dials (Task 1)', async ({ page }) => {
    await seedSingleLayer(page, {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0, opacity: 1,
      fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 0,
    })
    await page.route('**/api/agent-plan', async (route) => {
      await route.fulfill({ json: { text: planText([
        { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'risograph', ink: '#2b3a8c', levels: 4, grain: 0.16, contrast: 1.12 } } },
      ]) } })
    })

    await askAgent(page, 'make this a risograph print')

    // The plan applied end to end: the layer gains a risograph effect with the
    // exact dials the plan carried (recompute → setState commits immediately).
    await expect.poll(async () => {
      const l = (await layers(page))[0]
      return (l.effects || []).map((e: any) => e.type)
    }, { timeout: 15_000 }).toContain('risograph')

    const riso = (await layers(page))[0].effects.find((e: any) => e.type === 'risograph')
    expect(riso).toMatchObject({ ink: '#2b3a8c', levels: 4, grain: 0.16, contrast: 1.12 })
  })

  test('shader look: a mocked plan lands a shader effect resolved to its effectId (Task 2)', async ({ page }) => {
    await seedSingleLayer(page, {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0, opacity: 1,
      fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 0,
    })
    await page.route('**/api/agent-plan', async (route) => {
      await route.fulfill({ json: { text: planText([
        { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'shader', look: 'liquify', speed: 1 } } },
      ]) } })
    })

    await askAgent(page, 'add a liquify shader over this')

    await expect.poll(async () => {
      const l = (await layers(page))[0]
      return (l.effects || []).map((e: any) => e.type)
    }, { timeout: 15_000 }).toContain('shader')

    const shader = (await layers(page))[0].effects.find((e: any) => e.type === 'shader')
    // A curated look WORD resolves to a real catalog effectId — never a raw id.
    expect(shader.effectId).toBe('liquify')
  })

  test('animateDial: a mocked plan authors a persisted timeline band that survives save/reload (Task 3)', async ({ page }) => {
    await seedSingleLayer(page, {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0, opacity: 1,
      fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 0,
      effects: [{ id: 'e-grain', type: 'grain', amount: 0.5, size: 3, visible: true }],
    })
    await page.route('**/api/agent-plan', async (route) => {
      await route.fulfill({ json: { text: planText([
        { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9 } },
      ]) } })
    })

    await askAgent(page, 'animate the grain from 0 to 0.9')

    // Persisted on the FRAME motion doc (not a layer prop / effect field): a plain
    // motionx band for the resolved dial path with two keyframes 0 → 0.9.
    const expectBand = (bands: any[]) => {
      const tr = bands.find((t: any) => t.path === 'layers.L1.effects.e-grain.amount')
      expect(tr, 'animateDial must author a band for the grain amount dial').toBeTruthy()
      expect(tr).toMatchObject({ path: 'layers.L1.effects.e-grain.amount', type: 'number' })
      expect(tr.keyframes.length).toBe(2)
      expect(tr.keyframes[0]).toMatchObject({ value: 0 })
      expect(tr.keyframes[tr.keyframes.length - 1]).toMatchObject({ value: 0.9 })
      expect(tr.keyframes[0].t).toBeLessThan(tr.keyframes[tr.keyframes.length - 1].t)
    }

    await expect.poll(async () => (await motionBands(page)).map((t: any) => t.path),
      { timeout: 15_000 }).toContain('layers.L1.effects.e-grain.amount')
    expectBand(await motionBands(page))

    // Finalize the proposal, then round-trip through the harness's save + reload
    // (persists node props to localStorage, reloads, restores) and re-read the
    // persisted sailor_motion — the authored band must come back intact.
    await page.getByRole('button', { name: 'Keep all' }).click()
    await page.evaluate(() => (window as any).__frameLab.save())
    await page.reload()
    await page.waitForSelector('[data-ready]', { timeout: 30_000 })

    await expect.poll(async () => (await motionBands(page)).map((t: any) => t.path),
      { timeout: 15_000 }).toContain('layers.L1.effects.e-grain.amount')
    expectBand(await motionBands(page))
  })
})
