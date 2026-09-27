import { expect, test, type Page, type Route } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStudio } from './_helpers'
import { SPIKE_TAKES } from '../app/lib/shadergen/__eval__/spikeTakes'
import { PRODUCT_EXAMPLES } from '../app/lib/shadergen/productExamples'

/**
 * The owed PAID measurement of shader generation (stage 5), through the REAL product path and the
 * REAL /api/shader-gen. SKIPPED unless SHADERGEN_LIVE=1 — it spends money.
 *
 *   SHADERGEN_LIVE=1 npx playwright test tests/shader-gen-measure.spec.ts --reporter=line
 *   (optional: SHADERGEN_API_KEY=sk-ant-… when the dev server has no NUXT_ANTHROPIC_API_KEY)
 *   SHADERGEN_ONLY=lava,prism … runs just those requests.
 *   SHADERGEN_DRY=1 … rehearses the harness for free: the route answers with the product examples.
 *
 * Six requests in the Shader studio, three takes each (the product's setting): three over a source
 * photo (one of them "loop the effect", a Remix of a My effect whose motion runs on raw u_time) and
 * three standalone. Per take it records pass/fail and why, tokens in/out, credits charged (null in
 * local mode), latency, every call's prompt size, one mid-loop PNG and a seam check (the take
 * renderer's own loop check plus the raw change masses across the wrap). Nothing is kept, so no
 * My effect is written; /api/my-effects is an in-memory mock holding the one effect to remix.
 *
 * Writes measure.json, index.html (a contact sheet) and the PNGs under
 * .superpowers/sdd/2026-09-25-ai-in-sailor-stage5-shader-gen/measure/<run>/.
 *
 * Expected cost (shared/pricing/shaderGenEstimate.ts, 3 takes): 30–63 credits a set, i.e. about
 * $0.14–$0.31 of model spend at list price (measured 2026-09-27: $0.18–0.30 a set); six sets ≈ $0.86–$1.87.
 */

const LIVE = process.env.SHADERGEN_LIVE === '1'
/** A free rehearsal of the harness itself: /api/shader-gen answers with the product examples
 *  (no model call), so the flow, the files and the contact sheet can be checked for nothing. */
const DRY = !LIVE && process.env.SHADERGEN_DRY === '1'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = resolve(HERE, '../../.superpowers/sdd/2026-09-25-ai-in-sailor-stage5-shader-gen/measure')
/** The evaluation page's test photo (pages/dev/shader-gen-eval.vue). */
const PHOTO = '/house-styles/azure-bloom/thumb-2.webp'
const OPEN_TIMEOUT_MS = 3 * 60_000

interface Req { key: string; request: string; photo: boolean; remix?: boolean }
const ALL_REQUESTS: Req[] = [
  { key: 'rain', request: 'Turn this into rain on a window', photo: true },
  { key: 'oil', request: 'Make it look like a wet oil slick on asphalt', photo: true },
  { key: 'loop-remix', request: 'Make the motion loop seamlessly', photo: true, remix: true },
  { key: 'ink', request: 'Ink bleeding into wet paper', photo: false },
  { key: 'lava', request: 'Make it a slow lava lamp', photo: false },
  { key: 'prism', request: 'prism light', photo: false },
]
/** SHADERGEN_ONLY=rain,ink runs just those (a re-run of what a slow server skipped). */
const ONLY = (process.env.SHADERGEN_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)
const REQUESTS = ONLY.length ? ALL_REQUESTS.filter(r => ONLY.includes(r.key)) : ALL_REQUESTS

/** The effect "loop the effect" remixes: the spike's lava lamp take 1, exactly as written — its
 *  motion runs on raw u_time, so it jumps at the wrap. */
const RAW_TIME_MINE = {
  id: 'mine_measurelava1', name: 'Wax lamp', from: 'Aurora', animated: true, generative: SPIKE_TAKES.lava![0]!.generative,
  createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  versions: [{ label: 'v1', body: SPIKE_TAKES.lava![0]!.body, params: SPIKE_TAKES.lava![0]!.params, values: {}, note: 'Make it a slow lava lamp', createdAt: '2026-09-26T00:00:00.000Z' }],
}

/** Non-GET calls to a route that spends model money, queues an engine run, or writes My effects —
 *  everything but /api/shader-gen, which this run lets through on purpose. */
const GUARDED = /^\/(prompt|api\/(prompt-route|vibe|vibe-review|vibe-recipes|vibe-pick|agent-plan|agent-review|pipeline-suggest|font-suggest|copy-assist|image-search|style-profile|frame\/animate|scene3d\/(gen-[a-z0-9-]+|restyle)|inpaint|krea|vector|depth|lipsync|cloud-train|voice-clone|runs)(\/.*)?)$/
const settle = (r: Route, reply: Parameters<Route['fulfill']>[0]) => r.fulfill(reply).catch(() => {})

