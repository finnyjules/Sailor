// The Scene3D modifier stack: kinds, canonical order, and the one read-through that turns
// ANY primitive — old flat `modifiers` bag or new `modifierStack` — into an ordered list of
// id-stamped instances.
//
// Why read-through rather than migrate-on-load (the pattern proven by the Frame effect stack,
// see [[frame-layer-effect-stack-landed]], and 3D treatments): a stored object is read with a
// raw cast in many places, so a migration would have to write to every object just by opening
// it, and any read site that skipped it would deform a shape differently from the others.
// `modifierStackOf` gives every consumer the same answer with NO writes at all; the move to the
// stored new shape happens only when the user actually edits the stack (`writeModifierStack`).
//
// The fold MUST reproduce exactly which modifiers `applyModifiers` (modifiers.ts) would apply,
// in exactly the order it applies them (MODIFIER_ORDER) — that is what keeps a legacy bag
// byte-identical once Task 2 makes `applyModifiers` a thin wrapper over `applyModifierStack`.
//
// Pure: no three.js, no Vue, no composables. It imports only the specs/arithmetic from
// primParams.ts (MODIFIER_SPECS, modifierValue, totalClones) — the same modifier vocabulary
// `applyModifiers` reads.
import { MODIFIER_SPECS, modifierValue, totalClones } from '~/lib/scene3d/primParams'

/** The seven modifier rows. NOT the geometry `params` bag, NOT the Vary settings — Vary
 *  (varyMode/varySeed/…/varyColorStrength) is a material uniform, never a modifier row. */
export const MODIFIER_KINDS = ['subdivide', 'taper', 'twist', 'bend', 'noise', 'jitter', 'cloner'] as const
export type ModifierKind = typeof MODIFIER_KINDS[number]

/** The order the pipeline applies these in — and therefore the order an old-shape bag is folded
 *  into. This is the byte-identity contract: `applyModifiers` runs subdivide → taper → twist →
 *  bend → noise → jitter → cloner, so a folded bag must list them in exactly this order. */
export const MODIFIER_ORDER = MODIFIER_KINDS

/** Pinned for structural reasons, not convenience: subdivide splits faces BEFORE anything
 *  deforms them (it must run first), and the cloner folds the finished, deformed geometry into
 *  copies (it must run last — clones come after deforms). At most one of each, and they never
 *  move; the deform kinds in between reorder freely. */
export const PINNED_MODIFIERS = ['subdivide', 'cloner'] as const satisfies readonly ModifierKind[]

/** The flat param keys each kind owns, EXACTLY matching MODIFIER_SPECS + the reads in
 *  `applyModifiers`. A folded instance carries these keys as flat number fields; the inspector
 *  reads them the same way. `varyColorStrength` (and the rest of the Vary bag) belongs to NO
 *  kind — it is a material uniform, not a geometry modifier. */
export const MODIFIER_KIND_PARAMS: Record<ModifierKind, string[]> = {
  subdivide: ['subdivide'],
  taper: ['taper', 'taperAxis'],
  twist: ['twist', 'twistAxis'],
  bend: ['bend', 'bendAxis'],
  noise: ['noise', 'noiseScale', 'noiseSeed'],
  jitter: ['jitter', 'jitterMode', 'jitterSeed'],
  cloner: [
    'cloneCount', 'cloneMode', 'cloneOffsetX', 'cloneOffsetY', 'cloneOffsetZ', 'cloneRadius', 'cloneAxis',
    'cloneCountX', 'cloneCountY', 'cloneCountZ', 'cloneSpacingX', 'cloneSpacingY', 'cloneSpacingZ',
    'cloneStepRotX', 'cloneStepRotY', 'cloneStepRotZ', 'cloneStepScale',
  ],
}

/** UI copy: sentence case, human names, never the stored `kind`. */
export const MODIFIER_LABELS: Record<ModifierKind, string> = {
  subdivide: 'Subdivide',
  taper: 'Taper',
  twist: 'Twist',
  bend: 'Bend',
  noise: 'Noise',
  jitter: 'Jitter',
  cloner: 'Cloner',
}

/** A stored modifier row: a stable id, its kind, the eye toggle, and its params flattened onto
 *  the instance (e.g. a twist carries `twist` and `twistAxis`). The flat-number shape matches the
 *  legacy bag exactly, so Task 2's `applyModifierStack` can read each instance like a mini-bag. */
export type ModifierInstance = { id: string; kind: ModifierKind; enabled: boolean } & Record<string, number>

