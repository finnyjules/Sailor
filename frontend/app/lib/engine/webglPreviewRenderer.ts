import type { EditState, Clip, SpaceTypeClip } from '~~/shared/timeline/types'
import type { PreviewRenderer } from '~~/shared/timeline/previewRenderer'
import type { ClipPreview } from '~/composables/usePlaybackEngine'
import { buildDrawList, hexToRgb } from './compositor'
import { GlRenderer } from './gl/glRenderer'
import { ImageSource } from './sources/imageSource'
import { SequenceSource } from './sources/sequenceSource'
import { TextCanvasSource } from './sources/textCanvasSource'
import { SpaceTypeSource } from './sources/spaceTypeSource'
import { WebCodecsSource, UnsupportedSourceError } from './sources/webCodecsSource'
import { VideoElementSource } from './sources/videoElementSource'
import type { FrameSource } from './sources/frameSource'

/** Above this, skip WebCodecs (whole-file fetch) and go straight to the
 *  seek-and-capture element source. Best-effort: unknown sizes proceed. */
export const WEBCODECS_MAX_BYTES = 96 * 1024 * 1024

export type ResolutionPlan =
  | { kind: 'image'; url: string }
  | { kind: 'video'; url: string }
  | { kind: 'sequence'; urls: string[] }
  | { kind: 'text' }
  | { kind: 'spacetype' }
  | null

/** Pure decision table: which source loads for a clip given its resolved
 *  preview. Exported for unit tests. */
export function resolutionPlanFor(clip: Clip, preview: ClipPreview | null): ResolutionPlan {
  if (TextCanvasSource.supports(clip)) return { kind: 'text' }
  if (SpaceTypeSource.supports(clip)) return { kind: 'spacetype' }
  if (!preview) return null
  if (preview.kind === 'sequence' && preview.urls?.length) return { kind: 'sequence', urls: preview.urls }
  if (preview.kind === 'image') return { kind: 'image', url: preview.url }
  if (preview.kind === 'video') return { kind: 'video', url: preview.url }
  return null
}

export interface RendererLoadOptions {
  /** Editor-style resolution (asset library / wired nodes). Default: the
   *  harness behavior — clip.path is already a fetchable URL. */
  resolve?: (clip: Clip) => ClipPreview | null
}

const defaultResolve = (clip: Clip): ClipPreview | null => {
  if ((clip.kind === 'image' || clip.kind === 'video') && clip.path) {
    return { url: clip.path, kind: clip.kind }
  }
  return null
}

// Deterministic WebGL implementation of the PreviewRenderer seam. load()
// resolves each clip to a source via an injectable resolver (the editor passes
// its asset-library/wired-node resolution; the default reads clip.path as a
// fetchable URL — the harness/golden-spec behavior). Video uses the source
// ladder: WebCodecs (frame-exact) unless the file is too large or unsupported,
// then the seek-and-capture video element. Animated text rasterizes through
// TextCanvasSource. A clip that fails to load is skipped and recorded in
// loadWarnings — one bad source never kills the whole preview.
// renderFrame() composites exactly frame n.
export class WebGLPreviewRenderer implements PreviewRenderer {
  private state: EditState | null = null
  private gl: GlRenderer | null = null
  private sources = new Map<string, FrameSource>()
  private disposed = false

  /** Per-clip load failures (clip id → message). Cleared per load(). */
  readonly loadWarnings = new Map<string, string>()

  /** Video clips drawn through the seek-and-capture fallback, which can land
   *  one frame off — fine for preview, not for export (recordTimeline refuses
   *  them). Clip id → plain-language reason. Cleared per load(). */
  readonly inexactClips = new Map<string, string>()