interface Call { slot: number; promptChars: number; images: number; ms: number; status: number; usage: Record<string, number> | null; credits: number | null; stop_reason: string | null; text: string; avoid: string | null }

test.describe('shader generation: paid measurement', () => {
  test.skip(!LIVE && !DRY, 'Spends money: set SHADERGEN_LIVE=1 to run it (SHADERGEN_DRY=1 rehearses it for free).')
  test.setTimeout(REQUESTS.length * 12 * 60_000)

  test('six product requests, three takes each: pass rate, tokens, credits, latency, a mid-loop frame and a seam check per take', async ({ context }) => {
    // Routes live on the context; each request gets a fresh page (a set left open would hold a
    // "Leave site?" prompt that a navigation in the same page waits on).
    const ctx = context
    const run = new Date().toISOString().replace(/[:.]/g, '-')
    const outDir = join(OUT_ROOT, DRY ? `dry-${run}` : run)
    mkdirSync(outDir, { recursive: true })

    const leaked: string[] = []
    await ctx.route(url => GUARDED.test(url.pathname), async (r) => {
      if (r.request().method() === 'GET') return r.fallback()
      leaked.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`)
      return r.abort()
    })
    const store = new Map<string, any>([[RAW_TIME_MINE.id, RAW_TIME_MINE]])
    await ctx.route('**/api/my-effects**', async (r) => {
      const url = new URL(r.request().url())
      if (r.request().method() === 'GET' && url.pathname.endsWith('/my-effects')) return settle(r, { json: { effects: [...store.values()] } })
      const id = decodeURIComponent(url.pathname.split('/').pop()!)
      if (r.request().method() === 'GET') return settle(r, { json: store.get(id) ?? {}, status: store.has(id) ? 200 : 404 })
      leaked.push(`${r.request().method()} ${url.pathname}`) // nothing is kept in this run
      return r.abort()
    })
    // The REAL route, timed and recorded per call.
    let calls: Call[] = []
    await ctx.route('**/api/shader-gen', async (r) => {
      const body = r.request().postDataJSON()
      const prompt = String(body?.prompt ?? '')
      const slot = Number(/Take (\d):/.exec(prompt)?.[1] ?? 0) - 1
      const t0 = Date.now()
      if (DRY) {
        const take = PRODUCT_EXAMPLES[slot % 2]!.take
        const json = { text: JSON.stringify(take), usage: { input_tokens: 2600, output_tokens: 3000 }, stop_reason: 'end_turn', credits: null }
        calls.push({ slot, promptChars: prompt.length, images: body?.images?.length ?? 0, ms: Date.now() - t0, status: 200, usage: json.usage, credits: null, stop_reason: 'end_turn', text: json.text, avoid: null })
        return settle(r, { json })
      }
      const res = await r.fetch({ timeout: 180_000 })
      const ms = Date.now() - t0
      let json: any = null
      try { json = await res.json() } catch { /* an error page */ }
      calls.push({
        slot, promptChars: prompt.length, images: body?.images?.length ?? 0, ms, status: res.status(),
        usage: json?.usage ?? null, credits: json?.credits ?? null, stop_reason: json?.stop_reason ?? null, text: String(json?.text ?? ''),
        avoid: /A previous attempt failed: ([^\n]*)/.exec(prompt)?.[1] ?? (prompt.includes('Your previous reply for this take was rejected') ? 'repair' : null),
      })
      await r.fulfill({ response: res }).catch(() => {})
    })
    const key = process.env.SHADERGEN_API_KEY
    if (key) await ctx.addInitScript((k) => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', k) } catch {} }, key)
    let warnings: string[] = []

    const photoBytes = await (await ctx.request.get(PHOTO)).body()
    const results: any[] = []
    let page: Page | null = null
    for (const req of REQUESTS) {
      calls = []; warnings = []
      // Opening the studio waits on the page's load state, which a loaded dev server can hold for
      // good: bound it, try once more on a fresh page, then record the request as not run.
      let opened = false
      for (let attempt = 0; attempt < 2 && !opened; attempt++) {
        await page?.close({ runBeforeUnload: false }).catch(() => {})
        page = await ctx.newPage()
        page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[shader-gen]')) warnings.push(m.text()) })
        const p = page
        opened = await Promise.race([
          openStudio(p, 'ShaderStudio', 'sailor:openShaderStudio').then(() => true, () => false),
          new Promise<boolean>(res => setTimeout(() => res(false), OPEN_TIMEOUT_MS)),
        ])
      }
      if (!opened || !page) {
        results.push({ ...req, setMs: 0, notRun: 'the Shader studio did not open (dev server too slow)', takes: [] })
        writeFileSync(join(outDir, 'measure.json'), JSON.stringify({ run, requests: results }, null, 2))
        continue
      }
      if (req.photo) {
        await page.locator('label', { hasText: 'Upload image' }).locator('input[type="file"]').setInputFiles({ name: 'photo.webp', mimeType: 'image/webp', buffer: photoBytes })
        await page.waitForTimeout(1500) // the studio decodes the upload and redraws its source frame
      }
      if (req.remix) {
        await page.getByTestId('studio-inspector-head').getByRole('button', { name: 'Change effect' }).click()
        const card = page.getByTestId('effect-gallery').locator(`[data-effect-id="${RAW_TIME_MINE.id}~v1"]`)
        await card.hover()
        await card.locator('xpath=../..').getByTestId('effect-gallery-remix').click()
        await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
      } else {
        await page.getByRole('button', { name: 'Add layer' }).click()
        await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
        await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
      }
      const box = page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })
      const t0 = Date.now()
      await box.fill(req.request); await box.press('Enter')
      await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(0, { timeout: 11 * 60_000 })
      const setMs = Date.now() - t0

      const takes = [0, 1, 2].map((slot) => {
        const mine = calls.filter(c => c.slot === slot)
        const failure = warnings.find(w => w.includes(`take ${slot + 1} didn`))
        const last = mine.at(-1)
        const sum = (f: (u: Record<string, number>) => number) => mine.reduce((n, c) => n + (c.usage ? f(c.usage) : 0), 0)
        return {
          slot: slot + 1,
          pass: !failure && !!last,
          failure: failure ? failure.replace(/^.*?:\s*/, '') : null,
          calls: mine.length,
          attempts: mine.map(c => ({ ms: c.ms, status: c.status, promptChars: c.promptChars, images: c.images, stop_reason: c.stop_reason, usage: c.usage, credits: c.credits, retryReason: c.avoid })),
          tokensIn: sum(u => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)),
          tokensOut: sum(u => u.output_tokens ?? 0),
          credits: mine.some(c => c.credits != null) ? mine.reduce((n, c) => n + (c.credits ?? 0), 0) : null,
          latencyMs: mine.reduce((n, c) => n + c.ms, 0),
          take: !failure && last ? safeParse(last.text) : null,
        }
      })
      // A mid-loop frame (t = LOOP / 2) and the seam check, on the picture the takes were judged on.
      const renders = await renderTakes(page, takes.map(t => t.take), req.photo ? `data:image/webp;base64,${photoBytes.toString('base64')}` : null)
      takes.forEach((t, i) => {
        const r = renders[i]
        if (r?.png) { const file = `${req.key}-take${t.slot}.png`; writeFileSync(join(outDir, file), Buffer.from(r.png.split(',')[1]!, 'base64')); (t as any).png = file }
        ;(t as any).seam = r ? { flags: r.flags, seamless: r.seamless, wrapMass: r.wrap, ordinaryMass: r.ordinary, noiseMass: r.noise } : null
        if (t.take) (t as any).take = { name: t.take.name, generative: t.take.generative, animated: t.take.animated, params: t.take.params, body: t.take.body }
      })
      results.push({ ...req, setMs, takes })
      writeFileSync(join(outDir, 'measure.json'), JSON.stringify({ run, requests: results }, null, 2))
    }

    const all = results.flatMap(r => r.takes)
    const summary = {
      requestsRun: results.filter(r => !r.notRun).length,
      takes: all.length,
      passed: all.filter(t => t.pass).length,
      seamless: all.filter(t => t.seam?.seamless).length,
      calls: all.reduce((n, t) => n + t.calls, 0),
      tokensIn: all.reduce((n, t) => n + t.tokensIn, 0),
      tokensOut: all.reduce((n, t) => n + t.tokensOut, 0),
      credits: all.some(t => t.credits != null) ? all.reduce((n, t) => n + (t.credits ?? 0), 0) : null,
      medianSetMs: median(results.map(r => r.setMs)),
    }
    writeFileSync(join(outDir, 'measure.json'), JSON.stringify({ run, summary, requests: results }, null, 2))
    writeFileSync(join(outDir, 'index.html'), contactSheet(run, summary, results))
    console.log(`[measure] ${outDir}\n${JSON.stringify(summary)}`)
    expect(leaked).toEqual([])
  })
})

function safeParse(text: string): any { try { return JSON.parse(text) } catch { return null } }
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0 }

/** Each passing take at t = LOOP / 2 (the take renderer's own thumbnail frame, u_loop = 4), plus
 *  the loop check's frames: the change across the wrap against an ordinary step of the same size. */
async function renderTakes(page: Page, takes: any[], photo: string | null) {
  return page.evaluate(async ({ takes, photo }) => {
    const { createBrowserTakeRenderer, JUDGE_LOOP, LOOP_STEP } = await import('/_nuxt/lib/shadergen/browserRenderer.ts' as string)
    const { placeholderSource } = await import('/_nuxt/lib/shadergen/productRequest.ts' as string)
    const { changeMass, loopsSeamlessly } = await import('/_nuxt/lib/shadergen/renderChecks.ts' as string)
    const { toEffectDef } = await import('/_nuxt/lib/shadergen/effectDef.ts' as string)
    const { ShaderFxRenderer, expandPasses } = await import('/_nuxt/lib/shaderfx/renderer.ts' as string)
    const { resolveUniforms } = await import('/_nuxt/lib/shaderfx/params.ts' as string)
    let src: HTMLImageElement | HTMLCanvasElement = placeholderSource()
    if (photo) { const img = new Image(); img.src = photo; await img.decode(); src = img }
    const judge = createBrowserTakeRenderer(src)
    const raw = new ShaderFxRenderer()
    const out = takes.map((take: any, i: number) => {
      if (!take) return null
      try {
        if (judge.compile(take)) return null
        const j = judge.judge(take)
        const def = toEffectDef(take, `measure_${i}`)
        const at = (t: number) => {
          const cv = raw.render(expandPasses(def.id, def.source, { ...resolveUniforms(def, {}), u_time: t, u_loop: JUDGE_LOOP, u_seed: 0 }, undefined, 1), src, 256, 256)
          const c = document.createElement('canvas'); c.width = 256; c.height = 256
          const x = c.getContext('2d')!; x.drawImage(cv, 0, 0); return x.getImageData(0, 0, 256, 256).data
        }
        const f = { start: at(0), again: at(0), step: at(LOOP_STEP), beforeEnd: at(JUDGE_LOOP - LOOP_STEP), beforeEnd2: at(JUDGE_LOOP - 2 * LOOP_STEP) }
        return {
          png: j.thumbnail, flags: j.flags, seamless: loopsSeamlessly(f),
          wrap: changeMass(f.beforeEnd, f.start), noise: changeMass(f.start, f.again),
          ordinary: Math.max(changeMass(f.start, f.step), changeMass(f.beforeEnd2, f.beforeEnd)),
        }
      } catch (e) { return { png: null, flags: [`error: ${String((e as Error)?.message ?? e).slice(0, 200)}`], seamless: false, wrap: 0, noise: 0, ordinary: 0 } }
    })
    judge.dispose?.(); raw.dispose()
    return out
  }, { takes, photo })
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
function contactSheet(run: string, summary: any, results: any[]): string {
  const rows = results.map(r => r.notRun ? `<section><h2>${esc(r.request)} <small>not run: ${esc(r.notRun)}</small></h2></section>` : `<section><h2>${esc(r.request)} <small>${r.photo ? 'over the photo' : 'standalone'}${r.remix ? ' · Remix of a raw-u_time My effect' : ''} · set ${(r.setMs / 1000).toFixed(1)} s</small></h2><div class="row">${r.takes.map((t: any) => `<figure class="${t.pass ? 'pass' : 'fail'}">${t.png ? `<img src="${esc(t.png)}" width="256" height="256" alt="">` : '<div class="none">no take</div>'}<figcaption><b>Take ${t.slot}: ${esc(t.take?.name ?? '—')}</b><br>${t.pass ? 'Passed' : `Failed: ${esc(t.failure)}`}<br>${t.calls} call(s) · ${t.tokensIn} in / ${t.tokensOut} out · ${t.credits ?? '—'} credits · ${(t.latencyMs / 1000).toFixed(1)} s<br>Seam: ${t.seam ? (t.seam.seamless ? 'seamless' : 'jumps') + ` (wrap ${t.seam.wrapMass.toFixed(1)} vs step ${t.seam.ordinaryMass.toFixed(1)})` : '—'}${t.seam?.flags?.length ? `<br>Flags: ${esc(t.seam.flags.join(', '))}` : ''}</figcaption></figure>`).join('')}</div></section>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Shader gen measurement</title><style>body{font:13px/1.45 system-ui;margin:24px;background:#141414;color:#ddd}h1{font-size:18px}h2{font-size:14px;margin:24px 0 8px}small{color:#888;font-weight:400}.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;width:256px}figure.fail img{opacity:.5}figcaption{margin-top:6px;color:#aaa}.pass b{color:#9d9}.fail b{color:#e88}.none{width:256px;height:256px;display:grid;place-items:center;background:#222;color:#666}</style><h1>Shader gen measurement · ${esc(run)}</h1><p>${summary.requestsRun}/${results.length} requests run · ${summary.passed}/${summary.takes} takes passed · ${summary.seamless} seamless · ${summary.calls} calls · ${summary.tokensIn} tokens in / ${summary.tokensOut} out · ${summary.credits ?? '—'} credits · median set ${(summary.medianSetMs / 1000).toFixed(1)} s</p>${rows}`
}
