/**
 * A shot-directed "Film a shot" (Shot Director, Task 4 of characters stage 3)
 * carries its reference pictures, clips and sounds in `model_options` as
 * `/view?filename=…&type=input` links to the caller's uploaded files. Python
 * resolves them itself (_resolve_local_refs); the runner turns each into a
 * link the provider can fetch (ctx.toUrl), and lists their files so the
 * engine can check they are the caller's own before anything is held.
 */
import { readViewRef } from '#shared/pricing/clipSettings'
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { resolveVideoModelId } from '#shared/runner/eligibility'
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

// ── Reference sizes (R3.11 fix round 1) ─────────────────────────────────────

const MB = 1_000_000
/**
 * The services' stated caps on a Film a shot's reference files, per model
 * (the saved schemas in tests/unit/fixtures/provider-schemas/). A reference is
 * handed off as its raw bytes (Python's `_local_ref_to_data_url` sends the raw
 * file too), so there is no JPEG fallback: one over its cap is refused before
 * the hold. `each`: per file; `total`: the list's files together.
 */
export const SHOT_REF_CAPS: Readonly<Record<string, { name: string; fields: Readonly<Record<string, { kind: 'picture' | 'sound' | 'video'; each?: number; total?: number; source: string }>>; backupFrames?: { bytes: number; source: string } }>> = {
  'seedance-2.0': {
    name: 'Seedance 2.0',
    fields: {
      image_url: { kind: 'picture', each: 30 * MB, source: 'fal image-to-video schema, image_url: "Max 30 MB."' },
      end_image_url: { kind: 'picture', each: 30 * MB, source: 'fal image-to-video schema, end_image_url: "Max 30 MB."' },
      image_urls: { kind: 'picture', each: 30 * MB, source: 'fal reference-to-video schema, image_urls: "Max 30 MB per image."' },
      audio_urls: { kind: 'sound', each: 15 * MB, source: 'fal reference-to-video schema, audio_urls: "Max 15 MB per file."' },
      video_urls: { kind: 'video', total: 50 * MB, source: 'fal reference-to-video schema, video_urls: "total size under 50 MB."' },
    },
  },
  'kling-v3': {
    name: 'Kling 3.0',
    fields: {
      image_url: { kind: 'picture', each: 52_428_800, source: 'fal image-to-video schema, start_image_url: x-fal max_file_size 52428800' },
      end_image_url: { kind: 'picture', each: 52_428_800, source: 'fal image-to-video schema, end_image_url: x-fal max_file_size 52428800' },
      elements: { kind: 'picture', each: 52_428_800, source: 'fal image-to-video schema, element frontal_image_url and reference_image_urls: x-fal max_file_size 52428800' },
    },
    // Its Replicate backup (start_image / end_image, "max 10MB"), only while backups run and no elements are sent.
    backupFrames: { bytes: 10 * MB, source: 'Replicate schema, start_image and end_image: "max 10MB"' },
  },
}

/** Plain words for a reference over its cap, in R3.H's style (pictureTooLargeWords). */
export function shotRefTooLargeWords(kind: 'picture' | 'sound' | 'video', name: string, together = false): string {
  if (kind === 'video') return together ? `These reference videos are too large together for ${name}. Use shorter or smaller videos.` : `This reference video is too large for ${name}. Use a smaller video.`
  if (kind === 'sound') return `This reference sound is too large for ${name}. Use a smaller sound.`
  return `This picture is too large for ${name}. Use a smaller picture.`
}

/** The `/view` input files of one reference field's value (a link, a list of links, or elements' pictures). */
function fieldFiles(key: string, v: unknown): OutputFile[] {
  const names: unknown[] = key === 'elements'
    ? (Array.isArray(v) ? v as Record<string, unknown>[] : []).flatMap(e => [e?.frontal_image_url, ...(Array.isArray(e?.reference_image_urls) ? e.reference_image_urls as unknown[] : [])])
    : Array.isArray(v) ? v : [v]
  const out: OutputFile[] = []
  for (const n of names) {
    const r = readViewRef(n)
    if (r?.name && !r.refused) out.push({ filename: r.name, subfolder: '', type: 'input' })
  }
  return out
}

/**
 * The first Film a shot reference file over its service's stated cap
 * (SHOT_REF_CAPS), or null: checked at the start of a take, before any hold,
 * from each file's size in the store (one whose size can't be told is left
 * to the service). `backupsOn`: backups run, so Kling 3's frames must fit its
 * Replicate backup too (when no elements are sent).
 */
export async function shotRefSizeProblem(
  prompt: ApiPrompt, backupsOn: boolean, size: (f: OutputFile) => Promise<number | null>,
): Promise<{ nodeId: string; classType: string; input: string; message: string } | null> {
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'FilmShotNode' || isLink(n.inputs?.model_options)) continue
    const caps = SHOT_REF_CAPS[resolveVideoModelId(n.inputs?.model)]
    if (!caps) continue
    const adv = parseOptions(n.inputs?.model_options)
    const elements = Array.isArray(adv.elements) && adv.elements.length > 0
    for (const [key, cap] of Object.entries(caps.fields)) {
      const files = fieldFiles(key, adv[key])
      if (!files.length) continue
      const each = caps.backupFrames && backupsOn && !elements && (key === 'image_url' || key === 'end_image_url')
        ? Math.min(cap.each ?? Infinity, caps.backupFrames.bytes)
        : cap.each
      let total = 0
      for (const f of files) {
        const bytes = await size(f)
        if (bytes == null) continue
        total += bytes
        if (each !== undefined && bytes > each) return { nodeId, classType: n.class_type, input: 'model_options', message: shotRefTooLargeWords(cap.kind, caps.name) }
      }
      if (cap.total !== undefined && total > cap.total) return { nodeId, classType: n.class_type, input: 'model_options', message: shotRefTooLargeWords(cap.kind, caps.name, true) }
    }
  }
  return null
}

function parseOptions(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  }
  catch { return {} }
}
