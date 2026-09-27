/**
 * Face scores on Shot Director takes — the pure half (Task 10).
 *
 * A Shot Director studio stores its FilmShotNode's id as
 * `properties.sailor_shotDirectorTargetId`. The film node shows nothing
 * itself: its video take lands on the Video card wired after it. When such a
 * take arrives, the canvas samples three frames (takeFrames.ts), asks
 * `/api/characters-local/take-check` once per cast member, and stores the
 * answers on that take (`Take.faceScores`). The Shot Director surface shows
 * the latest take's answers as chips.
 *
 * Everything here is pure except `scoreTakeFrames`, whose I/O is injected.
 */
import type { TakeFaceScore, CheckVerdict } from '#shared/characters/types'
import type { Take, TakeBearingData } from '~/composables/useTakes'
import { hydrateShotSheet } from './hydrate'

export interface CastPick { slug: string; stateId: string | null }

interface LiteNode { id: string | number; data?: any }
interface LiteEdge { source: string | number; target: string | number }

/** The studio's cast as `{ slug, stateId }` — who a take is scored against. */
export function castToScore(studioData: any): CastPick[] {
  const raw = studioData?.properties?.sailor_shotDirector
  if (!raw) return []
  return hydrateShotSheet(raw).cast
    .filter(m => typeof m.slug === 'string' && m.slug)
    .map(m => ({ slug: m.slug, stateId: m.stateId ?? null }))
}

/**
 * Node data with take `takeId`'s scores set. Other takes keep their identity.
 * A take that already has scores is left alone (each take is scored once);
 * an unknown take id returns `data` unchanged.
 */
export function withFaceScores<T extends TakeBearingData>(data: T, takeId: string, scores: TakeFaceScore[]): T {
  const takes = data.takes ?? []
  const i = takes.findIndex(t => t.id === takeId)
  if (i < 0 || takes[i]!.faceScores) return data
  const next = takes.slice()
  next[i] = { ...takes[i]!, faceScores: scores }
  return { ...data, takes: next }
}

const VIDEO_FILE = /\.(mp4|webm|mov|m4v)(?:$|[?&#])/i

/** The take's video URL, or null. Video cards carry the clip in `images` (PreviewVideo's envelope). */
export function takeVideoUrl(take: Pick<Take, 'videos' | 'images'> | null | undefined): string | null {
  if (take?.videos?.length) return take.videos[0]!
  for (const url of take?.images ?? []) {
    if (VIDEO_FILE.test(url)) return url
    try {
      const name = new URL(url, 'http://x').searchParams.get('filename')
      if (name && VIDEO_FILE.test(name)) return url
    } catch { /* not a URL */ }
  }
  return null
}

function isStudio(n: LiteNode): boolean {
  return n.data?.nodeType === 'ShotDirector'
}

/** The studio whose target node is `filmId`, or null. */
function studioTargeting(nodes: LiteNode[], filmId: string): LiteNode | null {
  return nodes.find(n => isStudio(n) && n.data?.properties?.sailor_shotDirectorTargetId != null
    && String(n.data.properties.sailor_shotDirectorTargetId) === filmId) ?? null
}

/**
 * The Shot Director studio a take on `executedNodeId` belongs to: the node is
 * wired from (or is itself) some studio's stored film target. Null otherwise.
 */
export function shotStudioForTake(nodes: LiteNode[], edges: LiteEdge[], executedNodeId: string): LiteNode | null {
  const id = String(executedNodeId)
  const direct = studioTargeting(nodes, id)
  if (direct) return direct
  for (const e of edges) {
    if (String(e.target) !== id) continue
    const s = studioTargeting(nodes, String(e.source))
    if (s) return s
  }
  return null
}

/**
 * The latest video take's scores among the cards wired from the studio's
 * target (and the target itself). Empty until that take is scored.
 */
export function latestShotTakeScores(nodes: LiteNode[], edges: LiteEdge[], studioId: string): TakeFaceScore[] {
  const studio = nodes.find(n => String(n.id) === String(studioId))
  const targetId = studio?.data?.properties?.sailor_shotDirectorTargetId
  if (targetId == null) return []
  const t = String(targetId)
  const ids = new Set([t, ...edges.filter(e => String(e.source) === t).map(e => String(e.target))])
  let latest: Take | null = null
  for (const n of nodes) {
    if (!ids.has(String(n.id))) continue
    for (const take of (n.data?.takes ?? []) as Take[]) {
      if (!takeVideoUrl(take)) continue
      if (!latest || (take.createdAt ?? 0) >= (latest.createdAt ?? 0)) latest = take
    }
  }
  return latest?.faceScores ?? []
}

export interface FaceScoreChip { text: string; tone: 'plain' | 'amber'; tip: string }

const TIP: Record<CheckVerdict, (name: string) => string> = {
  'match': n => `Looks like ${n}`,
  'unsure': n => `May not be ${n}`,
  'different': n => `Doesn't look like ${n}`,
  'no-face': () => 'No face found',
}

/** Label, tone and tooltip for one face score chip. */
export function faceScoreChip(score: TakeFaceScore): FaceScoreChip {
  const text = score.verdict === 'no-face'
    ? `${score.name}: no face`
    : typeof score.best === 'number' ? `${score.name} ${Math.round(score.best)}` : score.name
  const tone = score.verdict === 'unsure' || score.verdict === 'different' ? 'amber' : 'plain'
  const base = (TIP[score.verdict] ?? TIP.unsure)(score.name)
  return { text, tone, tip: score.note ? `${base}: ${score.note}` : base }
}

export interface TakeCheckDeps {
  /** Frames of the take as JPEG data URLs (takeFrames.sampleTakeFrames in the app). */
  sample: (videoUrl: string) => Promise<string[]>
  /** POST the take-check body; resolves with the HTTP status and parsed JSON. */
  post: (body: { slug: string; stateId: string | null; frames: string[] }) => Promise<{ status: number; body: any }>
}

/**
 * Score a take's frames against each cast member. Never throws: a member whose
 * check fails is left out (logged, except a 501 — hosted Photo characters
 * have no face check yet, which is not an error worth a warning).
 */
export async function scoreTakeFrames(videoUrl: string, cast: CastPick[], deps: TakeCheckDeps): Promise<TakeFaceScore[]> {
  let frames: string[]
  try {
    frames = await deps.sample(videoUrl)
  } catch (err) {
    console.warn('[shot-director] could not read frames from the take', err)
    return []
  }
  if (!frames.length || !cast.length) return []
  const out: TakeFaceScore[] = []
  for (const m of cast) {
    try {
      const res = await deps.post({ slug: m.slug, stateId: m.stateId, frames })
      if (res.status === 501) continue
      if (res.status < 200 || res.status >= 300) {
        console.warn(`[shot-director] face check for ${m.slug} failed (${res.status})`, res.body?.message ?? '')
        continue
      }
      const b = res.body ?? {}
      const score: TakeFaceScore = {
        slug: String(b.slug ?? m.slug),
        name: String(b.name ?? m.slug),
        best: typeof b.best === 'number' ? b.best : null,
        verdict: b.verdict as CheckVerdict,
      }
      if (typeof b.note === 'string' && b.note) score.note = b.note
      out.push(score)
    } catch (err) {
      console.warn(`[shot-director] face check for ${m.slug} failed`, err)
    }
  }
  return out
}
