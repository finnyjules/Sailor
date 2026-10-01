import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { PNG } from 'pngjs'

// Golden-frame parity for the WebGL renderer (the goldens were made by the
// Python exporter; its per-frame route went with the server Timeline render,
// Task R9.3):
//  - webgl: the Phase-1 engine. GPU linear sampling ≠ PIL BILINEAR and GL quads
//    are center-anchored vs PIL's integer top-left paste, so edges of
//    scaled/rotated layers differ by design. Gate = mean error + fraction of
//    channel samples above a perceptibility threshold, calibrated in M1.
//
// Requires both dev servers (see playwright.config.ts header).
// Recalibrate: WEBGL_CALIBRATE=1 npx playwright test tests/timeline-golden.spec.ts
// → prints per-frame stats instead of asserting; copy worst-case × safety
// margin into WEBGL_TOL below and record the measured values in the comment.

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(thisDir, '../..')
const fixturesDir = path.join(repoRoot, 'tests-unit', 'timeline_fixtures')
const goldenDir = path.join(repoRoot, 'tests-unit', 'timeline_golden')

// Perceptibility threshold for "this channel sample differs": 8/255.
// CALIBRATION (Julien's dev Mac, 2026-06-09, 14 frames across 3 fixtures):
//   worst mean    = 1.343/255 (03-fades-stack f21, rotated clip)
//   worst pctOver = 3.937%    (02-keyframes f6, rotation mid-tween)
// Tolerances = worst observed × 1.5, rounded up: mean 2.014 → 2.5/255,
// pctOver 5.91% → 6%. Recalibrate with WEBGL_CALIBRATE=1 if goldens change.
const WEBGL_PCT_THRESHOLD = 8 / 255
const WEBGL_TOL = { mean: 2.5 / 255, pctOver: 0.06 }

const CALIBRATE = !!process.env.WEBGL_CALIBRATE

function decodeDataUrl(dataUrl: string): PNG {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'))
}

function diffStats(a: PNG, b: PNG): { max: number; mean: number; pctOver: number } {
  if (a.width !== b.width || a.height !== b.height) return { max: 1, mean: 1, pctOver: 1 }
  let max = 0
  let sum = 0
  let over = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c]! - b.data[i + c]!) / 255
      if (d > max) max = d
      if (d > WEBGL_PCT_THRESHOLD) over++
      sum += d
      n++
    }
  }
  return { max, mean: sum / n, pctOver: over / n }
}

const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith('.json'))
const RENDERERS = ['webgl'] as const

for (const renderer of RENDERERS) {
  for (const fixtureFile of fixtures) {
    test(`golden parity [${renderer}]: ${fixtureFile}`, async ({ page }) => {
      const raw = JSON.parse(readFileSync(path.join(fixturesDir, fixtureFile), 'utf-8'))
      const frames: number[] = raw._golden.frames

      // Browser fetches sources — rewrite to routed URLs served from disk.
      await page.route('**/__fixture_assets/*', (route) => {
        const name = route.request().url().split('/__fixture_assets/')[1]!
        const file = path.join(fixturesDir, 'assets', decodeURIComponent(name))
        if (!existsSync(file)) return route.fulfill({ status: 404 })
        return route.fulfill({ body: readFileSync(file), contentType: 'image/png' })
      })
      for (const track of raw.tracks) for (const clip of track.clips) {
        if (clip.path) clip.path = `/__fixture_assets/${path.basename(clip.path)}`
      }

      await page.goto('/timeline-harness')
      await page.getByTestId('harness-status').waitFor()
      await page.waitForFunction(() => !!(window as any).__timelineHarness, { timeout: 10_000 })
      await page.evaluate(
        (stateJson) => (window as any).__timelineHarness.load(stateJson),
        JSON.stringify(raw),
      )

      const stem = fixtureFile.replace(/\.json$/, '')
      for (const frame of frames) {
        const goldenPath = path.join(goldenDir, stem, `f${String(frame).padStart(3, '0')}.png`)
        expect(existsSync(goldenPath), `missing golden ${goldenPath}`).toBe(true)

        const dataUrl: string = await page.evaluate(
          (f) => (window as any).__timelineHarness.renderFrame(f),
          frame,
        )
        const rendered = decodeDataUrl(dataUrl)
        const golden = PNG.sync.read(readFileSync(goldenPath))
        const { max, mean, pctOver } = diffStats(rendered, golden)

        if (CALIBRATE) {
          console.log(`[calibrate] ${stem} f${frame}: max=${max.toFixed(4)} mean=${(mean * 255).toFixed(3)}/255 pctOver=${(pctOver * 100).toFixed(3)}%`)
        } else {
          expect(mean, `${stem} f${frame} mean diff`).toBeLessThanOrEqual(WEBGL_TOL.mean)
          expect(pctOver, `${stem} f${frame} pctOver(${WEBGL_PCT_THRESHOLD * 255}/255)`).toBeLessThanOrEqual(WEBGL_TOL.pctOver)
        }
      }
    })
  }
}