const ORDER_INDEX = new Map<string, number>(MODIFIER_ORDER.map((k, i) => [k, i]))

export const isModifierKind = (v: unknown): v is ModifierKind =>
  typeof v === 'string' && ORDER_INDEX.has(v)

export const isPinnedModifier = (k: ModifierKind): boolean =>
  (PINNED_MODIFIERS as readonly string[]).includes(k)

/** Three coarse regions: subdivide sits alone up front, the cloner alone at the back, and the
 *  deform kinds share the orderable middle. Reorder is closed under the middle — a pinned kind
 *  never moves and nothing crosses a pinned boundary. */
type ModifierRegion = 'first' | 'middle' | 'last'
function regionOf(kind: ModifierKind): ModifierRegion {
  if (kind === 'subdivide') return 'first'
  if (kind === 'cloner') return 'last'
  return 'middle'
}

/** One param's default straight from MODIFIER_SPECS — the single source the fold, `createModifier`
 *  and the inspector controls all agree on. */
function specDefault(key: string): number {
  return MODIFIER_SPECS.find((s) => s.key === key)?.default ?? 0
}

let idCounter = 0
/** A fresh id for a real mutation. Reads use deterministic ids instead — see `modifierStackOf`. */
export function newModifierId(): string {
  return `mod_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}_${++idCounter}`
}

/** A fresh instance with every param at its MODIFIER_SPECS default (so a new deform is the
 *  identity and a new cloner starts at one copy, exactly as the legacy defaults do). */
export function createModifier(kind: ModifierKind): ModifierInstance {
  const inst = { id: newModifierId(), kind, enabled: true } as ModifierInstance
  for (const key of MODIFIER_KIND_PARAMS[kind]) inst[key] = specDefault(key)
  return inst
}

interface StackHost {
  modifiers?: Record<string, number>
  modifierStack?: unknown
}

/**
 * ANY object's ordered, id-stamped modifier stack.
 *
 * New shape (a `modifierStack` array whose every entry carries a string id and a known kind):
 * the stored array IS the user's order — returned untouched, NEVER re-sorted (a duplicated
 * twist-then-bend must stay twist-then-bend). An empty array reads as no modifiers.
 *
 * Old shape (the flat `modifiers` bag, or no stack at all): fold the bag into the canonical-order
 * stack with DETERMINISTIC ids (`mod:<kind>:0` — a random id per read would break selection and
 * motion targets across re-reads), emitting only the kinds that are ACTIVE by the SAME rule
 * `applyModifiers`/`hasModifiers` use. NO writes happen here.
 *
 * The ACTIVE rule, mirrored exactly from `applyModifiers`:
 *  - taper/twist/bend/noise/jitter: active iff its main value !== 0;
 *  - cloner: active iff `totalClones(bag) > 1`;
 *  - subdivide: active iff `round(subdivide) > 0` AND at least one deform is nonzero — because
 *    `applyModifiers` only subdivides inside `if (deforms)`, so a subdivide-only bag is a no-op
 *    and must fold to an EMPTY stack (no subdivide row).
 */
export function modifierStackOf(obj: StackHost | null | undefined): ModifierInstance[] {
  const raw = obj?.modifierStack
  if (Array.isArray(raw)) {
    const valid = raw.every(
      (e): e is ModifierInstance =>
        !!e && typeof e === 'object'
        && typeof (e as { id?: unknown }).id === 'string' && (e as { id: string }).id !== ''
        && isModifierKind((e as { kind?: unknown }).kind),
    )
    // A valid new-shape stack (including an empty one) is authoritative and returned as-is.
    // A malformed array falls through to the legacy fold below, which is the safe answer.
    if (valid) return raw as ModifierInstance[]
  }

  const bag = obj?.modifiers
  const m = (k: string) => modifierValue(bag, k)
  const taper = m('taper'), twist = m('twist'), bend = m('bend'), noise = m('noise'), jitter = m('jitter')
  const deforms = taper !== 0 || twist !== 0 || bend !== 0 || noise !== 0 || jitter !== 0
  const active: Record<ModifierKind, boolean> = {
    // round(subdivide) > 0 AND some deform — matches `applyModifiers`' `if (deforms)` guard.
    subdivide: Math.round(m('subdivide')) > 0 && deforms,
    taper: taper !== 0,
    twist: twist !== 0,
    bend: bend !== 0,
    noise: noise !== 0,
    jitter: jitter !== 0,
    cloner: totalClones(bag) > 1,
  }

  const out: ModifierInstance[] = []
  for (const kind of MODIFIER_ORDER) {
    if (!active[kind]) continue
    const inst = { id: `mod:${kind}:0`, kind, enabled: true } as ModifierInstance
    for (const key of MODIFIER_KIND_PARAMS[kind]) inst[key] = modifierValue(bag, key)
    out.push(inst)
  }
  return out
}

