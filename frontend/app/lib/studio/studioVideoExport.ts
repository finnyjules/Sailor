import { recordVideo, isAbortError, throwIfAborted, type RecordRequest } from '~/lib/engine/videoRecorder'
import { publishVideo, HOSTED_UPLOAD_LIMIT } from '~/lib/engine/publishVideo'
import { canRecordInBrowser } from '~/lib/engine/videoExportSupport'

// The studios' one way to make a video: record it in the browser (WebCodecs,
// through mediabunny). There is no server route (engine-free step 3, spec
// ruling 7): when the browser can't make it, the export fails and says why,
// locally as in hosted.

export interface StudioVideoRequest extends RecordRequest {
  /** Filename prefix for the published file, e.g. 'shader'. */
  prefix: string
  /** True → upload the file to input/ (for Assets / a canvas Video node). */
  publish: boolean
  /** A short status line for the footer, e.g. 'Uploading…'. */
  onStatus?: (text: string) => void
}

export interface StudioVideoResult {
  ext: 'mp4' | 'webm'
  /** The file the browser made. */
  blob: Blob
  /** input/ filename, when published. */
  filename: string | null
}

export interface StudioVideoDeps {
  hosted: boolean
  canRecord?: typeof canRecordInBrowser
  record?: typeof recordVideo
  publish?: typeof publishVideo
}

export async function exportStudioVideo(req: StudioVideoRequest, deps: StudioVideoDeps): Promise<StudioVideoResult> {
  const canRecord = deps.canRecord ?? canRecordInBrowser
  const record = deps.record ?? recordVideo
  const publish = deps.publish ?? publishVideo

  if (!(await canRecord({ width: req.width, height: req.height, fps: req.fps, alpha: req.alpha }))) {
    throw new Error("Video export failed: this browser can't record video.")
  }
  let rec: Awaited<ReturnType<typeof recordVideo>>
  try {
    rec = await record(req)
  } catch (err) {
    if (isAbortError(err)) throw err
    // The encoder's own text (e.g. "EncodingError: …") stays in the console;
    // the footer gets a plain reason.
    console.warn('[video export] browser recording failed', err)
    throw new Error("Video export failed: the browser's video encoder failed.")
  }
  // Cancel pressed as the recording finished: stop before uploading.
  throwIfAborted(req.signal)
  let filename: string | null = null
  if (req.publish) {
    // Hosted uploads are capped; say so before sending 100 MB for nothing.
    if (deps.hosted && rec.blob.size > HOSTED_UPLOAD_LIMIT) {
      throw new Error('This video is larger than 100 MB, the upload limit.')
    }
    req.onStatus?.('Uploading…')
    // Cancel during the upload aborts the request itself (no file lands);
    // the check after it covers an abort as the response arrives.
    filename = await publish(rec.blob, rec.ext, req.prefix, undefined, req.signal)
    throwIfAborted(req.signal)
  }
  return { ext: rec.ext, blob: rec.blob, filename }
}

/** What a studio shows when an export fails: our own plain messages as they
 *  are, anything else (a bug) as a pointer to the console. */
export function videoErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (msg.startsWith('Video export failed') || msg.startsWith('This video is larger')) return msg
  return 'Video export failed — see console.'
}
