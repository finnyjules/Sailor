/**
 * Ownership gate for the depth routes' engine asset reads — the free
 * /api/depth/estimate and the paid /api/depth/surfaces (Relight stage 2).
 * Local mode is always allowed — no tenants, no ledger, byte-identical to
 * today. In hosted mode a file the caller may not read 404s rather than
 * disclosing existence.
 *
 * - `input`: checked against `input_uploads` (who wrote a top-level input),
 *   the `moodboards/refs.post.ts` pattern. An unrecorded input passes.
 * - `output`: gated exactly as hosted /view gates it (server/routes/view.get.ts)
 *   — the caller's owned output keys (graph_runs), with one harvest of their
 *   pending runs and a re-check for the race window where the client saw a
 *   run finish before its outputs were recorded. A WIRED layer's image is an
 *   execution output, so without this hosted wired layers got no depth.
 * - `temp`: ungated, as /view leaves it (the documented gap) — this route
 *   discloses nothing /view does not already serve.
 *
 * The output key names the file actually READ: the route reads
 * `<root>/<safeAssetRelPath(filename, subfolder)>`, so a slash inside
 * `filename` moves into the key's subfolder. Keying on the basename with the
 * caller's subfolder instead would let `other/mine.png` borrow `mine.png`.
 */
import type { H3Event } from 'h3'
import { isHosted } from './deployMode'
import { canonicalUploadKey, uploadOwner } from './inputUploads'
import { ownedOutputKeys, outputKey } from './graphRuns'
import { harvestPendingOutputs } from './engineGate'
import { safeAssetRelPath } from './depthCache'

const notFound = () => createError({ statusCode: 404, statusMessage: 'not found' })

export async function assertInputOwned(
  event: H3Event,
  type: 'input' | 'output' | 'temp',
  subfolder: string,
  filename: string,
): Promise<void> {
  if (!isHosted()) return

  const userId = (event.context as { userId?: string | null }).userId ?? null

  if (type === 'temp') return

  if (type === 'output') {
    if (!userId) throw notFound()
    const rel = safeAssetRelPath(filename, subfolder)
    if (!rel) throw notFound()
    const cut = rel.lastIndexOf('/')
    const key = outputKey({
      filename: rel.slice(cut + 1),
      subfolder: cut < 0 ? '' : rel.slice(0, cut),
      type: 'output',
    })
    if ((await ownedOutputKeys(userId)).has(key)) return
    await harvestPendingOutputs(userId)
    if (!(await ownedOutputKeys(userId)).has(key)) throw notFound()
    return
  }

  const owner = await uploadOwner(canonicalUploadKey('input', subfolder, filename))
  if (owner !== null && owner !== userId) throw notFound()
}
