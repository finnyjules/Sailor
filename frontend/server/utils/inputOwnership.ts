/**
 * Ownership gate for the depth routes' engine asset reads — the free
 * /api/depth/estimate and the paid /api/depth/surfaces (Relight stage 2).
 * Local mode is always allowed — no tenants, no ledger, byte-identical to
 * today. In hosted mode a file the caller may not read 404s rather than
 * disclosing existence.
 *
 * - `input` and `temp` (LC11): exactly as hosted /view gates them
 *   (native/viewGate.ts hostedGateAllows): an upload row of the caller's, a
 *   file one of their runs saved into their own folder, a Frame Animate clip
 *   of theirs, or a public input folder. A file nobody recorded is not theirs:
 *   a depth map of it would show someone else's picture.
 * - `output`: gated exactly as hosted /view gates it (server/routes/view.get.ts)
 *   — the caller's owned output keys (graph_runs), which the runner records
 *   as each file is saved (no engine history harvest since step 3, R10.9).
 *   A WIRED layer's image is an execution output, so without this hosted
 *   wired layers got no depth.
 *
 * The output key names the file actually READ: the route reads
 * `<root>/<safeAssetRelPath(filename, subfolder)>`, so a slash inside
 * `filename` moves into the key's subfolder. Keying on the basename with the
 * caller's subfolder instead would let `other/mine.png` borrow `mine.png`.
 */
import type { H3Event } from 'h3'
import { isHosted } from './deployMode'
import { ownedOutputKeys, outputKey } from './graphRuns'
import { safeAssetRelPath } from './depthCache'
import { fileGateDecision } from './engineGate'
import { hostedGateAllows } from '../native/viewGate'

const notFound = () => createError({ statusCode: 404, statusMessage: 'not found' })

export async function assertInputOwned(
  event: H3Event,
  type: 'input' | 'output' | 'temp',
  subfolder: string,
  filename: string,
): Promise<void> {
  if (!isHosted()) return

  const userId = (event.context as { userId?: string | null }).userId ?? null

  if (!userId) throw notFound()
  const rel = safeAssetRelPath(filename, subfolder)
  if (!rel) throw notFound()
  const cut = rel.lastIndexOf('/')
  const dir = cut < 0 ? '' : rel.slice(0, cut)
  const base = rel.slice(cut + 1)

  if (type === 'output') {
    const key = outputKey({ filename: base, subfolder: dir, type: 'output' })
    // The runner records each output as it is saved; no engine harvest (R10.9).
    if (!(await ownedOutputKeys(userId)).has(key)) throw notFound()
    return
  }

  // LC11: input and temp answer to the same rule as hosted /view.
  if (!(await hostedGateAllows(userId, fileGateDecision(type, dir, base)))) throw notFound()
}
