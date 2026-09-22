/**
 * Layer cloner — a linked, non-destructive "array modifier" for Frame-modal
 * layers. A layer carrying a `Cloner` config is stamped N times by the renderer
 * (linear/grid or radial) with optional per-clone falloff. Clones do NOT count
 * against the 16-layer cap; the layer stays a single selectable object.
 *
 * `expandClones` is the SINGLE SOURCE OF TRUTH, mirrored by `_expand_clones` in
 * comfy_extras/nodes_compositor.py so the live client preview and the server-side
 * wired composite never drift. Keep the two in sync — Vary included: weight, tint,
 * tintStrength and the damping of the step transforms by `varyStepFactor` are all
 * mirrored there now.
 *
 * The mirror is held in place from both ends. `tests/unit/cloner-vary-parity.unit.spec.ts`
 * pins this function's output into `tests/fixtures/cloner-vary-parity.json`, and
 * `tests-unit/comfy_extras_test/cloner_vary_test.py` measures the Python against
 * that same file. Change the maths here and the fixture spec fails until you
 * regenerate it; regenerate it and Python fails until it is mirrored.
 */

import {
  DEFAULT_VARY, varyWeights, varyColorAt, varyStepFactor,
  type VaryMode, type VarySpread, type VarySettings,
} from '~/lib/vary'

export interface Cloner {
  enabled: boolean
  mode: 'linear' | 'radial'
  // linear / grid
  countX: number
  countY: number
  spacingX: number   // canvas-fraction (same units as layer x)
  spacingY: number   // canvas-fraction (same units as layer y)
  mirrorX: boolean   // also clone in the -X direction (original stays centered)
  mirrorY: boolean   // also clone in the -Y direction (original stays centered)
  // nudge — progressive drift, accumulates by clone index k (like rotation falloff)
  nudgeX: number     // + canvas-fraction per clone step
  nudgeY: number     // + canvas-fraction per clone step
  // stagger — brick-style offset of alternating rows/cols, as a fraction of spacing
  staggerX: number   // odd rows shift by staggerX·spacingX
  staggerY: number   // odd cols shift by staggerY·spacingY
  // radial
  count: number
  radius: number     // canvas-WIDTH fraction
  startAngle: number // degrees
  sweepAngle: number // degrees; 360 = full ring (no overlap at start/end)
  faceCenter: boolean
  // falloff — cumulative per clone index k (k=0 is the original)
  stepRotation: number // +deg per clone
  stepScale: number    // × per clone (1 = none)
  stepOpacity: number  // × per clone (1 = none)
  /** Living-image clips only: how far apart the copies start in the clip, 0..1.
   *  1 spreads them evenly around the loop, 0 plays every copy in unison. */
  phase?: number
  // vary — per-copy variation, shared with the 3D Studio cloner via lib/vary.
  // Every default is the identity, so an existing layer stamps exactly as before.
  varyMode: VaryMode
  varySeed: number
  varyFalloffCenter: number
  varyFalloffRadius: number
  varyColor: boolean
  varyPalette: string[]
  varyColorSpread: VarySpread
  varyColorStrength: number
  /** Motion stagger: seconds between one copy's clock and the next. 0 = unison (today). */
  motionStagger?: number
  /** Which copy goes first. */
  motionOrder?: 'first' | 'last' | 'centre' | 'random'
  motionSeed?: number
}

export interface CloneTransform {
  dx: number        // add to layer x
  dy: number        // add to layer y
  drot: number      // add to layer rotation (deg)
  dscale: number    // multiply layer scale
  dopacity: number  // multiply layer opacity
  /** This copy's Vary weight in [0,1]. Exposed so a renderer can drive its own
   *  per-copy effects without re-deriving the driver. */
  weight: number
  /** Resolved per-copy colour, or undefined when colour variation is off. */
  tint?: string
  /** How far toward `tint` the copy's pixels move. Meaningless without `tint`. */
  tintStrength: number
  /** This copy's index in the expansion (0 = the original) and the copy count. A
   *  living-image layer offsets its clip by `k / n` of a loop (see lib/compositor/clip). */
  k: number
  n: number
}

const IDENTITY: CloneTransform = { dx: 0, dy: 0, drot: 0, dscale: 1, dopacity: 1, weight: 0, tintStrength: 1, k: 0, n: 1 }

