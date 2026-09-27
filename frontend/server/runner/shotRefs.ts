/**
 * A shot-directed "Film a shot" (Shot Director, Task 4 of characters stage 3)
 * carries its reference pictures, clips and sounds in `model_options` as
 * `/view?filename=…&type=input` links to the caller's uploaded files. Python
 * resolves them itself (_resolve_local_refs); the runner turns each into a
 * link the provider can fetch (ctx.toUrl), and lists their files so the
 * engine can check they are the caller's own before anything is held.
 */
import { readViewRef } from '#shared/pricing/clipSettings'
import type { OutputFile } from './types'

const STR_KEYS = ['image_url', 'end_image_url'] as const
const LIST_KEYS = ['image_urls', 'video_urls', 'audio_urls'] as const

export const SHOT_REF_UNREADABLE = 'A reference picture could not be read.'

const isWebLink = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v)

/** A reference as sent: a web link as it is, a `/view` link's file name, or the words it is refused with. */
function readRef(v: unknown): { url: string } | { name: string } | { problem: string } {
  if (isWebLink(v)) return { url: v }
  const r = readViewRef(v)
  if (r?.refused) return { problem: r.refused }
  if (!r?.name) return { problem: SHOT_REF_UNREADABLE }
  return { name: r.name }
}

async function one(v: unknown, toUrl: (f: OutputFile) => Promise<string>): Promise<string> {
  const r = readRef(v)
  if ('problem' in r) throw new Error(r.problem)
  if ('url' in r) return r.url
  return toUrl({ filename: r.name, subfolder: '', type: 'input' })
}

/** Every reference value resolveShotRefs reads, in its order. */
function refValues(adv: Record<string, unknown>): unknown[] {
  const out: unknown[] = []
  for (const k of STR_KEYS) if (adv[k] != null && adv[k] !== '') out.push(adv[k])
  for (const k of LIST_KEYS) if (Array.isArray(adv[k])) out.push(...(adv[k] as unknown[]))
  if (Array.isArray(adv.elements)) {
    for (const e of adv.elements as Record<string, unknown>[]) {
      out.push(e?.frontal_image_url)
      if (Array.isArray(e?.reference_image_urls)) out.push(...(e.reference_image_urls as unknown[]))
    }
  }
  return out
}

/**
 * The words resolveShotRefs would fail with, or null: checked before anything
 * is held (requestRules.ts), so a bad link is refused up front.
 */
export function shotRefProblem(adv: Record<string, unknown>): string | null {
  for (const v of refValues(adv)) {
    const r = readRef(v)
    if ('problem' in r) return r.problem
  }
  return null
}

/** Every input file a shot's options link to (`/view` links only), each once. */
export function shotRefFilenames(adv: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const v of refValues(adv)) {
    const n = readViewRef(v)?.name
    if (n) out.add(n)
  }
  return [...out]
}

/**
 * The options with every reference link resolved, `__shot_directed` removed,
 * and `image_url` taken out as the first frame. A refused link throws its own
 * words; anything else that isn't a web link or a readable `/view` link
 * throws SHOT_REF_UNREADABLE, so a reference is never dropped silently.
 */
export async function resolveShotRefs(
  adv: Record<string, unknown>,
  toUrl: (f: OutputFile) => Promise<string>,
): Promise<{ adv: Record<string, unknown>; firstFrame: string | null }> {
  const next: Record<string, unknown> = { ...adv }
  delete next.__shot_directed
  for (const k of STR_KEYS) if (next[k] != null && next[k] !== '') next[k] = await one(next[k], toUrl)
  for (const k of LIST_KEYS) if (Array.isArray(next[k])) next[k] = await Promise.all((next[k] as unknown[]).map(v => one(v, toUrl)))
  if (Array.isArray(next.elements)) {
    next.elements = await Promise.all((next.elements as Record<string, unknown>[]).map(async e => ({
      frontal_image_url: await one(e?.frontal_image_url, toUrl),
      reference_image_urls: await Promise.all((Array.isArray(e?.reference_image_urls) ? e.reference_image_urls as unknown[] : []).map(v => one(v, toUrl))),
    })))
  }
  const firstFrame = typeof next.image_url === 'string' ? next.image_url : null
  delete next.image_url
  return { adv: next, firstFrame }
}
