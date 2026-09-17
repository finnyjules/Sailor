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

/** The modifier rows. NOT the geometry `params` bag, NOT the Vary settings — Vary
 *  (varyMode/varySeed/…/varyColorStrength) is a material uniform, never a modifier row.
 *  `array`/`shatter`/`mirror` are geometry PRODUCERS (they change the vertex buffer — array folds N
 *  rotated copies, shatter splits every face, mirror duplicates + welds), living in the orderable
 *  middle between the deforms and the pinned cloner. */
export const MODIFIER_KINDS = ['subdivide', 'taper', 'twist', 'bend', 'noise', 'jitter', 'shear', 'spherify', 'smooth', 'melt', 'lattice', 'array', 'shatter', 'mirror', 'decimate', 'voxelise', 'boolean', 'facet', 'cloner'] as const
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
  shear: ['shear', 'shearAxis'],
  spherify: ['spherify'],
  smooth: ['smoothStrength', 'smoothIterations'],
  melt: ['melt', 'meltAxis'],
  lattice: ['latticeBulge', 'latticeAxis', 'latticeBias'],
  array: ['radialCount', 'radialAxis', 'radialRadius'],
  shatter: ['shatter', 'shatterSeed'],
  mirror: ['mirrorAxis', 'mirrorOffset'],
  decimate: ['decimate'],
  voxelise: ['voxelResolution'],
  // boolean owns ONLY its numeric dials here. `refObjectId` (the sibling to combine with) is a
  // STRING id, not a numeric spec, so it lives on the instance outside MODIFIER_KIND_PARAMS —
  // set by the inspector's dynamic "Combine with" picker, carried by duplicate, and preserved by
  // sanitizeModifierStack below. Keeping it out of this list is what lets `createModifier` and the
  // generic inspector/agent/motion surfaces stay purely numeric.
  boolean: ['booleanOp', 'booleanBlend', 'booleanResolution'],
  facet: ['facetCount', 'facetJitter', 'facetSeed'],
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
  shear: 'Shear',
  spherify: 'Spherify',
  smooth: 'Smooth',
  melt: 'Melt',
  lattice: 'Lattice',
  array: 'Radial array',
  shatter: 'Shatter',
  mirror: 'Mirror',
  decimate: 'Decimate',
  voxelise: 'Voxelise',
  boolean: 'Boolean',
  facet: 'Facets',
  cloner: 'Cloner',
}

/** A stored modifier row: a stable id, its kind, the eye toggle, and its params flattened onto
 *  the instance (e.g. a twist carries `twist` and `twistAxis`). The flat-number shape matches the
 *  legacy bag exactly, so Task 2's `applyModifierStack` can read each instance like a mini-bag. */
export type ModifierInstance = { id: string; kind: ModifierKind; enabled: boolean; refObjectId?: string } & Record<string, number>

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
    // These deformers were never part of the legacy flat bag, so they never fold active —
    // an old scene had no shear/spherify/smooth/melt keys, exactly as with the producer below.
    shear: false,
    spherify: false,
    smooth: false,
    melt: false,
    // The lattice cage deformer never lived in the legacy flat bag either, so it never folds active.
    lattice: false,
    // Geometry producers never lived in the legacy flat bag, so they never fold active.
    array: false,
    shatter: false,
    mirror: false,
    // decimate/voxelise/boolean never lived in the legacy flat bag either — an old scene has no
    // such keys and no refObjectId, so they never fold active.
    decimate: false,
    voxelise: false,
    boolean: false,
    // The facet producer never lived in the legacy flat bag either, so it never folds active.
    facet: false,
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

/** The patch that stores a stack on an object. It KEEPS the legacy `modifiers` bag rather than
 *  clearing it: the bag also holds the Cloner Vary settings (varyMode/varySeed/…/varyColorStrength)
 *  and the palette lookup, which are a MATERIAL uniform, NOT a geometry modifier row, and are read
 *  straight from `obj.modifiers` by `varySettingsFor`/`materialFor`. Clearing the bag would strip
 *  Vary on the first stack edit. This is safe because `modifierStackOf` PREFERS a present
 *  `modifierStack`, so the bag's GEOMETRY keys become dead-but-harmless — never read for geometry
 *  once a stack is stored — while its Vary keys stay live for the material. */
export function writeModifierStack(stack: ModifierInstance[]): { modifierStack: ModifierInstance[] } {
  return { modifierStack: stack }
}

