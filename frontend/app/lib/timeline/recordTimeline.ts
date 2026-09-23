import type { Clip, EditState } from '~~/shared/timeline/types'
import { computeTotalFrames } from '~~/shared/timeline/types'
import type { ClipPreview } from '~/composables/usePlaybackEngine'
import { WebGLPreviewRenderer, resolutionPlanFor } from '~/lib/engine/webglPreviewRenderer'
import { recordVideo, type RecordResult } from '~/lib/engine/videoRecorder'
import { mixTimelineAudio } from '~/lib/engine/audio/mixdown'

// The timeline recorded in the browser: a private WebGL preview renderer (the
// same draw list, transitions, filters and text the preview shows) draws each
// frame; the audio mix the preview plays becomes the sound track. A clip the
// renderer can only draw ±1 frame, or could not load, is refused by name — an
// export must not quietly contain a wrong frame. A clip the renderer draws
// nothing for at all — a workflow clip with no file yet, or an image/video
// whose asset is missing — is left out, exactly as the server render does,
// and listed by name in skippedClips. Both checks only look at clips on
// tracks the draw list would ever show: a muted track's clips can't refuse
// or vanish from an export that never drew them in the first place.

type RendererLike = Pick<WebGLPreviewRenderer, 'load' | 'renderFrame' | 'dispose' | 'loadWarnings' | 'inexactClips'>

export interface TimelineRecordDeps {
  resolve: (clip: Clip) => ClipPreview | null
  resolveAudioUrl: (clip: Clip) => string | null
  createRenderer?: () => RendererLike
  record?: typeof recordVideo
  mixAudio?: typeof mixTimelineAudio
  createCanvas?: () => HTMLCanvasElement
}

export class TimelineExportRefused extends Error {
  constructor(message: string, readonly clips: string[]) {
    super(message)
    this.name = 'TimelineExportRefused'
  }
}

const KIND_WORDS: Record<string, string> = { lower_third: 'lower third', spacetype: 'Space Type', workflow: 'workflow' }

export function describeClip(clip: Pick<Clip, 'kind' | 'start_frame'>, fps: number): string {
  return `the ${KIND_WORDS[clip.kind] ?? clip.kind} clip at ${(clip.start_frame / fps).toFixed(1)} s`
}

export async function recordTimeline(
  state: EditState,
  deps: TimelineRecordDeps,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; onPhase?: (p: 'mixing' | 'rendering') => void } = {},
): Promise<{ result: RecordResult; skippedAudio: number; skippedClips: string[] }> {
  const { width, height, fps } = state.canvas
  const clips = new Map<string, Clip>()
  for (const t of state.tracks) for (const c of t.clips) clips.set(c.id, c)

  o.onPhase?.('mixing')
  const { buffer, skipped: skippedAudio } = await (deps.mixAudio ?? mixTimelineAudio)(state, deps.resolveAudioUrl)

  // Clips the draw list never shows: muted or audio tracks (same filter as
  // compositor's buildDrawList). A problem reported against one of these must
  // never refuse an export it would never actually affect. An id that names
  // no known clip at all is NOT hidden by this — it still refuses, just
  // without a clip name to give (see describeById below).
  const hiddenClipIds = new Set<string>()
  for (const t of state.tracks) {
    if (t.muted || t.kind === 'audio') for (const c of t.clips) hiddenClipIds.add(c.id)
  }
  const describeById = (id: string): string => {
    const clip = clips.get(id)
    return clip ? describeClip(clip, fps) : 'a clip'
  }

  const renderer = (deps.createRenderer ?? (() => new WebGLPreviewRenderer()))()
  try {
    await renderer.load(state, { resolve: deps.resolve })
    const problems: [string, string][] = []
    for (const [id, why] of renderer.inexactClips) if (!hiddenClipIds.has(id)) problems.push([id, why])
    for (const [id, why] of renderer.loadWarnings) if (!hiddenClipIds.has(id)) problems.push([id, why])
    if (problems.length) {
      const names = problems.map(([id]) => describeById(id))
      throw new TimelineExportRefused(
        `These clips can't be drawn frame-exactly in the browser: ${problems.map(([, why], i) => `${names[i]} (${why})`).join('; ')}.`,
        names,
      )
    }
    // Any clip the renderer will draw nothing for (workflow with no file yet,
    // or any clip whose asset failed to resolve) — same decision table the
    // renderer itself uses, so nothing vanishes unannounced.
    const skippedClips: string[] = []
    for (const t of state.tracks) {
      if (t.muted || t.kind === 'audio') continue
      for (const c of t.clips) if (resolutionPlanFor(c, deps.resolve(c)) === null) skippedClips.push(describeClip(c, fps))
    }
    o.onPhase?.('rendering')
    const scratch = (deps.createCanvas ?? (() => document.createElement('canvas')))()
    const result = await (deps.record ?? recordVideo)({
      width, height, fps, frameCount: computeTotalFrames(state),
      audio: buffer ?? undefined,
      signal: o.signal, onProgress: o.onProgress,
      // renderFrame sizes `scratch` to the timeline and blits its WebGL canvas
      // into it; the recorder's own canvas may be one pixel larger (even size).
      drawFrame: async (i, ctx) => {
        await renderer.renderFrame(i, scratch)
        ctx.drawImage(scratch, 0, 0)
      },
    })
    return { result, skippedAudio, skippedClips }
  } finally {
    renderer.dispose()
  }
}
