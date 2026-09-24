import { writeFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'

// Does the live embed player draw what the editor draws? (Task 4 of the Frame live-wired plan.)
//
// For every Space Type effect's default state, the harness (app/pages/dev/spacetype-live-parity.vue)
// renders the editor's wired renderer (A) and the effect's built embed player in its own document
// (B) at three whole-frame moments, 480 wide, and compares pixels. Pass = mean absolute difference
// < 2 AND under 0.5% of pixels differing by more than 24 levels, at all three moments — and the
// editor must have drawn something (an all-background picture proves nothing).
//
// LIVE_VERIFIED_EFFECTS (lib/spacetype/embedConfig.ts) holds exactly the effects that passed: a
// verified effect that stops passing fails this spec; an unverified one that now passes is logged.

interface TimeResult { frame: number; totalFrames: number; t01: number; mean: number; over: number; content: number }
interface ParityResult {
  id: string
  status: 'measured' | 'blocked' | 'empty' | 'error'
  reason?: string
  width?: number
  height?: number
  times?: TimeResult[]
  pass?: boolean
  font?: string
  images?: { a: string[]; b: string[] }
}

async function openParity(page: Page): Promise<void> {
  await page.goto('/dev/spacetype-live-parity')
  await page.waitForFunction(() => (window as any).__parityHarnessReady === true, undefined, { timeout: 60_000 })
}

function row(r: ParityResult): string {
  if (!r.times) return `${r.id.padEnd(24)} ${r.status.toUpperCase()}: ${r.reason}`
  const verdict = r.status === 'empty' ? 'EMPTY' : r.pass ? 'PASS' : 'FAIL'
  const cells = r.times.map(t => `f${t.frame}/${t.totalFrames} mean ${t.mean.toFixed(3)} over ${(t.over * 100).toFixed(3)}%`)
  return `${r.id.padEnd(24)} ${verdict.padEnd(5)} ${cells.join(' | ')}${r.font ? `  [${r.font}]` : ''}`
}

async function saveImages(r: ParityResult, out: (name: string) => string): Promise<void> {
  if (!r.images || !r.times) return
  for (let k = 0; k < r.images.a.length; k++) {
    await writeFile(out(`${r.id}-f${r.times[k]!.frame}-editor.png`), Buffer.from(r.images.a[k]!.split(',')[1]!, 'base64'))
    await writeFile(out(`${r.id}-f${r.times[k]!.frame}-player.png`), Buffer.from(r.images.b[k]!.split(',')[1]!, 'base64'))
  }
}

test.describe('Space Type live player vs the editor', () => {
  test.beforeEach(async ({ page }) => openParity(page))

  test('every effect: the verified ones match the editor', async ({ page }, testInfo) => {
    test.setTimeout(900_000)
    const ids: string[] = await page.evaluate(() => (window as any).__parityHarness.effectIds())
    const verified: string[] = await page.evaluate(() => (window as any).__parityHarness.verified())
    const results: ParityResult[] = []
    for (const id of ids) {
      const r: ParityResult = await page.evaluate(async i => await (window as any).__parityHarness.measure(i, { images: true }), id)
      await saveImages(r, n => testInfo.outputPath(n))
      delete r.images
      results.push(r)
      console.log(row(r))
    }
    await writeFile(testInfo.outputPath('parity.json'), JSON.stringify(results, null, 2))

    const passing = results.filter(r => r.pass).map(r => r.id)
    console.log(`[parity] passing (${passing.length} of ${ids.length}): ${passing.join(', ')}`)
    const newlyPassing = passing.filter(id => !verified.includes(id))
    if (newlyPassing.length) console.log(`[parity] passing but NOT verified: ${newlyPassing.join(', ')}`)
    const lost = verified.filter(id => !passing.includes(id))
    expect(lost, `verified effect(s) no longer match the editor:\n${lost.map(id => row(results.find(r => r.id === id)!)).join('\n')}`).toEqual([])
    // The table is not vacuous: every verified effect was measured on a picture with content.
    for (const id of verified) expect(results.find(r => r.id === id)?.status).toBe('measured')
  })

  // The face the player inlines is a SUBSET of the font. Capitalised accented text must still be
  // covered: "Crème brûlée" in capitals draws È, Û and É, which the typed text does not contain.
  // The player runs in its own document, so a glyph missing from the subset falls back to another
  // face there — the two controls below prove the comparison sees exactly that.
  test('accented text in capitals: the inlined subset carries the capitals', async ({ page }) => {
    test.setTimeout(120_000)
    const ACCENT_EFFECT = 'field'
    const out = await page.evaluate(async (id) => {
      const H = (window as any).__parityHarness
      const state = H.defaultState(id)
      state.params.text = 'Crème brûlée'
      state.params.textCase = 'upper'
      const plain = H.defaultState(id)   // its typed text has no accents: its subset has no È/Û/É
      return {
        accent: await H.measureState(state, { label: `${id}-creme-brulee` }),
        narrowSubset: await H.measureState(state, { label: `${id}-creme-brulee-narrow-subset`, fontFrom: plain }),
        noFont: await H.measureState(state, { label: `${id}-creme-brulee-no-font`, dropFont: true }),
      }
    }, ACCENT_EFFECT)
    for (const r of Object.values(out) as ParityResult[]) console.log(row(r))
    expect(out.accent.status).toBe('measured')
    expect(out.accent.pass, row(out.accent)).toBe(true)
    // Controls: with a subset built for unaccented text, or no face at all, it must NOT match.
    expect(out.narrowSubset.pass, row(out.narrowSubset)).toBe(false)
    expect(out.noFont.pass, row(out.noFont)).toBe(false)
  })

  // Gradient's live route (Task 2) against the node's own frame-source render, same thresholds.
  test('Gradient: the player matches the node', async ({ page }) => {
    const r: ParityResult = await page.evaluate(async () => await (window as any).__parityHarness.measureGradient())
    console.log(row(r))
    expect(r.status).toBe('measured')
    expect(r.pass, row(r)).toBe(true)
  })

  // Not a gate — a record for the report. Verification is per effect, measured on each effect's
  // default face; these are verified effects on other faces and weights.
  test('verified effects on other faces (recorded, not asserted)', async ({ page }) => {
    test.setTimeout(300_000)
    const cases: [string, string, number][] = [
      ['field', 'Inter', 400], ['field', 'Inter', 600], ['field', 'Inter', 900], ['field', 'Work Sans', 700],
      ['field', 'Fraunces', 700], ['field', 'Space Grotesk', 700], ['ribbon', 'Work Sans', 700], ['ribbon', 'Inter', 500],
      ['ribbon', 'Fraunces', 400], ['showgrid', 'Inter', 900], ['tunnel', 'Inter', 700], ['spiral', 'Work Sans', 700],
    ]
    for (const [id, font, weight] of cases) {
      const r: ParityResult = await page.evaluate(async ([i, f, w]) => {
        const H = (window as any).__parityHarness
        const s = H.defaultState(i)
        s.params.font = f
        s.params.typeWeight = w
        return await H.measureState(s, { label: `${i} · ${f} ${w}` })
      }, [id, font, weight] as const)
      console.log(row(r))
      expect(['measured', 'blocked']).toContain(r.status)
    }
  })
})
