/**
 * The export-time check behind "never a wrong picture" for live wired layers (Task 5 of the Frame
 * live-wired plan). A per-effect verified list cannot promise a match in every font, size and post
 * effect — Task 4 measured verified effects 6–14% off in optical-size faces — so every live layer
 * is checked when it is exported: the exact player the file will carry, in a document of its own
 * that holds only the file's own fonts, against the editor's picture of the same layer. Anything
 * but a match (a difference, an error, a timeout) sends the layer to frames.
 *
 * How the player is loaded is the Task 4 parity harness's (pages/dev/spacetype-live-parity.vue):
 * the built bundle's text is run in a blank same-origin iframe. In the app's own document the
 * app's faces for the same family would stand in for any glyph the inlined subset lacks, and the
 * check would pass a picture the file cannot draw.
 *
 * App-side only — never imported by an embed bundle.
 */
import type { EmbedHandle, EmbedSurface } from '../contract'
import type { StudioEmbed, StudioFrameSource } from '~/lib/studio/frameSource'
import { diffImages, matches, type ImageDiff } from './compare'

export interface LiveCheckResult { ok: boolean; reason?: string; diffs: ImageDiff[] }

/** A running check: resolves with its result — at the latest when it times out — and carries
 *  `settled`, which resolves only once the check's own work has actually stopped. A timed-out
 *  check may still be inside a `source.getFrame` it cannot cancel; whoever lent it the source
 *  (the pull lock, the stopped preview) must hold that loan until `settled`, or the orphaned
 *  pull can land in the middle of the next reader's pull (the frames fallback). Never rejects. */
export type LiveCheck = Promise<LiveCheckResult> & { settled: Promise<void> }

/** Moments checked, as fractions of the loop; each is snapped to a whole frame. */
export const LIVE_CHECK_AT = [0, 0.37, 0.71] as const
/** Both pictures are compared at this long side, in the source's aspect. */
export const LIVE_CHECK_LONG_SIDE = 480
export const LIVE_CHECK_TIMEOUT_MS = 10_000

/** The checked t01s over a loop of `frames` whole frames: frame i ↔ i / frames, so the source's
 *  frame-snapped time and the player's continuous time name the same moment. */
export function liveCheckTimes(frames: number): number[] {
  const n = Math.max(1, Math.round(frames))
  return LIVE_CHECK_AT.map(f => (Math.round(f * n) % n) / n)
}

/** A picture's RGBA pixels at w×h, read through one reused 2D canvas. */
function pixelReader(): (img: CanvasImageSource, w: number, h: number) => Uint8ClampedArray {
  const c = document.createElement('canvas')
  let g: CanvasRenderingContext2D | null = null
  return (img, w, h) => {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
    g ??= c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
    if (!g) throw new Error('no 2D canvas to read pixels with')
    g.clearRect(0, 0, w, h)
    g.drawImage(img, 0, 0, w, h)
    return g.getImageData(0, 0, w, h).data
  }
}

/** A blank same-origin document of its own, off screen, holding nothing but `bundleJs` (run as
 *  the exported file runs it) and a w×h container. */