/** The patch that stores a stack on an object and retires the legacy flat bag. Mirrors the
 *  Frame's `writeStackToLayer`: the new shape and the old field must never both be live. */
export function writeModifierStack(stack: ModifierInstance[]): { modifierStack: ModifierInstance[]; modifiers: undefined } {
  return { modifierStack: stack, modifiers: undefined }
}

/** The freely orderable middle rows (every deform), in list order — Task 2 iterates the whole
 *  stack, this is for the inspector's reorderable section. */
export const orderableModifiers = (stack: ModifierInstance[]): ModifierInstance[] =>
  stack.filter((mo) => !isPinnedModifier(mo.kind))

export const pinnedModifier = (stack: ModifierInstance[], kind: ModifierKind): ModifierInstance | undefined =>
  stack.find((mo) => mo.kind === kind)

/** Insert a fresh instance. A pinned kind (subdivide / cloner) lands at its canonical position
 *  and is refused if one is already present. A deform kind is appended to the END of the middle
 *  region — after the last deform, but always before the cloner and after subdivide. */
export function addModifier(stack: ModifierInstance[], kind: ModifierKind): ModifierInstance[] {
  if (isPinnedModifier(kind) && stack.some((mo) => mo.kind === kind)) return stack
  const fresh = createModifier(kind)
  const target = ORDER_INDEX.get(kind) ?? 0
  if (isPinnedModifier(kind)) {
    const at = stack.findIndex((mo) => (ORDER_INDEX.get(mo.kind) ?? 0) > target)
    return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // A deform kind goes to the end of its own (middle) region: right after the last deform, which
  // keeps it before the cloner and after subdivide.
  const region = regionOf(kind)
  const lastSameRegion = stack.reduce((acc, mo, i) => (regionOf(mo.kind) === region ? i : acc), -1)
  if (lastSameRegion >= 0) {
    const at = lastSameRegion + 1
    return [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // No deform yet: sit before the first later-sorting kind (i.e. before a cloner if present).
  const at = stack.findIndex((mo) => (ORDER_INDEX.get(mo.kind) ?? 0) > target)
  return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
}

export function removeModifier(stack: ModifierInstance[], id: string): ModifierInstance[] {
  const next = stack.filter((mo) => mo.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original, with a fresh id. Pinned kinds cannot duplicate (only one
 *  subdivide / cloner is meaningful); two twists both apply, in stack order. */
export function duplicateModifier(stack: ModifierInstance[], id: string): ModifierInstance[] {
  const i = stack.findIndex((mo) => mo.id === id)
  if (i === -1 || isPinnedModifier(stack[i]!.kind)) return stack
  const copy = { ...stack[i]!, id: newModifierId() } as ModifierInstance
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

/** True when `fromId` may be dropped onto `toId`: both exist, both in the orderable middle
 *  (neither pinned), and not the same. Nothing crosses a pinned boundary because a pinned row
 *  can be neither `from` nor `to`. */
export function canReorderModifier(stack: ModifierInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  const from = stack.find((mo) => mo.id === fromId)
  const to = stack.find((mo) => mo.id === toId)
  return !!from && !!to && !isPinnedModifier(from.kind) && !isPinnedModifier(to.kind)
}

/** Move `fromId` to `toId`'s position. A move touching a pinned row is a no-op. */
export function reorderModifier(stack: ModifierInstance[], fromId: string, toId: string): ModifierInstance[] {
  if (!canReorderModifier(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex((mo) => mo.id === fromId)
  // Read `to` from `next` BEFORE the splice removes `from` — reading it after (against the
  // shortened array) yields a stale index that silently undoes a forward drag (from < to).
  const to = next.findIndex((mo) => mo.id === toId)
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** A copy for a duplicated object: same rows, same order, FRESH ids — a shared id would make one
 *  motion track drive both copies (the treatments.ts `cloneTreatments` lesson). */
export function cloneModifierStack(stack: ModifierInstance[] | undefined): ModifierInstance[] | undefined {
  if (!stack?.length) return undefined
  return stack.map((mo) => ({ ...mo, id: newModifierId() }) as ModifierInstance)
}
