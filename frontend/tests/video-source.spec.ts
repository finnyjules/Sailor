import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

// Frame-source contracts against the counter fixture (frame i = gray 8+i*8;
// 30 frames, keyframes at 0/10/20; CACHE_FRAMES=24, DECODE_AHEAD=6).
// WebCodecs: exact index recovery across three provably-cold paths — a cold
// mid-GOP first request (13 → decode from keyframe 10), a full 0..29 sweep
// (>24 distinct frames, so LRU evictions fire), and a post-evict seek-back
// (5, evicted during the sweep → cold re-decode from keyframe 0).
// Out-of-range frames WRAP (% src length) to match the Python exporter
// (render_frame_np: ct = local_t % src_T) and the old Canvas2D preview.
// VideoElement: best-effort — index within ±1.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(thisDir, '../..')
const mp4Path = path.join(repoRoot, 'frontend', 'tests', 'fixtures', 'timeline', 'assets', 'counter_30f.mp4')

function indexOf(gray: number): number {
  return Math.round((gray - 8) / 8)
}

async function setup(page: import('@playwright/test').Page) {
  // Range-aware fixture route: without Accept-Ranges/206 support Chromium
  // marks the <video> unseekable (seekable = [0,0]) and clamps every
  // currentTime seek to 0 — real asset servers always support byte ranges.
  const buf = readFileSync(mp4Path)
  await page.route('**/__fixture_media/counter.mp4', (route) => {
    const range = route.request().headers()['range']
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (m) {
      const start = Number(m[1])
      const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1
      return route.fulfill({
        status: 206,
        body: buf.subarray(start, end + 1),
        headers: {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }
    return route.fulfill({
      body: buf,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(buf.length),
      },
    })
  })
  await page.goto('/engine-test')
  await page.waitForFunction(() => !!(window as any).__engineTest, { timeout: 10_000 })
}

test('WebCodecsSource decodes exact frames (cold mid-GOP, LRU eviction, post-evict re-decode)', async ({ page }) => {
  await setup(page)
  const hasWebCodecs: boolean = await page.evaluate(() => (window as any).__engineTest.hasWebCodecs())
  test.skip(!hasWebCodecs, 'WebCodecs unavailable in this browser build — fallback ladder covers it')

  const dims = await page.evaluate(() =>
    (window as any).__engineTest.loadSource('/__fixture_media/counter.mp4', 'webcodecs', 30))
  expect(dims).toEqual({ width: 64, height: 64 })

  // 1) Cold mid-GOP: very first request is 13 → must decode from keyframe 10.
  // 2) Sequential sweep 0..29 → >24 distinct frames → LRU evictions fire.
  // 3) Post-evict seek-back: 5 was evicted during the sweep → cold re-decode from keyframe 0.
  const probes: number[] = [13, ...Array.from({ length: 30 }, (_, i) => i), 5]
  for (const n of probes) {
    const [r] = await page.evaluate((f) => (window as any).__engineTest.frameValue(f), n)
    expect(indexOf(r), `frame ${n} decoded gray ${r}`).toBe(n)
  }
  // Looping parity with the Python exporter (render_frame_np: ct = local % src_T)
  // and the Canvas2D preview (% duration): out-of-range frames WRAP, not clamp.
  const [rWrap] = await page.evaluate(() => (window as any).__engineTest.frameValue(35))
  expect(indexOf(rWrap)).toBe(5)
  const [rWrap2] = await page.evaluate(() => (window as any).__engineTest.frameValue(99))
  expect(indexOf(rWrap2)).toBe(9)   // 99 % 30
  await page.evaluate(() => (window as any).__engineTest.disposeSource())
})

test('VideoElementSource recovers frames within ±1', async ({ page }) => {
  await setup(page)
  await page.evaluate(() =>
    (window as any).__engineTest.loadSource('/__fixture_media/counter.mp4', 'element', 30))
  for (const n of [0, 7, 13, 29, 33]) {
    const want = n % 30
    const [r] = await page.evaluate((f) => (window as any).__engineTest.frameValue(f), n)
    expect(Math.abs(indexOf(r) - want), `frame ${n} → gray ${r}`).toBeLessThanOrEqual(1)
  }
  await page.evaluate(() => (window as any).__engineTest.disposeSource())
})
