/**
 * In-app clipboard for the Compositor / Frame editor. Pure copy/paste transforms
 * (mirroring layerEdits.duplicateLayers) plus a module-level singleton so paste
 * works ACROSS frame modals within a session. Deep-clones via JSON round-trip —
 * LocalLayer is plain data (see layerEdits duplicateLayers).
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import { isClonableLayer } from '~/lib/compositor/layerEdits'
import { motionForCopies, type MotionDoc } from '~/lib/motionx/adapter/duplicateMotion'

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

export interface ClipboardPayload { layers: LocalLayer[]; groups: LayerGroup[]; motion?: MotionDoc }

/**
 * Deep-clone the selected layers + the group registry entries they reference.
 *
 * `wired` layers are dropped (see `isClonableLayer`): a wired layer names a SLOT,
 * and a slot number only means something inside one frame's graph. Pasted back
 * here it would double up on a live slot; pasted into another frame it would
 * point at a completely different input. A wired-only selection therefore copies
 * NOTHING (returns null) rather than filling the clipboard with a layer no paste
 * could honour.
 */
function layerIdOf(pathOrTarget: string): string | null {
  const m = pathOrTarget.match(/^layers\.([^.]+)\.(.+)$/)
  return m ? m[1]! : null
}

/** `motion` filtered to the entries aimed at a layer in `selectedIds`, with ids
 *  left exactly as they are (no re-targeting, no fresh behaviour ids) — that
 *  happens once, at `materializePaste`, the one true id-remint boundary. */
function motionForCopy(motion: MotionDoc | undefined, selectedIds: Set<string>): MotionDoc {
  const motionx = (motion?.motionx ?? []).filter((t) => { const id = layerIdOf(t.path); return !!id && selectedIds.has(id) })
  const behaviours = (motion?.behaviours ?? []).filter(b => selectedIds.has(b.layerId))
  const tracks = (motion?.tracks ?? []).filter((t) => { const id = layerIdOf(t.target); return !!id && selectedIds.has(id) })
  return JSON.parse(JSON.stringify({ motionx, behaviours, tracks })) as MotionDoc
}

export function extractForCopy(layers: LocalLayer[], groups: LayerGroup[], selectedIds: Set<string>, motion?: MotionDoc): ClipboardPayload | null {
  const sel = layers.filter(l => selectedIds.has(l.id) && isClonableLayer(l))
  if (!sel.length) return null
  const gids = new Set(sel.map(l => l.groupId).filter(Boolean) as string[])
  return {
    layers: JSON.parse(JSON.stringify(sel)) as LocalLayer[],
    groups: JSON.parse(JSON.stringify(groups.filter(g => gids.has(g.id)))) as LayerGroup[],
    motion: motionForCopy(motion, selectedIds),
  }
}

/** Paste a payload into an existing layer set: fresh ids, one new group id per
 *  distinct source group (carrying its name), offset applied, appended on top.
 *
 *  Filters `wired` again on the way IN, not only on the way out: the clipboard is
 *  a module singleton that outlives any one frame, and a payload could also be
 *  hand-built or restored from an older session. Refusing at both ends is what
 *  makes "two live layers can never share a slot" a property of the module rather
 *  than of one call site remembering. */
const noBehaviourId = (): string => { throw new Error('materializePaste: mkBehaviourId is required when the payload carries behaviours') }

