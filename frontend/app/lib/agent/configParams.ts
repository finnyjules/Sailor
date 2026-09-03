import type { Params, ParamValue } from '~/lib/spacetype/effect'

/**
 * Bridge a nested reactive config object (Gradient/Shader studios use a single
 * `config` ref with deep nesting) to the flat `Params` shape that useStudioAgent
 * + describeControls/validatePatch expect.
 *
 * Keys are dotted paths resolved against the root, e.g. `flow.intensity` →
 * root.flow.intensity. A leading `layer.` segment resolves against
 * root[listKey][activeLayer()] so per-layer controls follow the active selection.
 * Reads and writes go straight through to the reactive object, so mutating a key
 * triggers the studio's deep watcher and re-renders. Missing intermediate
 * objects are created on write (mirrors the surfaces' own `??=` guards).
 *
 * `listKey` is the name of the array the `layer.` prefix expands against.
 * Gradient and Shape store theirs at `layers`, which stays the default; Vector
 * Type's appearance stack lives at `appearance`. Without the parameter a
 * `layer.*` key on that studio would resolve against a `layers` array that does
 * not exist — reads would be `undefined` and writes would be dropped on the
 * floor, silently, which is the exact class of failure the dotted keys are
 * pinned by a test to avoid.
 *
 * ## `<listKey>.<id>.<rest>` — addressing ONE member, whichever slot it is in
 *
 * The `layer.` prefix always means "the active one", which is right for an
 * inspector and wrong for anything persisted: a Collection binding or an agent
 * patch that says "the stroke" must keep meaning that stroke after the user
 * reorders the stack or selects something else. So an ABSOLUTE member path is
 * accepted too, and its member segment may be a stable **id** instead of an
 * index — `appearance.Lstroke.width`.
 *
 * `getByPath`/`setByPath` are naive traversal: handed `appearance.Lstroke.width`
 * they would create a property literally named `Lstroke` ON THE ARRAY and write
 * into it, growing junk that is then saved and never read. So the id is resolved
 * to a real position first, via the shared `indexOfId`, and an id that resolves
 * to nothing makes the whole key **dead** — reads are `undefined`, writes are
 * dropped. That is the one behaviour that matters: a binding to a deleted layer
 * must degrade to ignored, never to whichever layer slid into its slot.
 *
 * Additive for the other studios: an all-digit member segment is still a plain
 * index, and no other studio declares a key beginning `<listKey>.`.
 *
 * ## `extraLists` — a SECOND id-addressed list, nested arbitrarily deep
 *
 * `listKey` (+ its `layer.` relative prefix) is still exactly one list, one
 * level below the root — everything above was already true before this
 * parameter existed. `extraLists` adds more of the SAME `<key>.<id>.<rest>`
 * addressing for lists whose ADDRESS (the prefix a control key spells) is not
 * the same as where the array actually lives: Vector Type's moves stack is
 * addressed `moves.<id>.duration` (short, matching `appearance.<id>.*`'s own
 * grammar — see `vectortype/agentControls.ts`'s `vtMoveFieldControls`), but it
 * actually lives at `cfg.motion.moves`, nested under the clip. `key` is the
 * address prefix (what a control's own key starts with); `at` is the real
 * dotted path to the array from the config root, defaulting to `key` itself
 * for the common case where the two are the same word (a list living at the
 * config's top level, addressed by that same name). Each entry can name its
 * own `idKey` (defaults to `'id'`, matching every stack in this codebase so
 * far); resolution is identical in every other respect to the primary
 * `listKey` — duplicate ids resolve to the lowest index, an unresolvable id or
 * an out-of-range index makes the key dead (read `undefined`, write a no-op),
 * never a fabricated container. `listKey` is checked first, so a caller that
 * also uses it for `layer.*` sees no change in precedence.
 */
type AnyObj = Record<string, unknown>

const isIndex = (k: string): boolean => /^\d+$/.test(k)

export interface ExtraIdList {
  /** The address prefix a control key starts with — e.g. `'moves'` for `moves.<id>.duration`. */
  key: string
  /** Dotted path to the array from the config root — e.g. `'motion.moves'`. Defaults to `key`. */
  at?: string
  /** Field holding a member's stable id. Defaults to `'id'`. */
  idKey?: string
}

/** Walk `obj` down `segs` (each a plain property name), stopping at the first
 *  non-object. Shared by the relative-prefix and absolute-id branches below,
 *  and by every entry in `extraLists`, so a nested list resolves exactly the
 *  same way a top-level one always did. */
