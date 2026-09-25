// One set of three takes above the prompt (spec §3.1). Pure: the host feeds it
// the set's runs as they are queued (assignRun), the node's takes as they land,
// and each run's failure, and asks it what to show. Each tile belongs to ONE run
// (its prompt id): only that run's take fills it, so a take from another run
// (an earlier set's late arrival, a plain Run of the node) never becomes a tile.
// `known` holds the takes that existed before the run. `shownTakeId` null means
// "the version the node had at open", which the canvas restores from a DisplaySnapshot.
import { projectTake, type Take } from '~/composables/useTakes'

export const TAKES_PER_SET = 3
/** The "current version" tile's id in hover/choose. */
export const CURRENT = '__current__'

export type TileState = 'pending' | 'ready' | 'failed'
/** Why a failed tile failed, when there is something plainer to say than "Didn't come back":
 *  'credits' — refused for want of credits (the strip gives the credits sentence too); the others
 *  are effect takes the render checks threw away (takeFailureReason). */
export type TileFailReason = 'credits' | 'loop' | 'slow' | 'unchanged' | 'looks'
/** `reason`: a failed tile only. */
export interface TakeTile { state: TileState; takeId: string | null; promptId: string | null; thumb: string | null; reason?: TileFailReason }

const FAILED_TILE_TEXT: Record<TileFailReason, string> = {
  credits: 'Not enough credits',
  loop: 'Didn’t loop cleanly',
  slow: 'Too slow to draw',
  unchanged: 'Changed nothing',
  looks: 'Looked broken',
}
/** What a failed tile says. */
export const failedTileText = (reason: TileFailReason | undefined): string => (reason ? FAILED_TILE_TEXT[reason] : 'Didn’t come back')
export interface TakesSession {
  nodeId: string
  nodeLabel: string
  request: string
  currentThumb: string | null
  known: string[]
  /** The node's active take when the set opened (null: none), what "the version at open" shows. */
  startTakeId: string | null
  tiles: TakeTile[]
  hovered: string | null
  chosen: string | null
  /** Set by the host: false while the Variations run behind this set is still
   *  going (even once every tile has settled), true once it has reported done.
   *  "Three more" waits for it — a new run can't start while one is going. */
  loopDone?: boolean
}

const thumbOf = (t: Take): string | null => t.images?.[0] ?? t.videos?.[0] ?? null
const WORDS = ['No', 'One', 'Two', 'Three']

export function openTakes(a: { nodeId: string; nodeLabel: string; request: string; takes: Take[]; images?: string[] | null; activeTakeId?: string | null }): TakesSession {
  return {
    nodeId: a.nodeId,
    nodeLabel: a.nodeLabel,
    request: a.request.trim(),
    currentThumb: a.images?.[0] ?? null,
    known: a.takes.map(t => t.id),
    startTakeId: a.activeTakeId ?? null,
    tiles: Array.from({ length: TAKES_PER_SET }, () => ({ state: 'pending' as const, takeId: null, promptId: null, thumb: null })),
    hovered: null,
    chosen: null,
  }
}

/** A run of this set was queued: the next tile without a run is its. */
export function assignRun(s: TakesSession, promptId: string): TakesSession {
  if (s.tiles.some(t => t.promptId === promptId)) return s
  const idx = s.tiles.findIndex(t => t.state === 'pending' && t.promptId == null)
  if (idx < 0) return s
  const tiles = s.tiles.slice()
  tiles[idx] = { ...tiles[idx]!, promptId }
  return { ...s, tiles }
}

/** The set's runs (prompt ids), in queue order. */
export const setRunIds = (s: TakesSession): string[] => s.tiles.map(t => t.promptId).filter((p): p is string => !!p)
/** The set's runs still rendering. */
export const pendingRunIds = (s: TakesSession): string[] =>
  s.tiles.filter(t => t.state === 'pending' && t.promptId).map(t => t.promptId!)

export function ingestTakes(s: TakesSession, takes: Take[]): TakesSession {
  let tiles: TakeTile[] | null = null
  for (const t of takes) {
    if (s.known.includes(t.id) || t.promptId == null) continue
    const thumb = thumbOf(t)
    if (!thumb) continue
    const cur: TakeTile[] = tiles ?? s.tiles
    // Only this set's own runs fill its tiles. A live re-emission of a run
    // arrives as a NEW take id with the same promptId (appendTake replaces it
    // in place): it refreshes that tile. A run marked failed by the backstop
    // that lands after all still fills its tile.
    const idx = cur.findIndex((x: TakeTile) => x.promptId === t.promptId)
    if (idx < 0) continue
    const tile = cur[idx]!
    if (tile.state === 'ready' && tile.takeId === t.id && tile.thumb === thumb) continue
    const next: TakeTile[] = cur.slice()
    next[idx] = { state: 'ready', takeId: t.id, promptId: t.promptId, thumb }
    tiles = next
  }
  return tiles ? { ...s, tiles } : s
}

