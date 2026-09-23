// A generic "play these frames" embed player (spec Part 2). Knows nothing about 3D — any studio
// that can pre-render its loop can use it. Each frame stays a compressed image and the browser
// decodes it when it is drawn (the same pattern Frame clips use), so a long loop never holds
// every decoded frame in memory; drawImage is synchronous, so setTime always draws the exact frame.
import type { EmbedHandle, EmbedSurface } from '../contract'

export interface FramesEmbedConfig { frames: string[]; fps: number; width: number; height: number }

export function frameIndexAt(t01: number, count: number): number {
  // The runtime clock (bundle.ts's t01At) never produces a negative phase — this guard is
  // purely defensive, so an out-of-domain input (negative, NaN) clamps to the first frame
  // rather than wrapping backwards into the last one, which would look like a stutter, not a
  // safe fallback. Only the boundary at exactly 1 (a completed loop) wraps, via plain `% 1`.
  if (!(count > 0) || !Number.isFinite(t01) || t01 < 0) return 0
  const wrapped = t01 % 1
  return Math.min(count - 1, Math.floor(wrapped * count))
}

function loadFrame(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('embed: a frame failed to decode'))
    img.src = src
  })
}

function validate(config: unknown): FramesEmbedConfig {
  const c = config as FramesEmbedConfig
  if (!c || !Array.isArray(c.frames) || c.frames.length === 0) throw new Error('embed: no frames to play')
  if (!c.frames.every(f => typeof f === 'string' && f.startsWith('data:'))) throw new Error('embed: every frame must be inlined')
  if (!(c.width > 0) || !(c.height > 0)) throw new Error('embed: frames need a size')
  return c
}

const surface: EmbedSurface = {
  kind: 'frames',
  caps: { alpha: true },
  async mount(container, config): Promise<EmbedHandle> {
    const cfg = validate(config)
    const images = await Promise.all(cfg.frames.map(loadFrame))
    const canvas = document.createElement('canvas')
    canvas.width = cfg.width
    canvas.height = cfg.height
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('embed: no 2D context')
    container.appendChild(canvas)
    let current = 0
    const draw = (i: number) => {
      current = i
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(images[i]!, 0, 0, canvas.width, canvas.height)
    }
    draw(0)
    return {
      setTime(t01) { draw(frameIndexAt(t01, images.length)) },
      setSize(w, h) {
        const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
        if (canvas.width !== W) canvas.width = W
        if (canvas.height !== H) canvas.height = H
        draw(current)
      },
      destroy() { canvas.remove(); images.length = 0 },
    }
  },
}
export default surface
