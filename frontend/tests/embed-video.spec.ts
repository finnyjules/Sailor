import { test, expect } from '@playwright/test'

// The embed bridge on the three shipped embed surfaces. The harness page
// (app/pages/dev/embed-harness.vue) already builds a config for each; the
// bridge records it and mediabunny reads the file back.
//
// A raw `import('mediabunny')` typed straight into page.evaluate() fails to
// resolve (no import map for bare specifiers at that level — confirmed via
// the Browser pane: both '/_nuxt/node_modules/mediabunny/dist/modules/src/index.js'
// and the bare 'mediabunny' specifier threw "Failed to resolve module
// specifier"/"Failed to fetch dynamically imported module"). So the read-back
// goes through a tiny helper added to app/pages/dev/video-export-harness.vue
// (window.__videoHarness.readEmbedVideo), which Vite already resolves inside
// that SFC's own <script>, exactly as plan 1's readBack does. The recorded
// blob is handed to that page across a navigation as base64, since a Blob
// object cannot itself survive page.goto.
test.describe('embed → video bridge', () => {
  test.setTimeout(180_000)
  for (const [kind, key] of [['shader', '__embedHarness'], ['gradient', '__embedHarnessGradient'], ['spacetype', '__embedHarnessSpaceType']] as const) {
    test(`${kind}: records every frame at the asked size, BT.709`, async ({ page }) => {
      await page.goto('/dev/embed-harness')
      await page.waitForFunction(k => !!(window as any)[k + 'Ready'], key, { timeout: 60_000 })
      const recorded = await page.evaluate(async ([k, kindName]) => {
        const { loadEmbedSurface } = await import('/_nuxt/lib/embed/surfaces.ts')
        const { recordEmbed } = await import('/_nuxt/lib/engine/recordEmbed.ts')
        const h = (window as any)[k]
        const surface = await loadEmbedSurface(kindName)
        const rec = await recordEmbed(surface, h.config, { width: 320, height: 180, fps: 15, duration: 1 })
        const bytes = new Uint8Array(await rec.blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return { base64: btoa(bin), ext: rec.ext, contentType: rec.contentType }
      }, [key, kind] as const)

      await page.goto('/dev/video-export-harness')
      await page.waitForFunction(() => !!(window as any).__videoHarness, undefined, { timeout: 30_000 })
      const r = await page.evaluate(async ({ base64, contentType }) => {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: contentType })
        return await (window as any).__videoHarness.readEmbedVideo(blob)
      }, { base64: recorded.base64, contentType: recorded.contentType })

      expect(r.frames).toBe(15)
      expect([r.width, r.height]).toEqual([320, 180])
      expect(r.colorSpace.primaries).toBe('bt709')
      // If an embed's harness config has no motion, lumaSpread may be 0 — that
      // is fine; the assertion is on frame count, size and colour, not motion.
    })
  }
})