  async load(state: EditState, opts: RendererLoadOptions = {}): Promise<void> {
    if (this.disposed) return
    this.disposeSources()
    this.loadWarnings.clear()
    this.inexactClips.clear()
    this.gl ??= new GlRenderer()
    this.state = state
    const resolve = opts.resolve ?? defaultResolve
    const { width: W, height: H, fps } = state.canvas

    const loads: Promise<void>[] = []
    for (const track of state.tracks) {
      if (track.kind === 'audio') continue
      for (const clip of track.clips) {
        const plan = resolutionPlanFor(clip, resolve(clip))
        if (!plan) {
          if (clip.kind === 'caption') {
            console.warn(`WebGLPreviewRenderer: clip kind '${clip.kind}' not renderable yet — skipped`)
          }
          continue
        }
        loads.push(
          this.loadSource(clip.id, clip, plan, W, H, fps)
            .then(src => {
              if (this.disposed) { src.dispose(); return }
              this.sources.set(clip.id, src)
            })
            .catch((e) => {
              // Per-clip resilience: a failed source must not kill the preview.
              const msg = e instanceof Error ? e.message : String(e)
              this.loadWarnings.set(clip.id, msg)
              console.warn(`WebGLPreviewRenderer: clip ${clip.id} failed to load — skipped (${msg})`)
            }),
        )
      }
    }
    await Promise.all(loads)
  }

  /** Re-point composition at a replaced state tree WITHOUT reloading sources —
   *  sources are keyed by clip id and stay valid when the clip set is
   *  unchanged (undo/redo replaces the whole tree; see useTimelineStore). */
  setState(state: EditState): void {
    if (this.state) this.state = state
  }

  private async loadSource(clipId: string, clip: Clip, plan: Exclude<ResolutionPlan, null>, W: number, H: number, fps: number): Promise<FrameSource> {
    switch (plan.kind) {
      case 'text':
        return new TextCanvasSource(clip as any, W, H, fps)
      case 'spacetype':
        return new SpaceTypeSource(clip as SpaceTypeClip, fps)
      case 'image':
        return ImageSource.load(plan.url)
      case 'sequence':
        return SequenceSource.load(plan.urls, 0) // in_frame lives in sourceFrame already
      case 'video': {
        if (await this.tooLargeForWebCodecs(plan.url)) {
          console.warn(`WebGLPreviewRenderer: ${plan.url} exceeds WebCodecs size cap — element source`)
          this.inexactClips.set(clipId, 'the file is larger than 96 MB')
          return VideoElementSource.load(plan.url, fps)
        }
        try {
          return await WebCodecsSource.load(plan.url)
        } catch (e) {
          if (e instanceof UnsupportedSourceError) {
            console.warn(`WebGLPreviewRenderer: WebCodecs unavailable for ${plan.url} (${e.message}) — element fallback`)
            this.inexactClips.set(clipId, 'this browser cannot decode its format frame by frame')
            return VideoElementSource.load(plan.url, fps)
          }
          throw e
        }
      }
    }
  }

  private async tooLargeForWebCodecs(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      const len = Number(res.headers.get('content-length'))
      return Number.isFinite(len) && len > WEBCODECS_MAX_BYTES
    } catch {
      return false // unknown size → proceed; the cap is best-effort
    }
  }

  async renderFrame(frame: number, target: HTMLCanvasElement): Promise<void> {
    if (!this.state || !this.gl) throw new Error('WebGLPreviewRenderer: load() first')
    const W = this.state.canvas.width
    const H = this.state.canvas.height

    const dims = new Map<string, { w: number; h: number }>()
    for (const [id, src] of this.sources) dims.set(id, { w: src.width, h: src.height })
    const entries = buildDrawList(this.state, frame, dims)

    for (const e of entries) {
      const src = this.sources.get(e.clipId)!
      const frameImg = await src.getFrame(e.sourceFrame)
      // Static images get a constant version so their texture uploads once;
      // animated sources re-upload per source frame (see GlRenderer.setSource).
      const version = src instanceof ImageSource ? 0 : e.sourceFrame
      this.gl.setSource(e.clipId, frameImg, version)
    }
    this.gl.render(entries, hexToRgb(this.state.canvas.bg_color), W, H)

    target.width = W
    target.height = H
    target.getContext('2d')!.drawImage(this.gl.canvas, 0, 0)
  }

  private disposeSources(): void {
    for (const s of this.sources.values()) s.dispose()
    this.sources.clear()
    this.gl?.clearSources()
  }

  dispose(): void {
    this.disposed = true
    this.disposeSources()
    this.gl?.dispose()
    this.gl = null
    this.state = null
  }
}
