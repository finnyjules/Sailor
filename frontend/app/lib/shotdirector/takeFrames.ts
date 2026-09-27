/**
 * Browser-only: three frames of a video take as JPEG data URLs, for the
 * take-check face score (Task 10). mediabunny is imported on demand, as in
 * pages/dev/video-export-harness.vue.
 */

const FRACTIONS = [0.25, 0.5, 0.75]
const MAX_SIDE = 1024
const QUALITY = 0.85

export async function sampleTakeFrames(videoUrl: string): Promise<string[]> {
  const res = await fetch(videoUrl)
  if (!res.ok) throw new Error(`video fetch failed (${res.status})`)
  const blob = await res.blob()

  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('no video track')
    const start = await track.getFirstTimestamp()
    const end = await track.computeDuration()
    const w = await track.getDisplayWidth()
    const h = await track.getDisplayHeight()
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h, 1))
    const width = Math.max(1, Math.round(w * scale))
    const height = Math.max(1, Math.round(h * scale))
    const sink = new CanvasSink(track, { width, height, fit: 'fill' })

    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('no 2d context')

    const frames: string[] = []
    for (const f of FRACTIONS) {
      const wc = await sink.getCanvas(start + (end - start) * f)
      if (!wc) continue
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(wc.canvas as CanvasImageSource, 0, 0, width, height)
      frames.push(out.toDataURL('image/jpeg', QUALITY))
    }
    return frames
  } finally {
    input.dispose()
  }
}
