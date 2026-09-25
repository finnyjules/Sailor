// One set of three takes above the prompt (spec §3.1). Pure: the host feeds it
// the node's takes as they land and asks it what to show. Tiles fill in arrival
// order; `known` holds the takes that existed before the run, so history never
// becomes a tile. `shownTakeId` null means "the version the node had at open",
// which the canvas restores from a DisplaySnapshot.
import { projectTake, type Take } from '~/composables/useTakes'

export const TAKES_PER_SET = 3
/** The "current version" tile's id in hover/choose. */
export const CURRENT = '__current__'

export type TileState = 'pending' | 'ready' | 'failed'
export interface TakeTile { state: TileState; takeId: string | null; promptId: string | null; thumb: string | null }
export interface TakesSession {
  nodeId: string
  nodeLabel: string
  request: string
  currentThumb: string | null
  known: string[]
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

export function openTakes(a: { nodeId: string; nodeLabel: string; request: string; takes: Take[]; images?: string[] | null }): TakesSession {
  return {
    nodeId: a.nodeId,
    nodeLabel: a.nodeLabel,
    request: a.request.trim(),
    currentThumb: a.images?.[0] ?? null,
    known: a.takes.map(t => t.id),
    tiles: Array.from({ length: TAKES_PER_SET }, () => ({ state: 'pending' as const, takeId: null, promptId: null, thumb: null })),
    hovered: null,
    chosen: null,
  }
}

export function ingestTakes(s: TakesSession, takes: Take[]): TakesSession {
  let tiles: TakeTile[] | null = null
  const placed = new Set(s.tiles.map(t => t.takeId).filter(Boolean) as string[])
  for (const t of takes) {
    if (s.known.includes(t.id) || placed.has(t.id)) continue
    const thumb = thumbOf(t)
    if (!thumb) continue
    const cur: TakeTile[] = tiles ?? s.tiles
    // A live re-emission of a run already on a tile arrives as a NEW take id
    // with the same promptId (appendTake replaces it in place): refresh that tile.
    const same = t.promptId != null ? cur.findIndex((x: TakeTile) => x.state === 'ready' && x.promptId === t.promptId) : -1
    const idx = same >= 0 ? same : cur.findIndex((x: TakeTile) => x.state === 'pending')
    if (idx < 0) continue
    const next: TakeTile[] = cur.slice()
    next[idx] = { state: 'ready', takeId: t.id, promptId: t.promptId ?? null, thumb }
    tiles = next
    placed.add(t.id)
  }
  return tiles ? { ...s, tiles } : s
}

export function settleExpected(s: TakesSession, queued: number): TakesSession {
  return { ...s, tiles: s.tiles.map((t, i) => (i >= queued && t.state === 'pending' ? { ...t, state: 'failed' as const } : t)) }
}

export function failPending(s: TakesSession): TakesSession {
  return { ...s, tiles: s.tiles.map(t => (t.state === 'pending' ? { ...t, state: 'failed' as const } : t)) }
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
