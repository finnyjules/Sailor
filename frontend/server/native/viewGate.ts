/**
 * The hosted `/view` ownership gate, in one place (step 3, R10.8): GET /view
 * (server/routes/view.get.ts) and every server route that reads a `/view`
 * path itself (./viewRead.ts) apply it before touching the disk.
 */
import { createError } from 'h3'
import { ownedOutputKeys, savedInputKey } from '../utils/graphRuns'
import { viewGateDecision, type ViewGate } from '../utils/engineGate'
import { uploadOwner } from '../utils/inputUploads'
import { userSubfolder } from '../runner/results'
import type { ViewQuery } from './view'

async function ownsAnyRow(userId: string, keys: string[]): Promise<boolean> {
  for (const k of keys) if ((await uploadOwner(k)) === userId) return true
  return false
}

/**
 * Whether a signed-in person may read the file a gate decision names (LC11).
 * - output: a run of theirs recorded it (graph_runs).
 * - input: an upload row of theirs names it, or one of their runs saved it
 *   into their own input folder (the runner's own record kind, as the runner's
 *   start check accepts it: inputs.ts savedInputOwned); a Frame Animate clip
 *   answers to its folder's row; the public folders to everyone.
 * - temp: it is in their own `u_<hash>` folder (the runner's previews, as
 *   /api/runs/preview accepts them), or an upload row of theirs names it.
 * Anything else, a file nobody recorded included, is not theirs.
 */
export async function hostedGateAllows(userId: string, gate: ViewGate): Promise<boolean> {
  switch (gate.kind) {
    case 'reject': return false
    case 'public': return true
    case 'owner': return (await uploadOwner(gate.key)) === userId
    case 'check': return (await ownedOutputKeys(userId)).has(gate.key)
    case 'input': {
      if (await ownsAnyRow(userId, gate.keys)) return true
      return gate.folder === userSubfolder(userId, true)
        && (await ownedOutputKeys(userId)).has(savedInputKey({ filename: gate.filename, subfolder: gate.folder }))
    }
    case 'temp': {
      const own = userSubfolder(userId, true)
      if (gate.folder === own || gate.folder.startsWith(`${own}/`)) return true
      return ownsAnyRow(userId, gate.keys)
    }
  }
}

/**
 * Hosted: refuse a `/view` query that isn't the caller's own (401 signed out,
 * 400 a repeated key, a hashed read or an unknown folder, 404 anything that is
 * not theirs — someone else's and missing alike, so existence is never
 * confirmed). The effective type is the one the resolver will use (an
 * `[output]` annotation outranks `type`). Every folder is gated (LC11): output,
 * input in any subfolder, and temp.
 */
export async function hostedViewGate(userId: string | null | undefined, query: ViewQuery): Promise<void> {
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  // A repeated key is an array; the gate and the resolver must read one name.
  if (Array.isArray(query.filename) || Array.isArray(query.type) || Array.isArray(query.subfolder)) {
    throw createError({ statusCode: 400, message: 'invalid filename' })
  }
  const filename = query.filename ?? ''
  if (!filename) throw createError({ statusCode: 400, message: 'Missing filename' })
  const gate = viewGateDecision({ filename, type: query.type || 'output', subfolder: query.subfolder || '' })
  if (gate.kind === 'reject') throw createError({ statusCode: gate.status, message: gate.message })
  if (!(await hostedGateAllows(userId, gate))) throw createError({ statusCode: 404, message: 'Image not found' })
}