/** Tolerant parse for a persisted stack: keep only entries with a string id and a known kind
 *  (deduped by id, lowest wins), rebuild each instance's params from MODIFIER_SPECS defaults so
 *  junk/extra fields are dropped and the flat-number shape is guaranteed. Returns undefined only
 *  when `raw` is not an array — an explicit EMPTY stack survives as `[]`, because a valid empty
 *  stack is authoritative (modifierStackOf must NOT fall back to the legacy bag once the user has
 *  cleared every row). Mirrors sanitizeBag/parseTreatments; used by config.ts's parseDoc so a
 *  stored new-shape object round-trips instead of silently reverting to its dead legacy bag. */
export function sanitizeModifierStack(raw: unknown): ModifierInstance[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: ModifierInstance[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = e.id
    const kind = e.kind
    if (typeof id !== 'string' || id === '' || !isModifierKind(kind) || seen.has(id)) continue
    seen.add(id)
    const inst = { id, kind, enabled: e.enabled !== false } as ModifierInstance
    for (const key of MODIFIER_KIND_PARAMS[kind]) {
      const v = e[key]
      inst[key] = typeof v === 'number' && Number.isFinite(v) ? v : specDefault(key)
    }
    // `refObjectId` is a STRING id, not one of MODIFIER_KIND_PARAMS' numeric fields, so the loop
    // above would drop it. A boolean row carries it (the sibling to combine with); keep it through
    // the round-trip so a persisted boolean re-loads pointing at the same object. Ignored on every
    // other kind (they never write it), and an empty/absent value leaves the boolean a no-op.
    if (kind === 'boolean' && typeof e.refObjectId === 'string' && e.refObjectId !== '') {
      inst.refObjectId = e.refObjectId
    }
    out.push(inst)
  }
  return out
}

/** The option strings for an index-valued modifier field (axis/mode), or undefined for a plain
 *  numeric field. The single source the agent write path uses to coerce a chosen option back to
 *  the INDEX the flat bag actually stores (modifierControls.ts surfaces these as selects). */
export function modifierOptionsFor(field: string): string[] | undefined {
  const spec = MODIFIER_SPECS.find((s) => s.key === field)
  return spec && spec.control === 'options' ? spec.options : undefined
}

/** Matches a motion/agent path addressing one modifier-row field: `objects.<id>.modifierStack.<mid>.<field>`. */
const MODIFIER_STACK_PATH = /^objects\.([^.]+)\.modifierStack\.[^.]+\.[^.]+/

/** True when `path` addresses a modifier-row field (objects.<id>.modifierStack.<mid>.<field>). */
export function isModifierStackPath(path: string): boolean {
  return typeof path === 'string' && MODIFIER_STACK_PATH.test(path)
}

interface MaterializeObject extends StackHost {
  id?: unknown
  kind?: unknown
}
interface MaterializeDoc {
  objects?: MaterializeObject[]
}

/**
 * Materialize-on-write: a motion/agent SET of `objects.<id>.modifierStack.<mid>.<field>` is an
 * EDIT, and the write refuses a legacy object because it has no `modifierStack` ARRAY yet — it
 * mints its modifier targets purely through the read-through `modifierStackOf`, which fabricates
 * nothing. So fold the bag into the deterministic-id stack (`mod:<kind>:0`, the SAME ids the minted
 * targets carry) and store it on the object BEFORE the write, so the following set lands on the
 * right row. The legacy `modifiers` bag is deliberately KEPT (it also holds the Cloner Vary
 * uniform), exactly as writeModifierStack does. A no-op unless `path` is a modifier path AND the
 * resolved object exists, hosts modifiers (a primitive) and lacks the array — never materialize
 * for another path, another object kind, or an object that already has a stack (that would discard
 * the user's row order and mint fresh ids).
 */
export function materializeModifierStackForPath(doc: unknown, path: string): void {
  if (!isModifierStackPath(path)) return
  const id = MODIFIER_STACK_PATH.exec(path)?.[1]
  const objects = (doc as MaterializeDoc | null | undefined)?.objects
  if (!Array.isArray(objects)) return
  const obj = objects.find((o) => o?.id === id)
  if (!obj || obj.kind !== 'primitive' || Array.isArray(obj.modifierStack)) return
  obj.modifierStack = modifierStackOf(obj)
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