export const DEFAULT_CLONER: Cloner = {
  enabled: false,
  mode: 'linear',
  countX: 3,
  countY: 1,
  spacingX: 0.25,
  spacingY: 0.25,
  mirrorX: false,
  mirrorY: false,
  nudgeX: 0,
  nudgeY: 0,
  staggerX: 0,
  staggerY: 0,
  count: 6,
  radius: 0.3,
  startAngle: 0,
  sweepAngle: 360,
  faceCenter: false,
  stepRotation: 0,
  stepScale: 1,
  stepOpacity: 1,
  phase: 1,
  varyMode: DEFAULT_VARY.mode,
  varySeed: DEFAULT_VARY.seed,
  varyFalloffCenter: DEFAULT_VARY.falloffCenter,
  varyFalloffRadius: DEFAULT_VARY.falloffRadius,
  varyColor: false,
  varyPalette: DEFAULT_VARY.palette,
  varyColorSpread: DEFAULT_VARY.spread,
  varyColorStrength: DEFAULT_VARY.strength,
}

const DEG = Math.PI / 180

/**
 * A number that survived a text field. `??` catches undefined and null but NOT
 * `NaN`, and `lib/vary`'s clamp01 is `n < 0 ? 0 : n > 1 ? 1 : n`, which fails
 * both comparisons for NaN and lets it straight through. The panel binds these
 * four fields to `<input type="number">`, and a CLEARED field is `Number('')`
 * → NaN → in falloff mode `d / r` → weight NaN → `Math.pow(stepScale, NaN)` →
 * both `dscale` and `dopacity` NaN → the layer silently vanishes from the
 * composite. `varyOf` is the one chokepoint every consumer goes through.
 */