/** The run behind `promptId` failed (or ended with nothing): its tile didn't come back. */
export function failRun(s: TakesSession, promptId: string): TakesSession {
  const idx = s.tiles.findIndex(t => t.promptId === promptId && t.state === 'pending')
  if (idx < 0) return s
  const tiles = s.tiles.slice()
  tiles[idx] = { ...tiles[idx]!, state: 'failed' }
  return { ...s, tiles }
}

/** The Variations loop ended: tiles no run was queued for won't come back. */
export function settleUnqueued(s: TakesSession): TakesSession {
  if (!s.tiles.some(t => t.state === 'pending' && t.promptId == null)) return s
  return { ...s, tiles: s.tiles.map(t => (t.state === 'pending' && t.promptId == null ? { ...t, state: 'failed' as const } : t)) }
}

export function failPending(s: TakesSession): TakesSession {
  return { ...s, tiles: s.tiles.map(t => (t.state === 'pending' ? { ...t, state: 'failed' as const } : t)) }
}

/** `count` failed tiles were refused for want of credits: mark that many (the last ones not
 *  already marked), so they say so instead of "Didn't come back". A set's slots don't map to
 *  its tiles (takes fill them in arrival order), so which failed tiles is by position. */
export function markCreditRefusals(s: TakesSession, count: number): TakesSession {
  let left = count
  if (left <= 0) return s
  const tiles = s.tiles.slice()
  for (let i = tiles.length - 1; i >= 0 && left > 0; i--) {
    if (tiles[i]!.state !== 'failed' || tiles[i]!.reason) continue
    tiles[i] = { ...tiles[i]!, reason: 'credits' }
    left--
  }
  return { ...s, tiles }
}

export const isTakesWorking = (s: TakesSession): boolean => s.tiles.some(t => t.state === 'pending')
export const readyCount = (s: TakesSession): number => s.tiles.filter(t => t.state === 'ready').length

export function takesStatus(s: TakesSession): string {
  const ready = readyCount(s)
  if (isTakesWorking(s)) return ready ? `${ready} of ${TAKES_PER_SET} ready` : 'Working…'
  if (ready === TAKES_PER_SET) return 'Three takes · hover to preview, Keep one'
  if (!ready) return 'No takes came back'
  return `${WORDS[ready]} of three came back · hover to preview, Keep one`
}

export const hoverTile = (s: TakesSession, id: string | null): TakesSession => ({ ...s, hovered: id })
export const chooseTile = (s: TakesSession, id: string): TakesSession => ({ ...s, chosen: id })

export function shownTakeId(s: TakesSession): string | null {
  const pick = s.hovered ?? s.chosen
  return !pick || pick === CURRENT ? null : pick
}

/** The take the node should have active right now: the shown tile's (when the
 *  node has it), else the one it had at open. */
export function wantedActiveTakeId(s: TakesSession, takes: Take[]): string | null {
  const id = shownTakeId(s)
  return id && takes.some(t => t.id === id) ? id : s.startTakeId
}

// --- what the node displays while the strip is open --------------------------

export interface DisplaySnapshot { images?: string[]; audios?: string[]; text?: string; animated?: boolean; activeTakeId: string | null }
type TakeData = { takes?: Take[]; activeTakeId?: string | null; images?: string[]; audios?: string[]; text?: string; animated?: boolean }

export function displaySnapshot(data: TakeData): DisplaySnapshot {
  return { images: data.images, audios: data.audios, text: data.text, animated: data.animated, activeTakeId: data.activeTakeId ?? null }
}

/** The node data with `takeId` shown, or the snapshot restored (null / unknown id). */
export function showOnData<T extends TakeData>(data: T, takeId: string | null, snap: DisplaySnapshot): T {
  const take = takeId ? (data.takes ?? []).find(t => t.id === takeId) : undefined
  return take ? projectTake({ ...data }, take) : { ...data, ...snap }
}

// --- after the strip closes ----------------------------------------------------
// Stop, × and Keep interrupt the set's runs, but one can still land (it was
// already rendering, or it finished as Stop went out). It goes into the node's
// history (it was paid for) but must not become the active take: the canvas
// holds the display the strip closed on and re-applies it when a take from one
// of those runs lands, unless the user has picked another take since.

export interface TakesHold { snap: DisplaySnapshot; promptIds: string[] }

/** The node data after `take` landed (appendTake made it active), or null when
 *  the hold doesn't apply: not one of the held runs, or the user moved on. */
export function holdOnLanding<T extends TakeData>(data: T, take: Pick<Take, 'promptId'>, prevActive: string | null, hold: TakesHold | undefined): T | null {
  if (!hold || take.promptId == null || !hold.promptIds.includes(String(take.promptId))) return null
  if (prevActive !== hold.snap.activeTakeId) return null
  return { ...data, ...hold.snap }
}
