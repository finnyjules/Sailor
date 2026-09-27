/**
 * A live preview through the runner (step 3, R2.11). Body: { canvasId, nodeId,
 * prompt, pinned } (shared/runner/livePreview.ts). Answers { ui }: the node's
 * `executed` output. Free: nothing is held, recorded or charged, and no run
 * event is sent. 400 a request it can't read or a node that fails, 403 a file
 * that isn't the user's (hosted), 409 a preview that needs a full run (or one
 * a newer one replaced), 413 a request or a picture over the caps, 429 too
 * many previews at once.
 */
import { createError, defineEventHandler, getRequestHeader, readRawBody } from 'h3'
import { runnerEnabled, runnerFamilies } from '../../runner/config'
import { assertRateLimit } from '../../lib/rateLimit'
import { previewArrival, previewDepsOverride, runPreview, type PreviewDeps } from '../../runner/preview'
import { createEngineResultStore } from '../../runner/results'
import { savedInputOwned } from '../../runner/inputs'
import { canonicalUploadKey, engineDirForType, uploadOwner } from '../../utils/inputUploads'
import { ownedOutputKeys, outputKey } from '../../utils/graphRuns'
import { isHosted } from '../../utils/deployMode'

/** The largest request body a preview takes. */
export const PREVIEW_MAX_BODY_BYTES = 2 * 1024 * 1024

let realDeps: PreviewDeps | null = null
function deps(): PreviewDeps {
  const o = previewDepsOverride()
  if (o) return o
  realDeps ??= {
    runnerOn: runnerEnabled,
    families: runnerFamilies,
    hosted: isHosted,
    results: createEngineResultStore({ dirForType: t => engineDirForType(t), hosted: isHosted }),
    ownership: {
      ownsInput: async (userId, f) => (await uploadOwner(canonicalUploadKey('input', f.subfolder, f.filename))) === userId,
      ownsOutput: async (userId, f) => (await ownedOutputKeys(userId)).has(outputKey(f)),
      // Layerize an image's layers (R3.6): saved to the input folder by the user's own run.
      ownsSaved: async (userId, f) => savedInputOwned(userId, f, await ownedOutputKeys(userId)),
    },
  }
  return realDeps
}

const TOO_LARGE = 'This preview request is too large'
const UNREADABLE = 'This preview request can’t be read'

/** A body sent without a length (chunked), read up to the limit. */
async function readLimited(req: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string)
    size += b.length
    if (size > PREVIEW_MAX_BODY_BYTES) throw createError({ statusCode: 413, message: TOO_LARGE })
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  // A slider drag asks often; the browser keeps one request per node in flight.
  assertRateLimit(event, 'runs-preview', 600)
  // The moment it arrived: a later request for the same node replaces this one, never the reverse.
  const arrival = previewArrival()
  // The browser going away stops the preview, from before the body is read: the response's close
  // (the request's closes once its body is read). Let go when the request answers.
  const gone = new AbortController()
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) gone.abort() }
  res?.once?.('close', onClose)
  try {
    const length = getRequestHeader(event, 'content-length')
    if (Number(length ?? 0) > PREVIEW_MAX_BODY_BYTES) throw createError({ statusCode: 413, message: TOO_LARGE })
    const raw = length === undefined && getRequestHeader(event, 'transfer-encoding')
      ? await readLimited(event.node!.req as unknown as AsyncIterable<unknown>)
      : await readRawBody(event, 'utf8')
    if (raw && Buffer.byteLength(raw) > PREVIEW_MAX_BODY_BYTES) throw createError({ statusCode: 413, message: TOO_LARGE })
    let body: unknown
    try { body = raw ? JSON.parse(raw) : null }
    catch { throw createError({ statusCode: 400, message: UNREADABLE }) }
    return await runPreview({ userId: event.context.userId ?? null, body, signal: gone.signal, arrival }, deps())
  }
  finally {
    res?.off?.('close', onClose)
  }
})
