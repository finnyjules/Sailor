/**
 * Ownership gate for engine asset reads that trigger a PAID call (Relight
 * stage 2, Task 1). Mirrors `server/api/moodboards/refs.post.ts:46-63`: in
 * hosted mode, a file recorded as owned by someone else 404s rather than
 * disclosing existence.
 *
 * Local mode is always allowed — no tenants, no ledger, byte-identical to
 * today.
 *
 * Only `input` files are checked against `input_uploads` (the table that
 * tracks who wrote a top-level input). `output`/`temp` files are execution
 * results tracked separately (graph_runs / ownedOutputKeys), which this
 * route has no need to read — a surfaces read of an output/temp source is
 * refused outright in hosted mode rather than guessing at a wider gate.
 */
import type { H3Event } from 'h3'
import { isHosted } from './deployMode'
import { canonicalUploadKey, uploadOwner } from './inputUploads'

export async function assertInputOwned(
  event: H3Event,
  type: 'input' | 'output' | 'temp',
  subfolder: string,
  filename: string,
): Promise<void> {
  if (!isHosted()) return

  if (type !== 'input') {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }

  const userId = (event.context as { userId?: string | null }).userId ?? null
  const owner = await uploadOwner(canonicalUploadKey('input', subfolder, filename))
  if (owner !== null && owner !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }
}
