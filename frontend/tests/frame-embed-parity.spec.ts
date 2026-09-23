import { test, expect } from '@playwright/test'
import { openHarness, pixelDiff, renderExported } from './_frameEmbedHelpers'

/** Records the measured count on the test (visible in the JSON / HTML reports). */
const note = (d: { differing: number; total: number }) =>
  test.info().annotations.push({ type: 'differing', description: `${d.differing} of ${d.total}` })

// The exported file must draw exactly what the Frame editor draws. The reference is the harness's
// studio render (the painter called the way CompositorModal's renderStack calls it, with the app's
// own loaders and the ORIGINAL assets), not the adapter — so a difference is the export's fault.

const T = 0.37
const VIEW = { width: 1000, height: 500 }   // the fixtures' artboard shape → no bleed, parity applies

async function exported(page: any, context: any, name: string, mutate?: string) {
  const html = await page.evaluate(async ([n, m]: [string, string | undefined]) => {
    const H = (window as any).__frameEmbedHarness
    let snap = await H.snapshot(n)
    if (m) snap = H.mutate(snap, m)
    return await H.exportHtml(snap)
  }, [name, mutate])
  return (await renderExported(context, html, T, VIEW)).png
}
const reference = (page: any, name: string) =>
  page.evaluate(([n, t]: [string, number]) => (window as any).__frameEmbedHarness.reference(n, t, 1000, 500), [name, T])

test.describe('Frame embed — parity with the editor', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  // Zero, not a tolerance. The export's font is a SUBSET (gather → /sailor/font_subset →
  // comfy_extras/nodes_timeline.py `subset_font_bytes`), and the reference uses the full file.
  // `subset_font_bytes` keeps the text's own characters UNION basic Latin (U+0020..U+007E,
  // `_BASIC_LATIN_CODEPOINTS = range(0x20, 0x7F)`), with every GSUB/GPOS layout feature
  // (`layout_features = ["*"]`, so kerning and ligatures survive) and hinting left on. Every glyph
  // Decode can flicker through is in that range: the letters, numbers and symbols pools
  // (lib/motionx/text/charsets.ts: A–Z, a–z, 0–9 and `#%&@$?!*+=<>/`) are all basic Latin — so
  // the subset draws exactly what the full font draws.
  test('vector: identical to the editor, subset font and all', async ({ page, context }) => {
    const d = await pixelDiff(page, await reference(page, 'vector'), await exported(page, context, 'vector'))
    note(d)
    expect(d.differing).toBe(0)
  })

  test('image and clip: within the tolerance lossy frames allow', async ({ page, context }) => {
    // WebP at quality 0.9 moves smooth pixels by a few levels; 6 is the allowance, 1 % the budget.
    const d = await pixelDiff(page, await reference(page, 'image'), await exported(page, context, 'image'), 6)
    note(d)
    expect(d.differing).toBeGreaterThanOrEqual(0)
    expect(d.differing / d.total).toBeLessThan(0.01)
  })

  // Stand-ins (R12). The 'standin' fixture holds a file-less stand-in, one whose file 404s and one
  // whose file is there. The editor draws the photo for the last and its grey "photo goes here"
  // box for the first two; the export must too. Whole frame at the lossy allowance (the photo is
  // WebP in the file), and the unreachable stand-in's own box EXACTLY: artboard x 360..640,
  // y 70..280 (x 0.5 ± 0.14, y 0.35 ± 0.105 of 1000), sampled 10 px inside its edge.
  test('stand-ins: an unreachable file draws the same grey box as the editor', async ({ page, context }) => {
    const ref = await reference(page, 'standin')
    const exp = await exported(page, context, 'standin')
    const whole = await pixelDiff(page, ref, exp, 6)
    note(whole)
    expect(whole.differing / whole.total).toBeLessThan(0.01)
    const box = await page.evaluate(async ([a, b]) => {
      const load = (u: string) => new Promise<HTMLImageElement>(res => { const i = new Image(); i.onload = () => res(i); i.src = u })
      const read = (i: HTMLImageElement) => {
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
        const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(370, 80, 260, 190).data
      }
      const [da, db] = (await Promise.all([load(a!), load(b!)])).map(read)
      let differing = 0
      for (let p = 0; p < da!.length; p += 4) {
        if (Math.abs(da![p]! - db![p]!) > 2 || Math.abs(da![p + 1]! - db![p + 1]!) > 2 || Math.abs(da![p + 2]! - db![p + 2]!) > 2) differing++
      }
      // The box really is the grey stand-in (rgba(140,140,140,0.55) over #1b4d3e), not a photo.
      const mid = ((95 * 260) + 130) * 4
      return { differing, mid: [da![mid], da![mid + 1], da![mid + 2]] }
    }, [ref, exp])
    test.info().annotations.push({ type: 'grey box', description: `${box.differing} differing, centre ${box.mid}` })
    expect(box.differing).toBe(0)
    // rgba(140,140,140,0.55) over #1b4d3e (27,77,62) = (89, 112, 105): the grey box, not a photo.
    for (const [c, want] of [[box.mid[0], 89], [box.mid[1], 112], [box.mid[2], 105]]) expect(Math.abs(c! - want!)).toBeLessThanOrEqual(3)
  })

  // The comparison has teeth: one deliberate break in the snapshot — a rect's colour, the font's
  // bytes, a shader's source — must show up as a difference.
  for (const m of ['colour', 'font', 'shader']) {
    test(`teeth: a broken ${m} fails the comparison`, async ({ page, context }) => {
      const d = await pixelDiff(page, await reference(page, 'vector'), await exported(page, context, 'vector', m))
      note(d)
      expect(d.differing).toBeGreaterThan(50)
    })
  }

  // Two times on different clip frames. The Frame's clock is 4 s (no Motion duration) and the clip
  // loops every 1 s (6 frames at 6 fps), so the frame is round(t01 × 4 × 6) mod 6: 0.1 → 2 and
  // 0.2 → 5. (0.1 and 0.6 would both land on frame 2 — 2.4 s is 0.4 s plus two whole loops.)
  test('an image clip plays', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      return await H.exportHtml(await H.snapshot('image'))
    })
    const a = (await renderExported(context, html, 0.1, VIEW)).png
    const b = (await renderExported(context, html, 0.2, VIEW)).png
    expect(a).not.toBe(b)
  })

  test('a Frame that does not move is a still', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('still')
      if (!snap.still) throw new Error('fixture should plan as a still')
      return await H.exportHtml(snap)
    })
    expect(html).toContain('"still":true')
  })
})
