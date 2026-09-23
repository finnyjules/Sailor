import { test, expect, type Page } from '@playwright/test'

// The timeline recorded in the browser (plan 3): every frame, the right length,
// BT.709, sound on the right frame, and a plain text clip laid out where the
// server lays it out. The page uploads its own tiny test assets to input/.

async function harness(page: Page) {
  await page.goto('/dev/timeline-export-harness')
  await page.waitForFunction(() => (window as any).__timelineExport?.ready, null, { timeout: 60_000 })
}
const H = (page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window as any).__timelineExport[f as string](a), [fn, arg] as const)

const base = (tracks: any[]) => ({
  version: 2, canvas: { width: 320, height: 180, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0, tracks,
})

test.describe('timeline recorded in the browser', () => {
  test.setTimeout(180_000)

  test('every frame, the right length, BT.709, and the sound lands on the right frame', async ({ page }) => {
    await harness(page)
    const img = await H(page, 'makeImage', { w: 320, h: 180, color: '#3060c0' })
    const tone = await H(page, 'makeTone', { silenceSec: 0.5, toneSec: 1, hz: 1000 })
    // Image 0..90 frames (3 s). Audio clip starts at frame 30 (1.0 s); its file
    // is silent for 0.5 s, so the beep must start at 1.5 s.
    const state = base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{ id: 'i', kind: 'image', asset_id: 'x', path: img, start_frame: 0, in_frame: 0, length: 90 }] },
      { id: 'a', kind: 'audio', name: 'A', muted: false, locked: false, clips: [{ id: 't', kind: 'audio', asset_id: 'y', path: tone, start_frame: 30, in_frame: 0, length: 45 }] },
    ])
    const r: any = await H(page, 'run', state)
    test.info().annotations.push({ type: 'result', description: JSON.stringify({ ...r, centre: r.centre.slice(0, 2) }) })
    expect(r.frames).toBe(90)
    expect(Math.abs(r.duration - 3)).toBeLessThanOrEqual(1 / 30 + 0.05)
    expect(r.colorSpace.primaries).toBe('bt709')
    expect(r.colorSpace.fullRange).toBe(false)
    expect(r.audioCodec).toBe('aac')
    expect(Math.abs(r.onset - 1.5)).toBeLessThanOrEqual(1 / 30)
    // The image's colour survives the round trip (±6 levels per channel).
    const [red, green, blue] = r.centre[45]
    expect(Math.abs(red - 0x30)).toBeLessThanOrEqual(6)
    expect(Math.abs(green - 0x60)).toBeLessThanOrEqual(6)
    expect(Math.abs(blue - 0xc0)).toBeLessThanOrEqual(6)
  })

  test('a timeline with no sound makes a video with no audio track', async ({ page }) => {
    await harness(page)
    const img = await H(page, 'makeImage', { w: 320, h: 180, color: '#808080' })
    const r: any = await H(page, 'run', base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{ id: 'i', kind: 'image', asset_id: 'x', path: img, start_frame: 0, in_frame: 0, length: 15 }] },
    ]))
    expect(r.frames).toBe(15)
    expect(r.audioCodec).toBeNull()
  })

  test('a plain text clip is drawn where the server draws it', async ({ page }) => {
    // Rendered by the timeline harness through both renderers; compare the
    // bounding box of the text pixels (fonts differ slightly, layout must not).
    await page.goto('/timeline-harness')
    await page.waitForFunction(() => !!(window as any).__timelineHarness, null, { timeout: 60_000 })
    const state = base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{
        id: 'tx', kind: 'text', start_frame: 0, in_frame: 0, length: 10,
        text: { text: 'Hello world', font_size: 40, color: '#ffffff', bg_color: '#000000', align: 'center', v_align: 'middle', padding: 0.06, line_spacing: 1.2 },
      }] },
    ])
    const box = async (kind: 'webgl' | 'server') => page.evaluate(async ([json, k]) => {
      const h = (window as any).__timelineHarness
      await h.load(json, k)
      const url: string = await h.renderFrame(0)
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4]! > 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
      }
      return { x0, y0, x1, y1 }
    }, [JSON.stringify(state), kind] as const)
    const serverUp = await page.evaluate(() => fetch('/system_stats').then(r => r.ok).catch(() => false))
    const b = await box('webgl')
    expect(b.x1).toBeGreaterThan(b.x0)                // something was drawn
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
    expect(Math.abs(cx - 160)).toBeLessThanOrEqual(8) // centred, like the server's layout
    expect(Math.abs(cy - 90)).toBeLessThanOrEqual(8)
    if (serverUp) {
      const s = await box('server')
      test.info().annotations.push({ type: 'boxes', description: JSON.stringify({ webgl: b, server: s }) })
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(b[k] - s[k])).toBeLessThanOrEqual(0.06 * 320)
    }
  })
})
