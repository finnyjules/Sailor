import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { stackPixels } from './_helpers'

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
 * The router (/api/prompt-route) and the planner (/api/agent-plan) are MOCKED with page.route() exactly like
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

/** Type a phrase into Frame's one prompt (always a full row) and submit. */
async function askAgent(page: Page, phrase: string) {
  const input = page.getByTestId('compositor-prompt-dock').getByRole('textbox', { name: 'Ask Sailor' })
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
    // The one prompt routes first; a plan goes to Frame's own agent (/api/agent-plan).
    await page.route('**/api/prompt-route', r => r.fulfill({ json: { kind: 'plan', followUps: [], credits: null } }))
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
    await page.getByTestId('compositor-prompt-dock').getByRole('button', { name: 'Approve', exact: true }).click()
    await page.evaluate(() => (window as any).__frameLab.save())
    await page.reload()
    await page.waitForSelector('[data-ready]', { timeout: 30_000 })

    await expect.poll(async () => (await motionBands(page)).map((t: any) => t.path),
      { timeout: 15_000 }).toContain('layers.L1.effects.e-grain.amount')
    expectBand(await motionBands(page))
  })

  // ── Light layers stage 4: the assistant adds, sets and animates lights ─────────────────────
  /** Seed a rect, hide the grid, then ask for night: a mocked plan of addLight + setLighting
   *  {darkness 0.85} + animateLight (brightness 0 → 3). Resolves once all three have landed. */
  async function proposeNight(page: Page) {
    await page.setViewportSize({ width: 1600, height: 1100 })
    if (await page.getByTestId('compositor-grid-overlay').count()) {     // ⇧G: no grid lines in the pixels
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await page.keyboard.press('Shift+G')
      await expect(page.getByTestId('compositor-grid-overlay')).toHaveCount(0)
    }
    await seedSingleLayer(page, {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.6, w: 0.4, h: 0.2, rotation: 0, opacity: 1,
      fill: '#e0b040', stroke: '', strokeWidth: 0, radius: 0,
    })
    const before = await frameProps(page)
    const pixels0 = await stackPixels(page)
    const far0 = await lum(page, FAR)
    let planned = 0
    await page.route('**/api/agent-plan', async (route) => {
      planned++
      await route.fulfill({ json: { text: planText([
        { op: 'addLight', args: { id: 'lamp', type: 'lamp', x: 0.15, y: 0.35, color: '#ffb066' } },
        { op: 'setLighting', args: { darkness: 0.85 } },
        { op: 'animateLight', target: 'lamp', args: { key: 'brightness', from: 0, to: 3 } },
      ], 'A warm lamp at night.') } })
    })
    await askAgent(page, 'make it night with a warm lamp that fades in')
    await expect.poll(async () => (await layers(page)).map((l: any) => l.kind), { timeout: 15_000 }).toEqual(['rect', 'light'])
    await expect.poll(async () => (await frameProps(page)).lighting?.darkness, { timeout: 10_000 }).toBe(0.85)
    await expect.poll(async () => (await frameProps(page)).motionx, { timeout: 10_000 }).toContain('layers.lamp.light.brightness')
    expect(planned).toBe(1)
    return { before, pixels0, far0 }
  }
  const frameProps = (page: Page) => page.evaluate(() => {
    const p = (window as any).__frameLab.node.data.properties
    return { lighting: p.sailor_localLighting ?? null, motionx: (p.sailor_motion?.motionx ?? []).map((t: any) => t.path) as string[] }
  })
  /** The Frame's far corner from the lamp (fractions of the stack canvas). */
  const FAR = [0.82, 0.04, 0.97, 0.3]
  /** Mean luminance of a region (fractions) of the stack canvas, read through a copy. */
  const lum = (page: Page, b: number[]) => page.evaluate((b) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
    const g = c.getContext('2d')!; g.drawImage(cv, 0, 0)
    const [x0, y0, x1, y1] = [b[0]! * c.width, b[1]! * c.height, b[2]! * c.width, b[3]! * c.height].map(Math.round)
    const d = g.getImageData(x0!, y0!, x1! - x0!, y1! - y0!).data
    let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    return Math.round((s / (d.length / 4)) * 100) / 100
  }, b)
  const SHOTS = process.env.LL4_SHOTS ?? 'test-results/agent-lights'

  test('lights: a mocked plan adds a lamp, darkens the Frame and its band shows in the Motion tab (light layers stage 4)', async ({ page }) => {
    await mkdir(SHOTS, { recursive: true })
    const { far0 } = await proposeNight(page)
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    await stackPixels(page)
    const far1 = await lum(page, FAR)
    console.log('[agent lights] far corner luminance before', far0, 'after', far1, '| lighting', JSON.stringify((await frameProps(page)).lighting))
    expect(far1).toBeLessThan(far0 * 0.8)          // the Frame darkened away from the lamp (the lab background is dark already)
    await page.screenshot({ path: `${SHOTS}/6-assistant-proposal.png` })
    // Approve (the tabs wait on an open proposal); the band is on the lamp's row in the Motion tab.
    await page.getByTestId('compositor-prompt-dock').getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByRole('button', { name: 'Motion', exact: true }).click()
    await expect(page.getByTestId('band-layers.lamp.light.brightness')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/6-assistant-band-in-motion.png` })
  })

  test('lights: one undo after approving removes the lamp, the Darkness and the band together (light layers stage 4)', async ({ page }) => {
    // KNOWN BUG (found by this check, 2026-10-01): a Frame assistant proposal records no undo
    // step of its own (useCompositorAgent / CompositorModal setState never call recordHistory).
    // setState's `editor.setLighting` records one AFTER `commit(s.layers)` has already put the
    // lamp in, so the only undo step restores the old Darkness and drops the band but keeps the
    // lamp — and no later ⌘Z can remove it. Remove `test.fail` once a proposal is one undo step.
    test.fail()
    const { before, pixels0 } = await proposeNight(page)
    await page.getByTestId('compositor-prompt-dock').getByRole('button', { name: 'Approve', exact: true }).click()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(800)
    const after = { kinds: (await layers(page)).map((l: any) => l.kind), ...(await frameProps(page)) }
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(800)
    const after2 = { kinds: (await layers(page)).map((l: any) => l.kind), ...(await frameProps(page)) }
    console.log('[agent lights undo] before', JSON.stringify(before), '| after one undo', JSON.stringify(after), '| after a second undo', JSON.stringify(after2))
    expect(after.kinds).toEqual(['rect'])
    expect(after.motionx).not.toContain('layers.lamp.light.brightness')
    expect(after.lighting?.darkness ?? null).toBe(before.lighting?.darkness ?? null)
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    expect(await stackPixels(page)).toBe(pixels0)
  })
})