function walk(obj: AnyObj | null, segs: readonly string[]): unknown {
  let cur: unknown = obj
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as AnyObj)[s]
  }
  return cur
}

/** `indexOfId`'s rule (lowest index wins a duplicate), applied to an
 *  ALREADY-RESOLVED array rather than re-deriving it from `cfg[list]` — the
 *  nested lists this module resolves are not one property lookup, so the
 *  single-segment `~/lib/studio/idPath.ts` helper cannot be reused as-is;
 *  this is that same logic, generalised to any list already in hand. */
function indexInList(list: readonly unknown[], id: string, idKey: string): number | undefined {
  const i = list.findIndex((m) => (m as AnyObj | null)?.[idKey] === id)
  return i === -1 ? undefined : i
}

export function makeConfigParams(
  root: () => unknown,
  activeLayer: () => number = () => 0,
  listKey = 'layers',
  idKey = 'id',
  /** The RELATIVE prefix — "the active member of `listKey`". Was hard-coded to
   *  'layer'; parameterized for Scene3D, whose members are objects and whose
   *  natural relative prefix is therefore `object.` (its `primitive` macro
   *  re-describes against the object it just created, and the model addresses
   *  that object relatively because it cannot know the new id). Defaults to
   *  'layer', so every existing caller is unaffected.
   *
   *  An `activeLayer()` that resolves to no member (e.g. -1) makes the whole
   *  relative key DEAD — read `undefined`, write dropped — the same posture the
   *  absolute `<listKey>.<id>.` path already takes for an unresolvable id. That
   *  matters: without it a relative key would fall through to the root and the
   *  write below would fabricate a bogus top-level `object` property. */
  relativePrefix = 'layer',
  extraLists: readonly ExtraIdList[] = [],
): Params {
  const lists = [{ key: listKey, at: listKey, idKey }, ...extraLists.map(l => ({ ...l, at: l.at ?? l.key }))]

  function base(key: string): { obj: AnyObj | null; parts: string[] } {
    const parts = key.split('.')
    let obj = root() as AnyObj | null
    if (parts[0] === relativePrefix) {
      const layers = walk(obj, [listKey]) as AnyObj[] | undefined
      obj = layers?.[activeLayer()] ?? null
      parts.shift()
      return { obj, parts }
    }
    for (const l of lists) {
      const addrSegs = l.key.split('.')
      if (parts.length <= addrSegs.length || !addrSegs.every((s, i) => parts[i] === s)) continue
      // Refuse rather than guess — see the header. `null` makes read `undefined`
      // and write a no-op, so nothing is fabricated on the array.
      //
      // An OUT-OF-RANGE positional index is refused for the same reason an
      // unknown id is: `write` creates missing containers, so `appearance.5.width`
      // on a two-layer stack would grow a sparse array of empty objects that the
      // renderer then reads as real layers. `resolveIdPath` takes exactly this
      // posture (`lib/studio/idPath.ts`).
      const member = parts[addrSegs.length]!
      const locSegs = l.at.split('.')
      const list = walk(obj, locSegs)
      if (!Array.isArray(list)) return { obj: null, parts }
      const i = isIndex(member) ? Number(member) : indexInList(list, member, l.idKey ?? 'id')
      if (i === undefined || i < 0 || i >= list.length) return { obj: null, parts }
      // The REAL absolute path from root — `locSegs` may differ from `addrSegs`
      // (moves.<id>.duration addresses `motion.moves.<i>.duration`), so this is
      // built fresh rather than patched in place over the address's own parts.
      return { obj, parts: [...locSegs, String(i), ...parts.slice(addrSegs.length + 1)] }
    }
    return { obj, parts }
  }

  function read(key: string): ParamValue | undefined {
    const { obj, parts } = base(key)
    let cur: unknown = obj
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined
      cur = (cur as AnyObj)[p]
    }
    return cur as ParamValue | undefined
  }

  function write(key: string, value: ParamValue): void {
    const { obj, parts } = base(key)
    if (!obj) return
    let cur: AnyObj = obj
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!
      let next = cur[p]
      if (next == null || typeof next !== 'object') { next = {}; cur[p] = next }
      cur = next as AnyObj
    }
    cur[parts[parts.length - 1]!] = value
  }

  return new Proxy({} as Params, {
    get: (_t, key) => (typeof key === 'string' ? read(key) : undefined),
    set: (_t, key, value) => { if (typeof key === 'string') write(key, value as ParamValue); return true },
    has: (_t, key) => (typeof key === 'string' ? read(key) !== undefined : false),
  })
}
