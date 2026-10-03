import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

// A/V sync gate (design doc M2): play the counter video with the tone audio
// for ~1.6s; the rendered frame must track the clock within 1 frame at every
// post-warmup sample, and the clock must advance at wall-clock rate.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(thisDir, '../..')
const fixturesDir = path.join(repoRoot, 'frontend', 'tests', 'fixtures', 'timeline', 'assets')

const STATE = {
  version: 2,
  canvas: { width: 320, height: 180, fps: 30, bg_color: '#000000' },
  total_frames: 90,
  transitions: [],
  tracks: [
    { id: 'v1', kind: 'video', name: 'V', muted: false, locked: false, clips: [
      { id: 'vid', kind: 'video', asset_id: 'counter', path: '/__fixture_media/counter.mp4',
        start_frame: 0, in_frame: 0, length: 30 },
    ] },
    { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false, clips: [
      { id: 'tone', kind: 'audio', asset_id: 'tone', path: '/__fixture_media/tone.wav',
        start_frame: 0, in_frame: 0, length: 30, volume: 0.5, audio_fade_in: 5, audio_fade_out: 5 },
    ] },
  ],
}

/** Range-aware static file route (Chromium clamps <video> seeks without it). */
function serveFile(file: string, contentType: string) {
  const buf = readFileSync(file)
  return (route: import('@playwright/test').Route) => {
    const rangeHeader = route.request().headers()['range']
    const m = rangeHeader && /bytes=(\d+)-(\d*)/.exec(rangeHeader)
    if (!m) return route.fulfill({ body: buf, contentType, headers: { 'Accept-Ranges': 'bytes' } })
    const start = parseInt(m[1]!, 10)
    const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1
    return route.fulfill({
      status: 206,
      body: buf.subarray(start, end + 1),
      contentType,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }
}

test('playback: rendered frame tracks the clock within 1 frame; clock tracks wall time', async ({ page }) => {
  await page.route('**/__fixture_media/counter.mp4', serveFile(path.join(fixturesDir, 'counter_30f.mp4'), 'video/mp4'))
  await page.route('**/__fixture_media/tone.wav', serveFile(path.join(fixturesDir, 'tone_440.wav'), 'audio/wav'))

  await page.goto('/engine-test')
  await page.waitForFunction(() => !!(window as any).__engineTest, { timeout: 10_000 })
  await page.evaluate((s) => (window as any).__engineTest.loadTimeline(s), JSON.stringify(STATE))

  const wallStart = Date.now()
  await page.evaluate(() => (window as any).__engineTest.play())

  const samples: { clockSec: number; renderedFrame: number }[] = []
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(100)
    samples.push(await page.evaluate(() => (window as any).__engineTest.sample()))
  }
  await page.evaluate(() => (window as any).__engineTest.pause())
  const wallSec = (Date.now() - wallStart) / 1000

  // Skip warmup (first 3 samples — decode-ahead filling).
  for (const s of samples.slice(3)) {
    const expected = Math.floor(s.clockSec * 30)
    // Clip is 30 frames; past its end the timeline keeps advancing but renders
    // background-only frames — lastRenderedFrame still tracks the playhead.
    expect(Math.abs(s.renderedFrame - expected),
      `clock ${s.clockSec.toFixed(3)}s expects frame ~${expected}, rendered ${s.renderedFrame}`,
    ).toBeLessThanOrEqual(1)
  }

  // Clock advanced at roughly wall rate (±15% — CI scheduling slop).
  const last = samples[samples.length - 1]!
  expect(last.clockSec).toBeGreaterThan(wallSec * 0.85 - 0.35)
  expect(last.clockSec).toBeLessThan(wallSec * 1.15)
})
