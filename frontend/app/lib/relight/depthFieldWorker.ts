/**
 * Builds Relight depth fields off the main thread. The page sends two ImageBitmaps (the depth
 * map at its own size and the source photo already resized to the field size); this reads their
 * pixels on an OffscreenCanvas, runs the pure build, and hands the Float32Array back transferred.
 */
import { buildDepthField } from './depthFieldCore'

interface Job { id: number; depth: ImageBitmap; dw: number; dh: number; guide: ImageBitmap; gw: number; gh: number }

function pixels(bm: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const c = new OffscreenCanvas(w, h)
  const x = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null
  if (!x) throw new Error('no 2D context in the worker')
  x.drawImage(bm, 0, 0, w, h)
  bm.close()
  return x.getImageData(0, 0, w, h).data
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, depth, dw, dh, guide, gw, gh } = e.data
  try {
    const f = buildDepthField(pixels(depth, dw, dh), dw, dh, pixels(guide, gw, gh), gw, gh)
    ;(self as unknown as Worker).postMessage({ id, width: f.width, height: f.height, data: f.data }, [f.data.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
