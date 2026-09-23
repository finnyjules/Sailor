import type { EmbedSurface } from '~/lib/embed/contract'
import { recordVideo, type RecordResult } from './videoRecorder'

// Record any embed surface (the pieces that can be put on a web page) to a
// video. The surface mounts into a detached container, exactly as it would on
// a page; for each frame we set its time — synchronous by the embed contract —
// and copy its canvas in the same turn, so a WebGL buffer can't be cleared in
// between. The contract is read, never changed: it belongs to the embed work.

export interface EmbedRecordOptions {
  width: number
  height: number
  fps: number
  /** Loop length in seconds. */
  duration: number
  alpha?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export async function recordEmbed(
  surface: EmbedSurface,
  config: unknown,
  o: EmbedRecordOptions,
  deps: { record?: typeof recordVideo; container?: () => HTMLElement } = {},
): Promise<RecordResult> {
  const record = deps.record ?? recordVideo
  const container = (deps.container ?? (() => document.createElement('div')))()
  const handle = await surface.mount(container, config)
  try {
    handle.setSize(o.width, o.height)
    const frameCount = Math.max(1, Math.round(o.duration * o.fps))
    return await record({
      width: o.width, height: o.height, fps: o.fps, frameCount,
      alpha: !!o.alpha && surface.caps.alpha,
      signal: o.signal, onProgress: o.onProgress,
      drawFrame: (i, ctx) => {
        handle.setTime(i / frameCount)
        const canvas = container.querySelector('canvas')
        if (!canvas) throw new Error('embed surface drew no canvas')
        ctx.drawImage(canvas, 0, 0, o.width, o.height)
      },
    })
  } finally {
    handle.destroy()
  }
}
