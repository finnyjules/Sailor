/**
 * Id-addressed paths for studio layer stacks.
 *
 * Positional paths (`layers.2.shape.count`) silently re-point when the list is
 * spliced — see `lib/studio/listRemap.ts`, which exists only to patch that up
 * after the fact. A stack whose members carry a **stable id** can be addressed
 * as `<list>.<id>.<rest>` instead, and then reorder is a no-op: nothing to
 * remap, nothing to get wrong.
 *
 * `getByPath`/`setByPath` are naive positional traversal and cannot be handed
 * an id path — `setByPath` would *create* a container named after the id and
 * quietly grow junk into the config, which then gets saved. So an id path must
 * be resolved to a positional one first, and every resolver here refuses rather
 * than guesses:
 *
 *   **An unresolvable id returns `undefined`, never a fabricated index.**
 *
 * That is the whole point. A binding that resolves to nothing is ignored —
 * visible, recoverable, harmless. A binding that resolves to the *wrong* layer
 * is silent and destroys work. `lib/spacetype/fillSwatchPath.ts` takes the same
 * posture for out-of-range swatch indices (read is `null`, write is a no-op)
 * and for the same reason: a dangling binding must never throw and must never
 * touch a neighbour.
 */

import { getByPath, setByPath } from './path'

/** Default field holding a member's stable id. Shader's stack uses `layerId`. */
export const DEFAULT_ID_KEY = 'id'

const isIndex = (k: string): boolean => /^\d+$/.test(k)

export interface IdPathParts {
  /** The list's key in the config, e.g. `appearance`. */
  list: string
  /** The id (or, for an already-positional path, the index as written). */
  key: string
  /** Everything after the member segment. May be empty. */
  rest: string
  /** True when `key` is a positional index rather than an id. */
  positional: boolean
}

/** Split `<list>.<key>.<rest>`. Returns undefined for a path with no member segment. */
export function parseIdPath(path: string): IdPathParts | undefined {
  if (!path) return undefined
  const segs = path.split('.')
  if (segs.length < 2) return undefined
  const [list, key, ...rest] = segs
  if (!list || !key) return undefined
  return { list, key, rest: rest.join('.'), positional: isIndex(key) }
}

const listOf = (cfg: unknown, list: string): unknown[] | undefined => {
  const arr = (cfg as any)?.[list]
  return Array.isArray(arr) ? arr : undefined
}

/**
 * Index of the member carrying `id`, or `undefined`.
 *
 * **Duplicate ids resolve to the lowest index.** They are a data bug (a
 * duplicate-layer action that forgot to mint a fresh id), and the lowest index
 * is the member that already held the id before the clone appeared — so an
 * existing binding keeps pointing at the layer its author meant. This is not a
 * fabricated index: it is a real member that genuinely carries that id.
 * Returning `undefined` instead would break the original binding as well as the
 * clone's, which is strictly worse.
 */
export function indexOfId(cfg: unknown, list: string, id: string, idKey = DEFAULT_ID_KEY): number | undefined {
  const arr = listOf(cfg, list)
  if (!arr) return undefined
  const i = arr.findIndex((m) => (m as any)?.[idKey] === id)
  return i === -1 ? undefined : i
}

/**
 * Resolve `<list>.<id>.<rest>` to `<list>.<index>.<rest>` against a live config.
 *
 * Returns `undefined` when the list is missing or empty, when no member carries
 * the id, or — for an already-positional path — when the index is out of range.
 * An in-range positional path is returned unchanged, so callers can accept
 * either addressing without a second code path.
 */
export function resolveIdPath(cfg: unknown, path: string, idKey = DEFAULT_ID_KEY): string | undefined {
  const p = parseIdPath(path)
  if (!p) return undefined
  const arr = listOf(cfg, p.list)
  if (!arr || arr.length === 0) return undefined
  const i = p.positional ? Number(p.key) : indexOfId(cfg, p.list, p.key, idKey)
  // An out-of-range positional index is just as wrong as an unknown id: it is a
  // slot that is not there, and `setByPath` would happily create it.
  if (i === undefined || i < 0 || i >= arr.length) return undefined
  const out: string[] = [p.list, String(i)]
  if (!p.rest) return out.join('.')
  // NESTED lists (`objects.<id>.treatments.<tid>.amount`): keep walking the live config.
  // Whenever the current container is an array and the next segment is not an index, it
  // is an id inside that array — resolve it the same way, refuse if unknown. Segments past
  // the last existing container are appended as written: an optional leaf that has not
  // been backfilled is a legitimate target (setByIdPath's parent guard decides).
  let cur: unknown = arr[i]
  const restSegs = p.rest.split('.')
  for (let idx = 0; idx < restSegs.length; idx++) {
    const seg = restSegs[idx]!
    const isLast = idx === restSegs.length - 1
    if (Array.isArray(cur)) {
      const j = isIndex(seg) ? Number(seg) : cur.findIndex((m) => (m as any)?.[idKey] === seg)
      if (j < 0 || j >= cur.length) return undefined
      out.push(String(j))
      cur = cur[j]
      continue
    }
    // A non-last segment against a container that is missing entirely is
    // ambiguous — it may be an id meant for a nested list that just isn't
    // there on this member (`objects.B.treatments.t1.amount` when B has no
    // treatments at all) — refuse rather than guess. The LAST segment is
    // always the dial itself and is safe to append even when unbackfilled.
    if (!isLast && (cur == null || typeof cur !== 'object')) return undefined
    out.push(seg)
    cur = cur != null && typeof cur === 'object' ? (cur as any)[seg] : undefined
  }
  return out.join('.')
}

/**
 * The inverse: `<list>.<index>.<rest>` → `<list>.<id>.<rest>`, so a UI can mint
 * a stable binding from a positional one. Returns `undefined` when the index is
 * out of range or the member has no usable id — never a made-up id.
 */
export function toIdPath(cfg: unknown, path: string, idKey = DEFAULT_ID_KEY): string | undefined {
  const p = parseIdPath(path)
  if (!p || !p.positional) return undefined
  const arr = listOf(cfg, p.list)
  const i = Number(p.key)
  if (!arr || i < 0 || i >= arr.length) return undefined
  const id = (arr[i] as any)?.[idKey]
  if (typeof id !== 'string' || id === '') return undefined
  return p.rest ? `${p.list}.${id}.${p.rest}` : `${p.list}.${id}`
}

/** Read through an id path. `undefined` when the id doesn't resolve. */
export function getByIdPath(cfg: unknown, path: string, idKey = DEFAULT_ID_KEY): unknown {
  const resolved = resolveIdPath(cfg, path, idKey)
  return resolved === undefined ? undefined : getByPath(cfg, resolved)
}

/**
 * Write through an id path. Returns `false` (and writes nothing) when the id
 * doesn't resolve, or when the leaf's parent container is absent.
 *
 * The parent guard mirrors `applyMotion`'s: an optional leaf that has not been
 * backfilled is a legitimate target, but a path whose *parent* is missing would
 * make `setByPath` fabricate structure the renderer would then read as real
 * config — and it would be saved.
 */
export function setByIdPath(cfg: unknown, path: string, value: unknown, idKey = DEFAULT_ID_KEY): boolean {
  const resolved = resolveIdPath(cfg, path, idKey)
  if (resolved === undefined) return false
  const lastDot = resolved.lastIndexOf('.')
  const parentPath = lastDot === -1 ? '' : resolved.slice(0, lastDot)
  const parent = parentPath ? getByPath(cfg, parentPath) : cfg
  if (typeof parent !== 'object' || parent === null) return false
  setByPath(cfg, resolved, value)
  return true
}
