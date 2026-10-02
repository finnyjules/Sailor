<template>
  <div style="padding: 8px; font: 12px monospace">video export harness ready</div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { recordVideo } from '~/lib/engine/videoRecorder'

interface Opts { width: number; height: number; fps: number; frames: number; alpha: boolean }

// A test pattern with flat colours, a smooth ramp and a moving block: colour
// errors show on the bars, banding on the ramp, frame mix-ups on the block.
// The recorder has already filled black (opaque) or cleared (transparent).
function paintTestFrame(ctx: CanvasRenderingContext2D, i: number, w: number, h: number, alpha: boolean) {
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#101010']
  const bw = w / bars.length
  bars.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(Math.round(k * bw), 0, Math.ceil(bw), Math.round(h * 0.6)) })
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, '#000000'); g.addColorStop(1, '#ffffff')
  ctx.fillStyle = g; ctx.fillRect(0, Math.round(h * 0.6), w, Math.round(h * 0.2))
  ctx.fillStyle = '#ffffff'; ctx.fillRect((i * 8) % Math.max(1, w - 40), Math.round(h * 0.82), 40, Math.round(h * 0.16))
  if (alpha) ctx.clearRect(0, 0, Math.round(w / 4), h)   // a fully transparent band
}

function referenceCanvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! }
}

async function readBack(blob: Blob, o: Opts, ms: number) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('no video track')
  const colorSpace = await track.getColorSpace()
  const duration = await input.computeDuration()
  const width = await track.getDisplayWidth()
  const height = await track.getDisplayHeight()
  const sink = new CanvasSink(track, { alpha: o.alpha })
  const ref = referenceCanvas(o.width, o.height)
  const got = referenceCanvas(o.width, o.height)
  let frames = 0, errSum = 0, alphaMin = 255, alphaMax = 0
  for await (const wc of sink.canvases()) {
    ref.ctx.clearRect(0, 0, o.width, o.height)
    if (!o.alpha) { ref.ctx.fillStyle = '#000000'; ref.ctx.fillRect(0, 0, o.width, o.height) }
    paintTestFrame(ref.ctx, frames, o.width, o.height, o.alpha)
    got.ctx.clearRect(0, 0, o.width, o.height)
    got.ctx.drawImage(wc.canvas as CanvasImageSource, 0, 0, o.width, o.height, 0, 0, o.width, o.height)
    const a = ref.ctx.getImageData(0, 0, o.width, o.height).data
    const b = got.ctx.getImageData(0, 0, o.width, o.height).data
    let s = 0, n = 0
    for (let p = 0; p < a.length; p += 4) {
      alphaMin = Math.min(alphaMin, b[p + 3]!); alphaMax = Math.max(alphaMax, b[p + 3]!)
      if (a[p + 3] !== 255) continue   // colour of a transparent pixel means nothing
      s += Math.abs(a[p]! - b[p]!) + Math.abs(a[p + 1]! - b[p + 1]!) + Math.abs(a[p + 2]! - b[p + 2]!); n += 3
    }
    errSum += n ? s / n : 0
    frames++
  }
  return { frames, duration, width, height, colorSpace, mae: errSum / Math.max(1, frames), alphaMin, alphaMax, bytes: blob.size, ms }
}

// Task 4 (the embed bridge, plan 2): a raw dynamic `import('mediabunny')`
// typed straight into a page's dev-tools console (or from a Playwright
// page.evaluate string) fails to resolve — there is no import map for bare
// specifiers at that level. Inside this SFC's own <script>, Vite already
// resolves it (readBack above does exactly that), so exposing a helper here
// gets a test the read-back it needs without hard-coding a node_modules/.vite
// pre-bundle path, which is a private cache location, not a stable API.
async function readEmbedVideo(blob: Blob) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('no video track')
  let frames = 0, lumaSpread = 0
  let first: number | null = null
  for await (const wc of new CanvasSink(track).canvases()) {
    const c = wc.canvas as HTMLCanvasElement
    const px = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
    const y = px[0]! + px[1]! + px[2]!
    if (first === null) first = y
    lumaSpread = Math.max(lumaSpread, Math.abs(y - first))
    frames++
  }
  const colorSpace = await track.getColorSpace()
  return { frames, width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), colorSpace, lumaSpread }
}

// The last file the recorder made, so a debugging script can pull it out of
// the page (fileBase64) and inspect it with compare_videos.py.
const lastFile: { browser?: Blob } = {}

async function fileBase64(which: 'browser') {
  const b = lastFile[which]
  if (!b) return null
  const bytes = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function run(o: Opts) {
  const t0 = performance.now()
  const rec = await recordVideo({
    width: o.width, height: o.height, fps: o.fps, frameCount: o.frames, alpha: o.alpha,
    drawFrame: (i, ctx) => paintTestFrame(ctx, i, o.width, o.height, o.alpha),
  })
  lastFile.browser = rec.blob
  return readBack(rec.blob, o, performance.now() - t0)
}

async function runCancel(o: Opts) {
  const ac = new AbortController()
  try {
    await recordVideo({
      width: o.width, height: o.height, fps: o.fps, frameCount: o.frames, alpha: o.alpha, signal: ac.signal,
      drawFrame: (i, ctx) => { if (i === 5) ac.abort(); paintTestFrame(ctx, i, o.width, o.height, o.alpha) },
    })
    return { name: 'finished' }
  } catch (e) {
    return { name: (e as Error).name }
  }
}

onMounted(() => { (window as any).__videoHarness = { run, runCancel, fileBase64, readEmbedVideo } })
</script>
