// frontend/app/lib/studio/frameSource.ts
// Cross-studio frame-puller registry. Studios are time-parameterized renderers,
// so a downstream consumer (Shader Studio) can pull any frame at any size rather
// than waiting for a baked file. Sibling of cascade.ts's StudioBaker registry,
// which stays as-is for the single-still bake path.

import { ref } from 'vue'

/**
 * A studio's live frame puller.
 *
 * `getFrame` renders at normalized loop time `t01` (0..1) at the requested pixel
 * size and returns a texture-uploadable surface — usually the studio's own
 * canvas. The returned surface is only valid until the next `getFrame` call on
 * the same source (renderers reuse one canvas), so consumers must upload it to a
 * texture before pulling again.
 *
 * `duration` is the source's natural clock in seconds; `<= 0` means "still".
 *
 * `openExport` (optional): an export session with its OWN renderer, apart from the one the live
 * preview and card share — every asset loaded (or named in `failures`) before the first frame,
 * and no preview render can resize or redraw it between an export's render and its read. A
 * source without one is exported through `getFrame`. The caller always `close()`s it. `frame`'s
 * surface is valid until the next `frame` call.
 */
export interface StudioExportSession {
  /** Assets that could not load, by what a person calls them (`model "Sneaker"`). Non-empty:
   *  do not pull — the frames would show a hole where the asset belongs. `text`: the whole
   *  clause, when the source words it itself (`model "Sneaker" couldn't load — re-generate or
   *  re-upload it`). */
  failures: StudioExportFailure[]
  /** A frame. Rejects with `StudioExportFailed` when an asset the frame started loading could not
   *  load (a decal rebuilt on this frame's sync) — the pull stops and names it. */
  frame(t01: number): TexImageSource | Promise<TexImageSource>
  close(): void
}

export interface StudioExportFailure { name: string; reason: string; text?: string }

/** Thrown by `StudioExportSession.frame` when the frame found an asset that could not load. */
export class StudioExportFailed extends Error {
  constructor(readonly failures: StudioExportFailure[]) {
    super(`export stopped: ${failures.map(f => f.name).join(', ')} couldn't load`)
    this.name = 'StudioExportFailed'
  }
}

/** What a wired layer needs to play live in a Frame export: the studio's own embed player
 *  (`surface` = its embed kind, `bundle` = bundleNameFor(surface, config)) and config.
 *  `width`/`height`: the source's native size (the aspect the player keeps). */
export interface StudioEmbed { surface: string; bundle: string; config: unknown; width: number; height: number; duration: number }

export interface StudioFrameSource {
  getFrame: (t01: number, w: number, h: number) => Promise<TexImageSource>
  duration: number
  fps: number
  width: number
  height: number
  openExport?(size: { width: number; height: number }): Promise<StudioExportSession>
  /** Absent, or resolving null: this source cannot play live faithfully right now — export it
   *  as frames. Never rejects for an ordinary reason; a rejection is treated like null. */
  embed?(): Promise<StudioEmbed | null>
}

const _frameSources = new Map<string, StudioFrameSource>()

// The Map is not reactive, and a frame source is registered from a studio's
// onMounted — often AFTER a downstream consumer has already resolved its input.
// This epoch is bumped on every registration change so a consumer's `sourceKind`
// computed can depend on it and re-resolve, catching a source that registered
// after the consumer first evaluated (the mount-order race that left a wired
// Shader Studio card blank while its modal — opened later — resolved fine).
export const frameSourceEpoch = ref(0)

export function registerStudioFrameSource(id: string, src: StudioFrameSource): void {
  _frameSources.set(id, src)
  frameSourceEpoch.value++
}

export function unregisterStudioFrameSource(id: string): void {
  if (_frameSources.delete(id)) frameSourceEpoch.value++
}

export function getStudioFrameSource(id: string): StudioFrameSource | undefined {
  return _frameSources.get(id)
}

/** True when a source has a real clock — drives whether consumers run a preview loop. */
export function isAnimatedSource(src: StudioFrameSource | undefined | null): boolean {
  return !!src && src.duration > 0
}
