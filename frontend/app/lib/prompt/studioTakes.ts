// A studio's take session (useStudioAgent) seen as stage 3's TakesSession, so the
// studios show the same PromptTakes strip as the canvas (spec §2.1a, §3.1; plan
// ruling 8). Pure apart from reading a canvas thumbnail as a data URL.
import { CURRENT, TAKES_PER_SET, type TakeTile, type TakesSession } from '~/lib/prompt/takesSession'
import type { TakeThumb } from '~/lib/agent/takeThumbs'

export const studioTakeId = (i: number): string => `take-${i}`

export function studioTakeIndex(id: string | null): number | null {
  const m = id ? /^take-(\d+)$/.exec(id) : null
  return m ? Number(m[1]) : null
}

export function thumbSrc(t: TakeThumb | undefined): string | null {
  if (!t) return null
  if (typeof t === 'string') return t || null
  try { return typeof t.toDataURL === 'function' ? t.toDataURL() || null : null } catch { return null }
}

export function studioTakesSession<T>(v: {
  label: string; request: string; takes: T[]; thumbs: Map<T, TakeThumb>; current: TakeThumb; selected: T | null
}): TakesSession | null {
  if (!v.takes.length) return null
  const tiles: TakeTile[] = Array.from({ length: TAKES_PER_SET }, (_, i) => {
    const take = v.takes[i]
    if (take === undefined) return { state: 'failed', takeId: null, promptId: null, thumb: null }
    if (!v.thumbs.has(take)) return { state: 'pending', takeId: studioTakeId(i), promptId: null, thumb: null }
    const thumb = thumbSrc(v.thumbs.get(take))
    return thumb
      ? { state: 'ready', takeId: studioTakeId(i), promptId: null, thumb }
      : { state: 'failed', takeId: studioTakeId(i), promptId: null, thumb: null }
  })
  const sel = v.selected ? v.takes.indexOf(v.selected) : -1
  return {
    nodeId: 'studio',
    nodeLabel: v.label,
    request: v.request.trim(),
    currentThumb: thumbSrc(v.current),
    known: [],
    tiles,
    hovered: null,
    chosen: sel >= 0 && sel < TAKES_PER_SET ? studioTakeId(sel) : CURRENT,
  }
}