export function materializePaste(
  payload: ClipboardPayload,
  layers: LocalLayer[],
  groups: LayerGroup[],
  offset: number,
  mkId: () => string,
  mkGid: () => string,
  mkBehaviourId: () => string = noBehaviourId,
): { layers: LocalLayer[]; groups: LayerGroup[]; newIds: string[]; idMap: Map<string, string>; motion: { motionx: any[]; behaviours: any[]; tracks: any[] } } {
  const groupMap = new Map<string, string>()
  const newIds: string[] = []
  const idMap = new Map<string, string>()
  const clones = payload.layers.filter(isClonableLayer).map((l) => {
    const c = JSON.parse(JSON.stringify(l)) as any
    c.id = mkId(); newIds.push(c.id)
    idMap.set(l.id, c.id)
    c.x = clamp(l.x + offset, -0.5, 1.5)
    c.y = clamp(l.y + offset, -0.5, 1.5)
    if (l.groupId) {
      if (!groupMap.has(l.groupId)) groupMap.set(l.groupId, mkGid())
      c.groupId = groupMap.get(l.groupId)
    }
    return c as LocalLayer
  })
  const newGroups: LayerGroup[] = [...groups]
  for (const [src, nid] of groupMap) {
    const srcG = payload.groups.find(g => g.id === src)
    newGroups.push(srcG?.name ? { id: nid, name: srcG.name } : { id: nid })
  }
  const motion = motionForCopies(payload.motion ?? {}, idMap, mkBehaviourId)
  return { layers: [...layers, ...clones], groups: newGroups, newIds, idMap, motion }
}

// ── OS clipboard payload (cross-frame / cross-project / cross-session) ───────
// The in-session clipboard above is a module singleton, gone the moment the tab
// reloads. To copy layers between projects or sessions the payload has to ride
// the real OS clipboard as text. We tag it with a magic + version so a foreign
// text paste (a URL, some prose, another app's JSON) is cleanly ignored, and so
// a future format change can refuse an old blob instead of mis-parsing it.
const OS_MAGIC = 'sailor.compositor.layers'
const OS_VERSION = 1

interface OSEnvelope { __sailor: string; version: number; payload: ClipboardPayload }

/**
 * Serialize a selection to the string that goes on the OS clipboard's
 * `text/plain`. PURE — no DOM, no clipboard access. `wired` layers are filtered
 * here too (belt-and-braces with `extractForCopy`): a slot number is meaningless
 * outside its own frame's graph, so a wired kind must never leave in the payload.
 * Ids are NOT re-minted here — they are re-minted on the way IN, at
 * `materializePaste` (the same point the in-session path re-mints), so parse +
 * materialize is the one true id-remint boundary.
 */
export function serializeLayersForOS(layers: LocalLayer[], groups: LayerGroup[] = [], motion?: MotionDoc): string {
  const env: OSEnvelope = {
    __sailor: OS_MAGIC,
    version: OS_VERSION,
    payload: {
      layers: JSON.parse(JSON.stringify(layers.filter(isClonableLayer))) as LocalLayer[],
      groups: JSON.parse(JSON.stringify(groups)) as LayerGroup[],
      ...(motion ? { motion: JSON.parse(JSON.stringify(motion)) as MotionDoc } : {}),
    },
  }
  return JSON.stringify(env)
}

/**
 * Parse an OS-clipboard string back into a payload, or `null` if it is not ours
 * (not JSON, missing/utf-wrong magic, unknown version, or no clonable layers
 * survive). Callers hand the result to `materializePaste`, which re-mints ids +
 * offsets + drops any smuggled wired layer — so this stays a pure recogniser.
 */
export function parseLayersFromOS(text: string | null | undefined): ClipboardPayload | null {
  if (!text || typeof text !== 'string') return null
  let obj: any
  try { obj = JSON.parse(text) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  if (obj.__sailor !== OS_MAGIC) return null
  if (obj.version !== OS_VERSION) return null
  const p = obj.payload
  if (!p || !Array.isArray(p.layers)) return null
  const layers = (p.layers as any[]).filter(isClonableLayer) as LocalLayer[]
  if (!layers.length) return null
  const groups = Array.isArray(p.groups) ? (p.groups as LayerGroup[]) : []
  const motion = p.motion && typeof p.motion === 'object' ? (p.motion as MotionDoc) : undefined
  return { layers, groups, ...(motion ? { motion } : {}) }
}

// Shared in-app clipboard (module singleton → cross-frame within a session).
let _clip: ClipboardPayload | null = null
export function setClipboard(p: ClipboardPayload | null): void { _clip = p }
export function getClipboard(): ClipboardPayload | null { return _clip }
export function hasClipboard(): boolean { return !!_clip && _clip.layers.length > 0 }
export function _resetClipboard(): void { _clip = null }
