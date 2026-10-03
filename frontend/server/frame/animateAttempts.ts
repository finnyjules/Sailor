/**
 * Frame Animate attempts (LC10 fix round 1, Important 1): one small JSON file
 * per attempt, beside the runner's store (.data locally, the volume hosted),
 * so a clip that was paid for is never lost to a closed tab or a Stop.
 *
 * The client names the attempt (a v4 UUID it keeps on the layer as
 * `pendingAnimate`) before it sends it; the route records it (first writer
 * only) with the person, before the paid call, and updates it as it goes:
 *
 *   running  → the model is being asked (nothing paid yet)
 *   keying   → the model's call has settled (paid): the clip is made whatever the client does
 *   done     → the clip folder is in place (`clip`)
 *   stopped  → stopped before anything was paid
 *   failed   → it failed (`paid` says whether it was charged)
 *
 * GET /api/frame/animate/<attempt> answers the owner only. An attempt left
 * `running`/`keying` by a server restart reads as failed after STALE_MS.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storeDir } from '../utils/dataDir'

export type AttemptState = 'running' | 'keying' | 'done' | 'stopped' | 'failed'
export interface AttemptClip { dir: string; frames: number; fps: number; model: string; prompt: string }
export interface AnimateAttempt {
  attempt: string
  userId: string | null
  state: AttemptState
  paid: boolean
  clip?: AttemptClip
  message?: string
  createdAt: number
  updatedAt: number
}

/** A v4 UUID, judged by name before any disk read. */
export const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Longer than any attempt can run (the model's 15-minute poll, then the keying). */
export const STALE_MS = 2 * 60 * 60_000

let dirOverride: string | null = null
export function __setAnimateAttemptsDirForTests(dir: string | null): void { dirOverride = dir }
const attemptsDir = () => dirOverride ?? join(storeDir('data'), 'frame-animate')
const fileOf = (attempt: string) => {
  if (!ATTEMPT_RE.test(attempt)) throw new Error('bad attempt id')
  return join(attemptsDir(), `${attempt}.json`)
}

export class AttemptExists extends Error {}

/** Records a new attempt; AttemptExists when the name is already taken. */
export async function createAttempt(attempt: string, userId: string | null, now = Date.now()): Promise<AnimateAttempt> {
  await mkdir(attemptsDir(), { recursive: true })
  const rec: AnimateAttempt = { attempt, userId, state: 'running', paid: false, createdAt: now, updatedAt: now }
  try { await writeFile(fileOf(attempt), JSON.stringify(rec), { flag: 'wx' }) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AttemptExists('attempt exists')
    throw e
  }
  return rec
}

export async function readAttempt(attempt: string): Promise<AnimateAttempt | null> {
  if (!ATTEMPT_RE.test(attempt)) return null
  try { return JSON.parse(await readFile(fileOf(attempt), 'utf8')) as AnimateAttempt }
  catch { return null }
}

/** Replaces the attempt's fields (written whole, then renamed into place). */
export async function updateAttempt(rec: AnimateAttempt, patch: Partial<Omit<AnimateAttempt, 'attempt' | 'userId' | 'createdAt'>>, now = Date.now()): Promise<AnimateAttempt> {
  Object.assign(rec, patch, { updatedAt: now })
  const file = fileOf(rec.attempt)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(rec))
  await rename(tmp, file)
  return rec
}

/** What the owner is told: a stale running/keying attempt reads as failed. */
export function attemptView(rec: AnimateAttempt, now = Date.now()): { state: AttemptState; paid: boolean; clip?: AttemptClip; message?: string } {
  const stale = (rec.state === 'running' || rec.state === 'keying') && now - rec.updatedAt > STALE_MS
  if (stale) return { state: 'failed', paid: rec.paid, message: 'The clip could not be finished.' }
  return { state: rec.state, paid: rec.paid, ...(rec.clip ? { clip: rec.clip } : {}), ...(rec.message ? { message: rec.message } : {}) }
}
