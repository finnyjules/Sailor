/**
 * The hosted `/view` ownership gate, in one place (step 3, R10.8): GET /view
 * (server/routes/view.get.ts) and every server route that reads a `/view`
 * path itself (./viewRead.ts) apply it before touching the disk.
 */
import { createError } from 'h3'
import { ownedOutputKeys } from '../utils/graphRuns'
import { viewGateDecision } from '../utils/engineGate'
import { uploadOwner } from '../utils/inputUploads'
import type { ViewQuery } from './view'

/**
 * Hosted: refuse a `/view` query that isn't the caller's own (401 signed out,
 * 400 a repeated key or a hashed read, 404 someone else's output). The
 * effective type is the one the resolver will use (an `[output]` annotation
 * outranks `type`). A Frame Animate clip under input/sailor_clips answers to
 * its owner row (LC10 fix round 1); other input and temp reads stay ungated.
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
  if (gate.kind === 'owner') {
    // A Frame Animate clip: its folder's one owner row (LC10 fix round 1). Missing and
    // someone else's answer alike.
    if ((await uploadOwner(gate.key)) !== userId) throw createError({ statusCode: 404, message: 'Image not found' })
  }
  if (gate.kind === 'check') {
    // The runner records each output the moment it is saved; hosted no longer
    // harvests the engine's history for a late one (step 3, R10.9).
    const owned = await ownedOutputKeys(userId)
    if (!owned.has(gate.key)) throw createError({ statusCode: 404, message: 'Image not found' })
  }
}

