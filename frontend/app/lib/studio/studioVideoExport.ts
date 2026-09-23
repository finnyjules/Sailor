import { recordVideo, isAbortError, throwIfAborted, type RecordRequest } from '~/lib/engine/videoRecorder'
import { publishVideo, HOSTED_UPLOAD_LIMIT } from '~/lib/engine/publishVideo'
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
   *  already reported its own failure to the user. Gets the request's signal,
   *  and must stop (throwIfAborted) between frames when it is aborted. */
  serverFallback: (signal?: AbortSignal) => Promise<{ filename: string; ext: 'mp4' | 'webm' } | null>
  /** A short status line for the footer, e.g. 'Uploading…'. */
  onStatus?: (text: string) => void
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
      // The encoder's own text (e.g. "EncodingError: …") stays in the console;
      // the footer gets a plain reason.
      console.warn('[video export] browser recording failed', err)
      reason = "the browser's video encoder failed"
    }
    if (rec) {
      // Cancel pressed as the recording finished: stop before uploading.
      throwIfAborted(req.signal)
      let filename: string | null = null
      if (req.publish) {
        // Hosted uploads are capped; say so before sending 100 MB for nothing.
        if (deps.hosted && rec.blob.size > HOSTED_UPLOAD_LIMIT) {
          throw new Error('This video is larger than 100 MB, the upload limit.')
        }
        // An upload failure is NOT a reason to re-make the video on the server:
        // that route uploads far more, and would fail the same way.
        req.onStatus?.('Uploading…')
        // Cancel during the upload aborts the request itself (no file lands);
        // the check after it covers an abort as the response arrives.
        filename = await publish(rec.blob, rec.ext, req.prefix, undefined, req.signal)
        throwIfAborted(req.signal)
      }
      return { ext: rec.ext, blob: rec.blob, filename, via: 'browser', notice: null }
    }
  }

  if (deps.hosted) throw new Error(`Video export failed: ${reason}.`)
  const made = await req.serverFallback(req.signal)
  // Cancel pressed while the server encoded: same rule as the upload.
  throwIfAborted(req.signal)
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
