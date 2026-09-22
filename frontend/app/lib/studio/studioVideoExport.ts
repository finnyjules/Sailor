import { recordVideo, isAbortError, type RecordRequest } from '~/lib/engine/videoRecorder'
import { publishVideo } from '~/lib/engine/publishVideo'
import { canRecordInBrowser } from '~/lib/engine/videoExportSupport'

// The studios' one way to make a video. Record in the browser; when that is
// impossible or fails, fall back to the server route — in local mode only, and
// never quietly: the result carries a notice the studio must show.

export interface StudioVideoRequest extends RecordRequest {
  /** Filename prefix for the published file, e.g. 'shader'. */
  prefix: string
  /** True → upload the file to input/ (for Assets / a canvas Video node). */
  publish: boolean
  /** Today's route: bake PNGs, upload, server-encode. Returns null when it
   *  already reported its own failure to the user. */
  serverFallback: () => Promise<{ filename: string; ext: 'mp4' | 'webm' } | null>
}

export interface StudioVideoResult {
  ext: 'mp4' | 'webm'
  /** The file, when the browser made it. */
  blob: Blob | null
  /** input/ filename, when published or made by the server. */
  filename: string | null
  via: 'browser' | 'server'
  /** Shown to the user when set (a fallback happened). */
  notice: string | null
}

export interface StudioVideoDeps {
  hosted: boolean
  forceServer?: boolean
  canRecord?: typeof canRecordInBrowser
  record?: typeof recordVideo
  publish?: typeof publishVideo
}

export async function exportStudioVideo(req: StudioVideoRequest, deps: StudioVideoDeps): Promise<StudioVideoResult | null> {
  const canRecord = deps.canRecord ?? canRecordInBrowser
  const record = deps.record ?? recordVideo
  const publish = deps.publish ?? publishVideo

  let reason = ''   // stays empty only when the server route was chosen on purpose
  if (deps.forceServer && !deps.hosted) {
    // Local escape hatch: go straight to the server route.
  } else if (!(await canRecord({ width: req.width, height: req.height, fps: req.fps, alpha: req.alpha }))) {
    reason = "this browser can't record video"
  } else {
    let rec: Awaited<ReturnType<typeof recordVideo>> | null = null
    try {
      rec = await record(req)
    } catch (err) {
      if (isAbortError(err)) throw err
      console.warn('[video export] browser recording failed', err)
      reason = `the browser could not record it (${err instanceof Error ? err.message : String(err)})`
    }
    if (rec) {
      // An upload failure is NOT a reason to re-make the video on the server:
      // that route uploads far more, and would fail the same way.
      const filename = req.publish ? await publish(rec.blob, rec.ext, req.prefix) : null
      return { ext: rec.ext, blob: rec.blob, filename, via: 'browser', notice: null }
    }
  }

  if (deps.hosted) throw new Error(`Video export failed: ${reason}.`)
  const made = await req.serverFallback()
  if (!made) return null
  return {
    ext: made.ext,
    blob: null,
    filename: made.filename,
    via: 'server',
    notice: reason ? `Made on the server, because ${reason}.` : 'Made on the server (browser recording is switched off).',
  }
}

/** The finished file as a Blob, wherever it was made. */
export async function resultBlob(r: StudioVideoResult, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  if (r.blob) return r.blob
  if (!r.filename) throw new Error('video export: nothing to download')
  const res = await fetchImpl(`/view?${new URLSearchParams({ filename: r.filename, type: 'input' })}`)
  if (!res.ok) throw new Error(`/view returned ${res.status}`)
  return res.blob()
}

/** What a studio shows when an export fails: our own plain messages as they
 *  are, anything else (a bug) as a pointer to the console. */
export function videoErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (msg.startsWith('Video export failed') || msg.startsWith('This video is larger')) return msg
  return 'Video export failed — see console.'
}