function openPlayerDocument(bundleJs: string, w: number, h: number): { frame: HTMLIFrameElement; surface: EmbedSurface; container: HTMLElement } {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText = `position:fixed;left:-${w + 200}px;top:0;width:${w}px;height:${h}px;border:0;opacity:0;pointer-events:none`
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument
    const win = frame.contentWindow as (Window & { __SAILOR_SURFACE__?: EmbedSurface }) | null
    if (!doc || !win) throw new Error('the check could not open a document of its own')
    doc.open()
    doc.write(`<!doctype html><html><head></head><body style="margin:0"><div id="c" style="width:${w}px;height:${h}px"></div></body></html>`)
    doc.close()
    let scriptError = ''
    const onError = (e: ErrorEvent) => { scriptError ||= e.message }
    win.addEventListener('error', onError)
    const script = doc.createElement('script')
    script.textContent = bundleJs
    doc.head.appendChild(script)
    win.removeEventListener('error', onError)
    const surface = win.__SAILOR_SURFACE__
    if (!surface) throw new Error(`the player bundle did not define a surface${scriptError ? ` (${scriptError})` : ''}`)
    return { frame, surface, container: doc.getElementById('c')! }
  } catch (err) {
    frame.remove()
    throw err
  }
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`

/**
 * Mounts `bundleJs` (the exact file the export will carry) in a blank same-origin iframe, mounts
 * its surface with `embed.config`, and compares it with `source.getFrame` at three frame-boundary
 * times (t01 = i / frames, i near 0, 0.37, 0.71 of `frames = round(source.fps * embed.duration)`),
 * at a long side of 480 px in the source's aspect. Resolves ok only when every time matches.
 * Never rejects; errors and a 10 s timeout resolve { ok: false, reason }. Always removes the iframe
 * and destroys the handle. The returned promise's `settled` resolves once the check's own pulls and
 * mount have finished too — after the result when the check timed out (see LiveCheck).
 *
 * The player is mounted with the config as is (it builds at the source's native size) and then
 * `setSize`d, as the Frame export's nested player is — so an effect whose layout depends on its
 * build size (Pile) mismatches here exactly when it would in the file. The source is pulled first,
 * after `document.fonts.ready`; each pulled surface is read before the next pull, and each player
 * picture in the same task as its `setTime` (a WebGL canvas does not keep its buffer).
 */
export function checkLiveEmbed(
  source: StudioFrameSource, embed: StudioEmbed, bundleJs: string, opts: { timeoutMs?: number } = {},
): LiveCheck {
  const timeoutMs = opts.timeoutMs ?? LIVE_CHECK_TIMEOUT_MS
  const diffs: ImageDiff[] = []
  let done = false
  let frame: HTMLIFrameElement | null = null
  let handle: EmbedHandle | null = null
  const cleanup = () => {
    try { handle?.destroy() } catch { /* the check is over either way */ }
    handle = null
    frame?.remove()
    frame = null
  }

  const run = async (): Promise<LiveCheckResult> => {
    const sw = Math.max(1, source.width || embed.width || 1), sh = Math.max(1, source.height || embed.height || 1)
    const k = LIVE_CHECK_LONG_SIDE / Math.max(sw, sh)
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k))
    const frames = Math.max(1, Math.round(source.fps * embed.duration))
    const times = liveCheckTimes(frames)
    const read = pixelReader()

    // A: the editor's picture. Fonts first, so a face still arriving is not pulled as a fallback.
    await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
    const reference: Uint8ClampedArray[] = []
    for (const t of times) {
      if (done) return { ok: false, diffs }
      const surface = await source.getFrame(t, w, h)
      reference.push(read(surface as CanvasImageSource, w, h))
    }
    if (done) return { ok: false, diffs }

    // B: the file's player, in its own document.
    const opened = openPlayerDocument(bundleJs, w, h)
    frame = opened.frame
    const mounted = await opened.surface.mount(opened.container, embed.config)
    if (done) { try { mounted.destroy() } catch { /* timed out already */ } return { ok: false, diffs } }
    handle = mounted
    mounted.setSize(w, h)
    let firstMiss = -1
    for (let i = 0; i < times.length; i++) {
      mounted.setTime(times[i]!)
      const canvas = opened.container.querySelector('canvas')
      if (!canvas) throw new Error('the player drew no canvas')
      const d = diffImages(reference[i]!, read(canvas, w, h))
      diffs.push(d)
      if (firstMiss < 0 && !matches(d)) firstMiss = i
    }
    if (firstMiss < 0) return { ok: true, diffs }
    const d = diffs[firstMiss]!
    const at = Math.round(times[firstMiss]! * frames)
    return { ok: false, reason: `the player differs at frame ${at} of ${frames}: mean ${d.mean.toFixed(2)}, ${pct(d.shareOver)} of pixels`, diffs }
  }

  let settle!: () => void
  const settled = new Promise<void>((r) => { settle = r })
  const result = new Promise<LiveCheckResult>((resolve) => {
    const finish = (r: LiveCheckResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `timed out after ${timeoutMs} ms`, diffs: [...diffs] }), timeoutMs)
    // `settled` follows run() itself, not the result: after a timeout, run() is still awaiting
    // the pull (or the mount) it started, and only its own `done` checks stop it afterwards.
    run()
      .then(finish, (err: unknown) => finish({ ok: false, reason: err instanceof Error ? err.message : String(err), diffs: [...diffs] }))
      .finally(settle)
  })
  return Object.assign(result, { settled })
}
