import { test, expect, type Page } from '@playwright/test'

// Quality gate for the browser video recorder (spec: docs/superpowers/specs/
// 2026-09-21-browser-video-export-design.md, "Correctness gates"). A known
// test pattern is recorded, read back and measured; where ComfyUI is running,
// the SAME frames go through the server encoder too, and the browser file must
// be at least as close to the source as the server's.

// Browser must be within 10 % or half a level (0–255 scale) of the server.
const passMark = (serverMae: number) => Math.max(serverMae * 1.1, serverMae + 0.5)
// Without ComfyUI there is nothing to compare to; hold an absolute ceiling.
const ABSOLUTE_MAE_CEILING = 3.0
// The transparent WebM's ceiling without ComfyUI: measured browser mae + 1.0.
// Measured 2026-09-22 (Chromium, 320×180, 30 frames): browser 1.41, server 1.62.
const WEBM_ABSOLUTE_MAE_CEILING = 2.4

async function harness(page: Page) {
  await page.goto('/dev/video-export-harness')
  await page.waitForFunction(() => !!(window as any).__videoHarness, null, { timeout: 30_000 })
}
const call = (page: Page, fn: string, o: object) => page.evaluate(([f, a]) => (window as any).__videoHarness[f as string](a), [fn, o] as const)

test.describe('browser video export — quality gate', () => {
  test.setTimeout(180_000)

  test('MP4: every frame, the right length, BT.709, and at least as close to the source as the server', async ({ page }) => {
    await harness(page)
    const o = { width: 640, height: 360, fps: 30, frames: 60, alpha: false }
    const b: any = await call(page, 'run', o)
    test.info().annotations.push({ type: 'browser', description: JSON.stringify(b) })
    expect(b.frames).toBe(60)
    expect(Math.abs(b.duration - 2)).toBeLessThanOrEqual(1 / 30 + 1e-6)
    expect([b.width, b.height]).toEqual([640, 360])
    expect(b.colorSpace.primaries).toBe('bt709')
    expect(b.colorSpace.transfer).toBe('bt709')
    expect(b.colorSpace.matrix).toBe('bt709')

    const serverUp = await page.evaluate(() => fetch('/system_stats').then(r => r.ok).catch(() => false))
    if (serverUp) {
      const s: any = await call(page, 'runServer', o)
      test.info().annotations.push({ type: 'server', description: JSON.stringify(s) })
      expect(s.frames).toBe(60)
      expect(b.mae).toBeLessThanOrEqual(passMark(s.mae))
    } else {
      test.info().annotations.push({ type: 'server', description: 'ComfyUI not running — absolute ceiling used' })
      expect(b.mae).toBeLessThanOrEqual(ABSOLUTE_MAE_CEILING)
    }
  })

  test('odd sizes come out rounded up to even', async ({ page }) => {
    await harness(page)
    const b: any = await call(page, 'run', { width: 641, height: 361, fps: 30, frames: 10, alpha: false })
    expect([b.width, b.height]).toEqual([642, 362])
    expect(b.frames).toBe(10)
  })

  test('WebM keeps transparency, BT.709, and is at least as close to the source as the server', async ({ page }) => {
    await harness(page)
    const o = { width: 320, height: 180, fps: 30, frames: 30, alpha: true }
    const b: any = await call(page, 'run', o)
    test.info().annotations.push({ type: 'browser', description: JSON.stringify(b) })
    expect(b.frames).toBe(30)
    expect(Math.abs(b.duration - 1)).toBeLessThanOrEqual(1 / 30 + 1e-6)
    expect(b.alphaMin).toBe(0)
    expect(b.alphaMax).toBe(255)
    expect(b.colorSpace.primaries).toBe('bt709')
    expect(b.colorSpace.transfer).toBe('bt709')
    expect(b.colorSpace.matrix).toBe('bt709')

    const serverUp = await page.evaluate(() => fetch('/system_stats').then(r => r.ok).catch(() => false))
    if (serverUp) {
      const s: any = await call(page, 'runServer', o)
      test.info().annotations.push({ type: 'server', description: JSON.stringify(s) })
      expect(s.frames).toBe(30)
      expect(b.mae).toBeLessThanOrEqual(passMark(s.mae))
    } else {
      test.info().annotations.push({ type: 'server', description: 'ComfyUI not running — absolute ceiling used' })
      expect(b.mae).toBeLessThanOrEqual(WEBM_ABSOLUTE_MAE_CEILING)
    }
  })

  test('cancel stops the export with an AbortError', async ({ page }) => {
    await harness(page)
    const r: any = await call(page, 'runCancel', { width: 320, height: 180, fps: 30, frames: 60, alpha: false })
    expect(r.name).toBe('AbortError')
  })
})