const finite = (n: number | undefined | null, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? n : fallback

/** The cloner's vary settings in the shared module's vocabulary. */
export function varyOf(cloner: Cloner): VarySettings {
  return {
    mode: cloner.varyMode ?? DEFAULT_VARY.mode,
    seed: finite(cloner.varySeed, DEFAULT_VARY.seed),
    falloffCenter: finite(cloner.varyFalloffCenter, DEFAULT_VARY.falloffCenter),
    falloffRadius: finite(cloner.varyFalloffRadius, DEFAULT_VARY.falloffRadius),
    colorEnabled: !!cloner.varyColor,
    // Substituted only for a MISSING field, never for an EMPTY one: `lib/vary`'s
    // contract is that an empty palette disables colour (`varyColorAt` returns
    // undefined for it), so a palette the user deliberately cleared must survive as
    // []. Substituting the default here would have tinted a cleared palette with
    // blue/orange the moment the panel grows a remove-swatch control. An old saved
    // cloner with no `varyPalette` at all still gets the default.
    palette: cloner.varyPalette ?? DEFAULT_VARY.palette,
    spread: cloner.varyColorSpread ?? DEFAULT_VARY.spread,
    strength: finite(cloner.varyColorStrength, DEFAULT_VARY.strength),
  }
}

/**
 * Expand a cloner config into per-clone transforms.
 *
 * @param cloner config (or undefined/disabled → a single identity transform)
 * @param aspect canvas W/H, used only by radial so the ring is circular on
 *               screen (x maps to W, y maps to H).
 * @param only when given, narrow the result to just this one copy's `k` (used
 *             by a staggered paint, which folds and paints one copy at a time).
 * @returns transforms in BACK-TO-FRONT draw order — the original (k=0, identity)
 *          is LAST so it lands on top and falloff reads as a trail behind it.
 */
export function expandClones(cloner: Cloner | undefined | null, aspect: number, only?: number): CloneTransform[] {
  if (!cloner || !cloner.enabled) {
    const identity = [{ ...IDENTITY }]
    return only === undefined ? identity : identity.filter((c) => c.k === only)
  }

  const stepRot = cloner.stepRotation || 0
  const stepScl = cloner.stepScale ?? 1
  const stepOp = cloner.stepOpacity ?? 1

  // Pass 1 — placement only. The vary weight needs the FULL step array (its
  // normaliser is max(k)), so nothing can be finished until every copy is known.
  const raw: { k: number; dx: number; dy: number; extraRot: number }[] = []
  const push = (k: number, dx: number, dy: number, extraRot: number) => raw.push({ k, dx, dy, extraRot })

  if (cloner.mode === 'radial') {
    const n = Math.max(1, Math.floor(cloner.count))
    const sweep = cloner.sweepAngle
    const full = Math.abs(sweep) >= 359.999
    const denom = full ? n : Math.max(1, n - 1)
    for (let i = 0; i < n; i++) {
      const angDeg = cloner.startAngle + sweep * (i / denom)
      const ang = angDeg * DEG
      const dx = cloner.radius * Math.cos(ang)
      const dy = cloner.radius * aspect * Math.sin(ang)
      push(i, dx, dy, cloner.faceCenter ? angDeg : 0)
    }
  } else {
    const nx = Math.max(1, Math.floor(cloner.countX))
    const ny = Math.max(1, Math.floor(cloner.countY))
    // Column/row step offsets. Mirroring reflects the non-original steps to the
    // opposite side (1..n-1 → also -(1..n-1)), so the original stays centered and
    // count keeps meaning "instances in the primary direction". Falloff step k is
    // the distance from the original (|iy|·nx + |ix|), so a mirrored clone gets
    // the same falloff as its positive twin.
    const xs: number[] = []
    for (let ix = 0; ix < nx; ix++) xs.push(ix)
    if (cloner.mirrorX) for (let ix = 1; ix < nx; ix++) xs.push(-ix)
    const ys: number[] = []
    for (let iy = 0; iy < ny; iy++) ys.push(iy)
    if (cloner.mirrorY) for (let iy = 1; iy < ny; iy++) ys.push(-iy)
    const nudgeX = cloner.nudgeX || 0
    const nudgeY = cloner.nudgeY || 0
    const stagX = cloner.staggerX || 0
    const stagY = cloner.staggerY || 0
    for (const iy of ys) {
      for (const ix of xs) {
        const k = Math.abs(iy) * nx + Math.abs(ix)
        // base grid + progressive nudge (by k) + brick stagger (alternating rows/cols)
        let dx = ix * cloner.spacingX + k * nudgeX
        let dy = iy * cloner.spacingY + k * nudgeY
        if (stagX) dx += (Math.abs(iy) % 2) * stagX * cloner.spacingX
        if (stagY) dy += (Math.abs(ix) % 2) * stagY * cloner.spacingY
        push(k, dx, dy, 0)
      }
    }
  }

  // Vary means "vary ACROSS copies", and one copy has no across. The 3D cloner
  // already reads it that way — its renderer skips the whole modifier below two
  // copies (`count > 1` in lib/scene3d/modifiers.ts) — and the Frame panel hides the
  // Vary block at one copy, so a lone copy has to leave here as the plain identity it
  // was before Vary shipped: no tint, no damped steps. Without this, a layer taken
  // from three copies back down to one kept the first swatch's tint, with the control
  // that would clear it now hidden.
  //
  // The test is on the EXPANDED copies rather than on a count field, because one copy
  // arrives by more than one route: linear with countX and countY both 1 (mirroring
  // adds nothing to a count of 1), and radial with count 1. k is 0 for the sole copy,
  // so every step term is already at identity (`0 * stepRot`, `stepScl ** 0`) — only
  // its placement and a faceCenter rotation survive.
  if (raw.length < 2) {
    const single = raw.map((r) => ({ ...IDENTITY, dx: r.dx, dy: r.dy, drot: r.extraRot }))
    return only === undefined ? single : single.filter((c) => c.k === only)
  }

  // Pass 2 — drivers. Sequence mode has varyStepFactor === 1, so the three step
  // expressions below reduce to exactly the pre-vary ones.
  const vary = varyOf(cloner)
  const weights = varyWeights(raw.map((r) => r.k), vary)
  const out: CloneTransform[] = raw.map((r, i) => {
    const w = weights[i] ?? 0
    const f = varyStepFactor(w, vary)
    return {
      dx: r.dx, dy: r.dy,
      drot: r.k * stepRot * f + r.extraRot,
      dscale: Math.pow(stepScl, r.k * f),
      dopacity: Math.pow(stepOp, r.k * f),
      weight: w,
      tint: varyColorAt(w, r.k, vary),
      tintStrength: vary.strength,
      k: r.k,
      n: raw.length,
    }
  })

  // Built k-ascending; reverse → original (k=0) ends last = drawn on top.
  out.reverse()
  return only === undefined ? out : out.filter((c) => c.k === only)
}

/**
 * Build the per-slot cloner widget assignments to stamp onto a Compositor node
 * at submit. `map` is the editor's `sailor_wiredCloners` property (slot →
 * Cloner, slot 1-based, matching `layer{i}_cloner`). Only ENABLED cloners are
 * emitted — a disabled/absent cloner leaves the widget at its "" default (a
 * single instance), so unrelated layers submit byte-identically.
 */
export function wiredClonerWidgetEntries(
  map: Record<string, Cloner> | undefined | null,
): { name: string; json: string }[] {
  if (!map) return []
  const out: { name: string; json: string }[] = []
  for (const [slot, cloner] of Object.entries(map)) {
    if (!cloner || !cloner.enabled) continue
    out.push({ name: `layer${slot}_cloner`, json: JSON.stringify(cloner) })
  }
  return out
}

/** Parse a `layer{i}_cloner` widget JSON value into a Cloner (or undefined). */
export function parseCloner(raw: unknown): Cloner | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return undefined
    return { ...DEFAULT_CLONER, ...obj, enabled: !!obj.enabled }
  } catch {
    return undefined
  }
}
