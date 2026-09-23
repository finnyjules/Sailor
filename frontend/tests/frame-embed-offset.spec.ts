import { test, expect } from '@playwright/test'
import { openHarness } from './_frameEmbedHelpers'

// Backdrop-reading effects (backdrop shader, long shadow — and glass and displacement lenses
// through the same backdrop snapshot) have only ever been painted with the Frame at the canvas
// origin. Fit moves it. Render the "backdrop" fixture once exactly at its own shape and once
// centred in a box twice as wide (a solid background, so the bleed is uniform), crop the centre,
// and require the same pixels. The responsive-Frames work reuses this test for its own offsets.
//
// Self-contained on purpose: it needs only the harness page (mount / setSize / setTime / pixels /
// destroy on slot 'a' and the 'backdrop' fixture), no exported file and no other helper. The
// harness runs at dpr 1 in the Playwright Chromium project, so 1000 × 500 is the device size.
test('backdrop-reading effects are unchanged when the Frame is offset', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const H = (window as any).__frameEmbedHarness
    const snap = await H.snapshot('backdrop')
    // At its own shape: the Frame sits at the canvas origin.
    await H.mount('a', snap); H.setSize('a', 1000, 500); H.setTime('a', 0.25)
    const own = H.pixels('a'); H.destroy('a')
    // Twice as wide under Fit: the Frame is centred, 500 px in from the canvas's left edge.
    await H.mount('a', snap); H.setSize('a', 2000, 500); H.setTime('a', 0.25)
    const wide = H.pixels('a'); H.destroy('a')
    const load = (u: string) => new Promise<HTMLImageElement>(res => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [a, b] = await Promise.all([load(own), load(wide)])
    const ca = document.createElement('canvas'); ca.width = 1000; ca.height = 500
    ca.getContext('2d')!.drawImage(a, 0, 0)
    const cb = document.createElement('canvas'); cb.width = 1000; cb.height = 500
    cb.getContext('2d')!.drawImage(b, 500, 0, 1000, 500, 0, 0, 1000, 500)   // crop the centred Frame
    const da = ca.getContext('2d')!.getImageData(0, 0, 1000, 500).data
    const db = cb.getContext('2d')!.getImageData(0, 0, 1000, 500).data
    let differing = 0
    for (let p = 0; p < da.length; p += 4) if (Math.abs(da[p]! - db[p]!) > 2 || Math.abs(da[p + 1]! - db[p + 1]!) > 2 || Math.abs(da[p + 2]! - db[p + 2]!) > 2) differing++
    return differing
  })
  expect(r).toBe(0)
})

// The same property under Fill, where the offset is NEGATIVE: in a 500 × 500 box the 1000 × 500
// Frame is scaled 1 and shifted 250 px left, so the box shows artboard x 250..750. The pixels must
// be that crop of the Frame at its own shape. Backdrop effects near the box edge read the part of
// the Frame outside the box, so this fails if that part is not painted as the editor paints it
// (it failed with 654 pixels, all in the glass at x 250..260, while the background covered only
// the box).
test('backdrop-reading effects are unchanged when Fill crops the Frame', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const H = (window as any).__frameEmbedHarness
    const snap = await H.snapshot('backdrop', { fit: 'fill' })
    await H.mount('a', snap); H.setSize('a', 1000, 500); H.setTime('a', 0.25)
    const own = H.pixels('a'); H.destroy('a')
    await H.mount('a', snap); H.setSize('a', 500, 500); H.setTime('a', 0.25)
    const square = H.pixels('a'); H.destroy('a')
    const load = (u: string) => new Promise<HTMLImageElement>(res => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [a, b] = await Promise.all([load(own), load(square)])
    const ca = document.createElement('canvas'); ca.width = 500; ca.height = 500
    ca.getContext('2d')!.drawImage(a, 250, 0, 500, 500, 0, 0, 500, 500)   // the crop Fill shows
    const cb = document.createElement('canvas'); cb.width = 500; cb.height = 500
    cb.getContext('2d')!.drawImage(b, 0, 0)
    const da = ca.getContext('2d')!.getImageData(0, 0, 500, 500).data
    const db = cb.getContext('2d')!.getImageData(0, 0, 500, 500).data
    let differing = 0
    for (let p = 0; p < da.length; p += 4) if (Math.abs(da[p]! - db[p]!) > 2 || Math.abs(da[p + 1]! - db[p + 1]!) > 2 || Math.abs(da[p + 2]! - db[p + 2]!) > 2) differing++
    return differing
  })
  expect(r).toBe(0)
})
