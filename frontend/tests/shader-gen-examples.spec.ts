import { expect, test, type Page, type Route } from '@playwright/test'
import { openStudio } from './_helpers'
import { FOGGED_GLASS, PRODUCT_EXAMPLES, SUMINAGASHI } from '../app/lib/shadergen/productExamples'
import { SPIKE_TAKES } from '../app/lib/shadergen/__eval__/spikeTakes'

/**
 * The product's two fixed examples (2026-09-26) pass the REAL checks — the seamless-loop check
 * included — in the REAL browser renderer, directly and through the product path with
 * /api/shader-gen mocked to answer with them. Spends nothing: every model route is guarded.
 */

test.setTimeout(180_000)

const withDefaults = <T extends { params: any[] }>(t: T, d: Record<string, number>): T => ({ ...t, params: t.params.map(p => (p.uniform in d ? { ...p, default: d[p.uniform] } : p)) })

/** The take renderer on a photo-like picture; each take's flags (or its compile error). */
async function judge(page: Page, takes: unknown[]): Promise<{ pass?: boolean; flags?: string[]; err?: string }[]> {
  await page.goto('/_nuxt/lib/shadergen/browserRenderer.ts')
  return page.evaluate(async (takes) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 384
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 512, 384); g.addColorStop(0, '#20324a'); g.addColorStop(1, '#e0b080')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 384)
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${(i * 37) % 360} 50% ${30 + (i % 40)}%)`; ctx.fillRect((i * 7919) % 512, (i * 104729) % 384, 40, 30) }
    const { createBrowserTakeRenderer } = await import('/_nuxt/lib/shadergen/browserRenderer.ts' as string)
    const r = createBrowserTakeRenderer(c)
    const out = takes.map((t: any) => { const take = { ...t }; const err = r.compile(take); if (err) return { err }; const j = r.judge(take); return { pass: j.pass, flags: j.flags } })
    r.dispose?.()
    return out
  }, takes)
}

test('the examples pass every check in the take renderer, the loop check included, at their defaults and across their dials', async ({ page }) => {
  const takes = [
    FOGGED_GLASS, SUMINAGASHI,
    withDefaults(FOGGED_GLASS, { u_speed: 2 }), withDefaults(FOGGED_GLASS, { u_speed: 3, u_drops: 1 }), withDefaults(FOGGED_GLASS, { u_drops: 0 }),
    withDefaults(SUMINAGASHI, { u_speed: 2 }), withDefaults(SUMINAGASHI, { u_speed: 3, u_warp: 2 }), withDefaults(SUMINAGASHI, { u_rings: 30 }),
    // The control: the spike versions they were rewritten from (raw u_time) fail the loop check.
    SPIKE_TAKES.rain![2]!, SPIKE_TAKES.ink![3]!,
  ]
  const res = await judge(page, takes)
  // "heavy" times frames and is noisy on a loaded machine (shader-gen.spec's header); every other
  // flag must be absent.
  for (const r of res.slice(0, 8)) {
    expect(r.err).toBeUndefined()
    expect(r.flags!.filter(f => f !== 'heavy')).toEqual([])
  }
  expect(res.slice(0, 2).every(r => r.pass || r.flags!.every(f => f === 'heavy'))).toBe(true)
  expect(res[8]!.flags).toContain('does not loop')
  expect(res[9]!.flags).toContain('does not loop')
})

/** Non-GET calls to a route that spends model money, queues an engine run, or writes My effects. */
const GUARDED = /^\/(prompt|api\/(prompt-route|vibe|vibe-review|vibe-recipes|vibe-pick|agent-plan|agent-review|shader-gen|my-effects|pipeline-suggest|font-suggest|copy-assist|image-search|style-profile|frame\/animate|scene3d\/(gen-[a-z0-9-]+|restyle)|inpaint|krea|vector|depth|lipsync|cloud-train|voice-clone|runs)(\/.*)?)$/
const settle = (r: Route, reply: Parameters<Route['fulfill']>[0]) => r.fulfill(reply).catch(() => {})

test('through the product path: /api/shader-gen answers with the examples, and every take lands', async ({ page }) => {
  const leaked: string[] = []
  await page.route(url => GUARDED.test(url.pathname), async (r) => {
    const req = r.request()
    if (req.method() === 'GET' && !new URL(req.url()).pathname.startsWith('/api/my-effects')) return r.fallback()
    leaked.push(`${req.method()} ${new URL(req.url()).pathname}`)
    return r.abort()
  })
  await page.route('**/api/my-effects**', r => settle(r, { json: { effects: [] } }))
  await page.route('**/api/prompt-route', r => settle(r, { json: { kind: 'new-effect', followUps: [], credits: null } }))
  const calls: any[] = []
  const perSlot = [FOGGED_GLASS, SUMINAGASHI, FOGGED_GLASS]
  await page.route('**/api/shader-gen', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const slot = (Number(/Take (\d):/.exec(String(body.prompt ?? ''))?.[1] ?? 1) - 1) % 3
    await settle(r, { json: { text: JSON.stringify(perSlot[slot]), usage: { input_tokens: 2600, output_tokens: 3000 }, stop_reason: 'end_turn', credits: null } })
  })
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-shadergen') } catch {} })
  const warnings: string[] = []
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[shader-gen]')) warnings.push(m.text()) })

  await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
  await page.getByRole('button', { name: 'Add layer' }).click()
  await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
  const box = page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })
  await box.fill('rain on a window'); await box.press('Enter')
  await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 20_000 })
  const tile = (s: string) => page.locator(`[data-testid="prompt-take-tile"][data-state="${s}"]`)
  await expect(tile('pending')).toHaveCount(0, { timeout: 90_000 })
  // Each slot's one answer passed on the first call: nothing was sent back, nothing failed.
  expect(warnings).toEqual([])
  await expect(tile('ready')).toHaveCount(3)
  expect(calls).toHaveLength(3)
  // The brief the model was sent: the examples as they are now, and what the take is for.
  for (const b of calls) {
    const p = String(b.prompt)
    expect(p).toContain('Request: "rain on a window"')
    expect(p).toContain('It is for a layer in Sailor’s Shader studio')
    expect(p).toContain(`"${PRODUCT_EXAMPLES[0]!.request}" (rain, over the picture) — "Fogged glass"`)
    expect(p).toContain(`"${PRODUCT_EXAMPLES[1]!.request}" (ink, standalone) — "Suminagashi"`)
    expect(p).not.toMatch(/predate|written before the loop rule/)
  }
  expect(leaked).toEqual([])
})
