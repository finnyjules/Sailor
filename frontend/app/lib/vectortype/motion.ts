/**
 * Vector Type Studio — motion. PURE.
 *
 * Two things happen here, and they are different kinds of thing:
 *
 *   `applyMotion(cfg, t)`                    — the WHOLE config at time t
 *   `glyphTime` / `glyphTransform` / `glyphConfig` — one GLYPH at time t
 *
 * The second exists because the first cannot express stagger. Stagger is
 * per-glyph by definition: glyph *i* must evaluate the very same tracks at its
 * own shifted time, so a single `axes.wght` track becomes a weight wave
 * TRAVELLING across the word rather than the whole word pulsing at once. That
 * is the single most valuable motion this studio offers, and it is why
 * `glyphConfig(cfg, t, i, n)` — not `applyMotion` — is what a renderer loops
 * over when `motion.stagger.delay > 0`.
 *
 * This is Gradient's model, not Shape's. Gradient could animate anything
 * because `f(cfg, t) → pixels` is stateless; Shape's `setConfig` disposes and
 * rebuilds geometry, which capped it at camera and scale. Vector Type is
 * `f(cfg, t) → paths` — no engine, nothing to rebuild — so every declared
 * slider is animatable for free.
 *
 * ## Do not assume anything normalised the config first
 *
 * When Gradient's motion shipped, the plan assumed `ensureConfigDefaults` ran on
 * every load path. It did not — only the editor surface called it, while the
 * node card, the headless bake and the studio frame source all rendered straight
 * from the saved blob. Saved animations would have silently stopped moving.
 *
 * The fix was a fallback INSIDE `applyMotion`, because that is the one choke
 * point every render path crosses. Same rule here, and it is not hypothetical:
 * Task 7 wires a surface, a node card, a `registerStudioBaker` and a
 * `registerStudioFrameSource`, and only the surface will hold a `mergeConfig`-ed
 * ref — the other three read `data.properties.sailor_vectorType` as parsed
 * JSON. So everything below tolerates a missing `motion`, a missing `stagger`,
 * a non-array `tracks`, and a track whose numbers are not numbers.
 *
 * ## COLOUR TRACKS, and where they stop
 *
 * A track may drive a COLOUR leaf as well as a number: it carries its own
 * `fromColor`/`toColor` and a mix `space`, and `applyMotion` writes the mixed hex
 * string through the very same path resolution the numeric branch uses. Nothing
 * downstream needed a change — `setByPath` and `setByIdPath` always took
 * `unknown`, and both renderers read the paint off the post-`applyMotion` config
 * — which is also why canvas and SVG cannot disagree about an animated colour:
 * `vectorTypeFrame` is the single place either of them gets a config from.
 *
 * WHERE IT STOPS: a colour is a RUN-LEVEL quantity here, so a `stagger` does not
 * reach it. The appearance stack is resolved ONCE per frame — `vtPaintLayers`
 * hoists each layer's `runStyle` (a `CanvasGradient` for the non-solid arms)
 * before the glyph loop, because building one per glyph per layer is the cost
 * that loop exists to avoid. `glyphStackLeaf` below is the ONE exception and
 * documents why the draw-on earns it: its dash is already a per-glyph quantity by
 * construction. Per-glyph hue drift is therefore a real further piece of work in
 * `canvas.ts` (re-resolving paint per glyph), not a flag here — and until it is
 * done, a staggered colour track colours the whole word at once, which is a
 * correct picture rather than a broken one.
 *
 * ## NAME COLLISION, on purpose
 *
 * `./render.ts` also exports `glyphTransform`, and it means something else
 * there: where a glyph SITS on the line (placement). This one is what motion
 * ADDS to that placement. A module importing both must alias one — that is a
 * compile error at the import site, not a silent mix-up, which is the trade
 * being made.
 */
// TYPE-ONLY, and it must stay that way — ./font.ts loads fontkit at module
// scope and this module is reached from every node card. Same rule as
// ./controls.ts, for the same reason.
import type { VtAxis } from './font'
import {
  DEFAULT_MOTION,
  DEFAULT_STAGGER,
  VT_STACK_PREFIX,
  VT_STAGGER_ORDERS,
  cloneConfig,
  type VectorTypeConfig,
  type VtMotionTrack,
  type VtStaggerConfig,
  type VtStaggerOrder,
} from './config'
import { VT_CONTROLS, VT_LAYER_PREFIX, derivedVtControls, visibleVtControls } from './controls'
import { vtLayerLabels } from './layerLabel'
// The stagger's `random` order and the blink/scatter/flicker family must draw on
// ONE seeded hash, or "seeded and stable" holds twice with two different
// meanings. ./random.ts is its home; it imports nothing, so this costs nothing.
import { hash32 } from './random'
import { getByPath, setByPath } from '~/lib/studio/path'
import { parseIdPath, resolveIdPath, setByIdPath } from '~/lib/studio/idPath'
import { trackProgress, trackValue } from '~/lib/studio/track'
import { makeListRemap } from '~/lib/studio/listRemap'
// Flattens `motion.moves`' `'tracks'`-kind moves back into a flat track list —
// the SHIM this module reads through now that tracks live inside moves rather
// than at `motion.tracks` directly. A compiling stand-in only: it does not
// carry a move's own ease/play into the numbers below (every read here still
// assumes the OLD per-track `easing`/`loops`, which no longer exist), so the
// values this module computes are not yet correct for a converted document —
// see this file's own header and the task report for what a full rewrite onto
// `movePhase`/`moveTracks` (in `~/lib/studio/moves`) still owes.
import { moveTracks } from '~/lib/studio/moves/tracks'
// Perceptual colour interpolation. Pure arithmetic over two strings — see
// `lib/color/mix.ts` for the measured reason the default is not an RGB lerp.
import { DEFAULT_COLOR_MIX_SPACE, mixHex } from '~/lib/color/mix'

export { trackProgress, trackValue } from '~/lib/studio/track'

/** One thing a track can point at, with the range a timeline should offer. */
export interface VtAnimatableTarget {
  /** Dotted path, exactly what `VtMotionTrack.path` stores. */
  path: string
  label: string
  min: number
  max: number
  /** The section it came from, so a picker can group targets like the inspector. */
  group: string
}

/**
 * The per-glyph transform namespace.
 *
 * These are the one set of targets that are NOT config leaves: there is no
 * stored `glyph.dy`, because a per-glyph offset has no meaning outside an
 * animation — it is an output, not state. They are therefore declared here
 * rather than in `VT_CONTROLS` (where every key must resolve against the config,
 * pinned by a test) and read by `glyphTransform`, never by `applyMotion`.
 *
 * `dx`/`dy` are in OUTPUT PIXELS, matching `render.ts` (which bakes the y-flip
 * into the coordinates so stroke widths and glyph offsets are in the same units
 * on canvas and in SVG) — but they are measured along the GLYPH'S OWN AXES, not
 * the output's. `dy` is a baseline shift: on a bent run it moves the letter off
 * its own baseline (radially, on a ring), which is what type-on-a-path means by
 * it everywhere else. On a straight run the two frames are identical and the
 * arithmetic is unchanged; `vtGlyphOffset` (./extrude.ts) is the one derivation,
 * and carries the reasoning and the numbers behind the choice.
 *
 * `rotate` is degrees ADDED to the placement's own angle, `scale` multiplies,
 * `opacity` is 0..1. So every channel here is in the glyph's frame.
 */
export const VT_GLYPH_PREFIX = 'glyph.'

export const VT_GLYPH_TARGETS: readonly VtAnimatableTarget[] = Object.freeze([
  { path: 'glyph.dx', label: 'Glyph · Offset X', min: -400, max: 400, group: 'Glyph' },
  { path: 'glyph.dy', label: 'Glyph · Offset Y', min: -400, max: 400, group: 'Glyph' },
  { path: 'glyph.scale', label: 'Glyph · Scale', min: 0, max: 4, group: 'Glyph' },
  { path: 'glyph.rotate', label: 'Glyph · Rotate', min: -360, max: 360, group: 'Glyph' },
  { path: 'glyph.opacity', label: 'Glyph · Opacity', min: 0, max: 1, group: 'Glyph' },
] as const)

/** What a glyph's motion adds to its placement. Identity when nothing animates it. */
export interface VtGlyphTransform {
  dx: number
  dy: number
  scale: number
  rotate: number
  opacity: number
}

export const IDENTITY_GLYPH_TRANSFORM: Readonly<VtGlyphTransform> =
  Object.freeze({ dx: 0, dy: 0, scale: 1, rotate: 0, opacity: 1 })

/** `glyph.dy` → `dy`, and nothing else. Built from VT_GLYPH_TARGETS so the two
 *  cannot drift: adding a target here is the only edit a new one needs. */
const GLYPH_FIELD: Record<string, keyof VtGlyphTransform> = Object.fromEntries(
  VT_GLYPH_TARGETS.map(t => [t.path, t.path.slice(VT_GLYPH_PREFIX.length) as keyof VtGlyphTransform]),
)

const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const finite = (v: unknown, d: number): number => (isFinite_(v) ? v : d)

/**
 * How to rewrite the positional stack paths `animatableTargets` emits below.
 *
 * It lives HERE, beside the loop that builds `appearance.<i>.<leaf>`, because
 * the module that decides a path's shape is the only one that can be trusted to
 * describe it — Shader's scheme needs `mid: 'params'` and a non-empty leaf, and
 * either knob set wrongly matches nothing and silently remaps nothing. The stack
 * UI imports this rather than restating it.
 *
 * Splicing `appearance` without it re-aims every track at whatever slid into the
 * slot, and nothing throws. (See `lib/studio/listRemap.ts` — and its note that
 * stable ids would remove the need for any of this, which is where this should
 * go once motion resolves through `resolveIdPath`.)
 */
export const VT_APPEARANCE_REMAP = makeListRemap({ list: 'appearance' })

/** The config key the appearance stack lives at, and the prefix every absolute
 *  stack path carries — DEFINED IN `./config.ts` and re-exported here, where its
 *  three readers below are, because `mergeConfig`'s positional-track migration
 *  needs the same constant and this module already imports that one. Importers
 *  of either name are unaffected by which module declares it. */
export { VT_STACK_LIST, VT_STACK_PREFIX } from './config'

/** True for a path that addresses a member of the appearance stack, by id or by
 *  index. Everything else is an ordinary dotted config path. */
export const isStackPath = (path: string): boolean => path.startsWith(VT_STACK_PREFIX)

/**
 * A layer id minted by `vtLayerId` can never be read as an index (`config.ts`
 * guarantees the `L` prefix and rejects an all-digit stored id), so a member
 * segment that is not all digits is an id. Used to build id paths, and to refuse
 * to build one from a layer whose id would be ambiguous.
 */
const usableId = (id: unknown): id is string =>
  typeof id === 'string' && id !== '' && !id.includes('.') && !/^\d+$/.test(id)

/**
 * Which LAYER a track is aimed at, as a stable id — `undefined` for a track that
 * is not aimed at the stack at all, and for one whose layer is gone.
 *
 * This is the question every proof in this area actually wants to ask. "The path
 * string did not change" proves nothing about a positional path (that is the
 * failure), and "the path string DID change" proves nothing about an id path
 * (it must not). Both reduce to: does this track still drive the same layer?
 */
export function trackLayerId(cfg: VectorTypeConfig, path: string): string | undefined {
  if (!isStackPath(path)) return undefined
  const p = parseIdPath(path)
  if (!p) return undefined
  const stack = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  if (!p.positional) return stack.some(l => l?.id === p.key) ? p.key : undefined
  const id = stack[Number(p.key)]?.id
  return usableId(id) ? id : undefined
}

/**
 * Drop tracks whose stack path no longer resolves to a layer.
 *
 * Removing a layer is the one mutation an id path cannot absorb: the layer is
 * genuinely gone, so the track has nothing to drive. `applyMotion` already
 * IGNORES it (that is the guarantee — never a wrong layer), but leaving the row
 * in the timeline shows the user an entry that animates nothing, which is what
 * the positional `VT_APPEARANCE_REMAP.onRemove` used to prevent by dropping it.
 * Same outcome, asked of the config rather than of an index.
 *
 * Returns the SAME array when nothing is dangling, so a caller can skip the
 * write (and the deep watcher it would trigger).
 */
export function pruneStackTracks(cfg: VectorTypeConfig): VtMotionTrack[] {
  const tracks = moveTracks(cfg?.motion) as unknown as VtMotionTrack[]
  const kept = tracks.filter((t) => {
    const path = typeof t?.path === 'string' ? t.path.trim() : ''
    if (!isStackPath(path)) return true
    return resolveIdPath(cfg, path) !== undefined
  })
  return kept.length === tracks.length ? tracks : kept
}

/**
 * Every path a track may point at, derived from the SAME declaration the agent,
 * the inspector and Collection sweeps read — `animatable !== false` means
 * animatable, and there is no second list to keep in step.
 *
 * `axes` is the loaded font's axis list, passed in for the reason
 * `vtAgentControls(cfg, axes)` takes it: `loadVariableFont` exposes promises
 * only, with no synchronous cache. Omit it and you get the static targets plus
 * the glyph namespace — the honest answer before a font has loaded, not a
 * hard-coded guess at which axes exist.
 */
export function animatableTargets(cfg: VectorTypeConfig, axes: VtAxis[] = []): VtAnimatableTarget[] {
  const out: VtAnimatableTarget[] = []
  const sliderRange = (c: any) => {
    // An explicit range lets animation reach past what the UI slider allows
    // (Gradient's `layer.shape.sweep` is the precedent).
    const flag = c.animatable
    return flag && typeof flag === 'object' ? flag : { min: c.min, max: c.max }
  }
  const usable = (c: any) => c.kind === 'slider' && c.animatable !== false

  // `visibleVtControls` gates the `layer.*` keys on ONE layer (the active one),
  // which is right for a panel and wrong here: motion must reach every layer.
  // So they are skipped in this loop and expanded per layer below.
  for (const c of [...visibleVtControls(cfg), ...derivedVtControls(cfg, axes)]) {
    if (c.key.startsWith(VT_LAYER_PREFIX) || !usable(c)) continue
    out.push({ path: c.key, label: c.label, group: c.group, ...sliderRange(c) })
  }

  // The relative `layer.` prefix expands to one ABSOLUTE path per appearance
  // layer, exactly as `gradientfx/motion.ts` expands its own, with each layer's
  // own `when` predicate applied to it — a stroke width is a target on a stroke
  // layer and on no other.
  //
  // ADDRESSED BY ID (`appearance.Lstroke.width`), not by position. A positional
  // path re-points the moment the stack is spliced: the track keeps animating
  // slot 2, which is now a different layer, and nothing throws. `listRemap`
  // exists to patch that up after the fact and every future mutation site has to
  // remember to call it; an id path makes reorder a NO-OP instead — there is
  // nothing to remap and nothing to get wrong. `applyMotion` below resolves it
  // through `setByIdPath`.
  //
  // Labels come from `vtLayerLabels`, which names a layer for what it IS and
  // de-duplicates with ordinals. They must stay UNIQUE: a timeline builds its
  // dropdown from them, and two identical entries make two different targets
  // indistinguishable.
  const stack = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  const names = vtLayerLabels(stack)
  for (const c of VT_CONTROLS) {
    if (!c.key.startsWith(VT_LAYER_PREFIX) || !usable(c)) continue
    const rest = c.key.slice(VT_LAYER_PREFIX.length)
    stack.forEach((l, i) => {
      if (c.when && !c.when(cfg, l)) return
      // A layer with no usable id can only be addressed by position. That is a
      // config `mergeConfig` never produces (it mints and de-duplicates ids), so
      // this is the raw-blob path — a positional target that animates the right
      // layer today beats no target at all, and it still resolves.
      const member = usableId(l?.id) ? l.id : String(i)
      out.push({
        path: `${VT_STACK_PREFIX}${member}.${rest}`,
        label: `${names[i] ?? `Layer ${i + 1}`} · ${c.label}`,
        group: c.group,
        ...sliderRange(c),
      })
    })
  }
  out.push(...VT_GLYPH_TARGETS.map(t => ({ ...t })))
  return out
}

// ── Colour targets ──────────────────────────────────────────────────────────

/**
 * One COLOUR leaf a track can point at.
 *
 * A separate type and a separate list from `VtAnimatableTarget`, on purpose. That
 * one's whole contract is `min`/`max` — a usable numeric range, asserted on every
 * entry by its own spec — and a colour has no range: it has two endpoints the
 * user picks with a swatch. Folding colours in would have meant either lying
 * about the range or making `min`/`max` optional for every existing consumer to
 * re-check.
 *
 * Both lists are DERIVED FROM THE SAME `VT_CONTROLS` declaration, including each
 * control's `when` predicate, so this is not a second hand-maintained table — it
 * is the same table read for its `kind: 'color'` rows instead of its sliders.
 */
export interface VtColorTarget {
  /** Dotted path, exactly what `VtMotionTrack.path` stores. */
  path: string
  label: string
  group: string
}

/**
 * Every COLOUR leaf a track may point at.
 *
 * Every colour control in this studio is a `layer.` one (a fill's `paint.a` /
 * `paint.b`, a solid extrude's `strokeColor`), so this is the same per-layer
 * expansion `animatableTargets` does above, addressed by the layer's own stable
 * id for the same reason, and gated by the same `when` predicates — which is what
 * keeps `paint.b` off a solid fill (it paints nothing there) and both colours off
 * a SHADER fill (`effectiveTilePaint` unwraps to the shader and never reads
 * them). A track offered on one of those would be the dead-control failure this
 * studio's schema exists to prevent, animated.
 *
 * A top-level colour control, if one is ever declared, is picked up by the same
 * loop — the `layer.` prefix decides which branch it takes, exactly as above.
 */
export function colorTargets(cfg: VectorTypeConfig): VtColorTarget[] {
  const out: VtColorTarget[] = []
  const usable = (c: any) => c.kind === 'color' && c.animatable !== false

  for (const c of visibleVtControls(cfg)) {
    if (c.key.startsWith(VT_LAYER_PREFIX) || !usable(c)) continue
    out.push({ path: c.key, label: c.label, group: c.group })
  }

  const stack = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  const names = vtLayerLabels(stack)
  for (const c of VT_CONTROLS) {
    if (!c.key.startsWith(VT_LAYER_PREFIX) || !usable(c)) continue
    const rest = c.key.slice(VT_LAYER_PREFIX.length)
    stack.forEach((l, i) => {
      if (c.when && !c.when(cfg, l)) return
      const member = usableId(l?.id) ? l.id : String(i)
      out.push({
        path: `${VT_STACK_PREFIX}${member}.${rest}`,
        label: `${names[i] ?? `Layer ${i + 1}`} · ${c.label}`,
        group: c.group,
      })
    })
  }
  return out
}

/** True for a path `colorTargets` offers on this config — what a timeline row
 *  asks to decide whether to show two number inputs or two swatches. */
export function isColorTargetPath(cfg: VectorTypeConfig, path: string): boolean {
  const p = typeof path === 'string' ? path.trim() : ''
  return !!p && colorTargets(cfg).some(t => t.path === p)
}

const HEXISH = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * Is this track a COLOUR track?
 *
 * Asked of the TRACK, never of its path, and that is deliberate. A path-based
 * test would need the config (to expand `layer.` and apply the `when` gates) and
 * would then disagree with itself across a stack edit: switch a fill to a shader
 * and a saved colour track would stop being read as one, so `applyMotion` would
 * fall through to the numeric branch and write the NUMBER 0.6 into `paint.a` —
 * a `fillStyle` no renderer can parse. The track's own two colours are the honest
 * discriminator, and they travel with it.
 */
export function isColorTrack(track: VtMotionTrack | null | undefined): boolean {
  return !!track && HEXISH.test(String(track.fromColor)) && HEXISH.test(String(track.toColor))
}

/**
 * The colour a colour track holds at time `t` — its own two endpoints mixed at
 * the track's eased progress, in the track's chosen space.
 *
 * `trackProgress` is the SAME timing engine `trackValue` runs on (it is now
 * literally what `trackValue` is built from), so easing, loops, hold, cycleOffset
 * and delay behave identically on a colour track and on a numeric one — one
 * implementation, nothing to keep in step, and it is asserted by equality rather
 * than asserted twice (see the colour-track spec's timing table).
 *
 * The per-glyph STAGGER is the exception, and not because of anything here: it
 * shifts the clock a glyph reads at, and a layer's colour is resolved once for the
 * run. See this module's header.
 */
export function trackColor(track: VtMotionTrack, t: number, duration: number): string {
  return mixHex(
    track.fromColor as string,
    track.toColor as string,
    trackProgress(track, t, duration),
    track.space ?? DEFAULT_COLOR_MIX_SPACE,
  )
}

/** The motion block as the evaluator needs it, from a config of any vintage. */
function resolveDuration(cfg: VectorTypeConfig): number {
  return Math.max(0.001, finite(cfg?.motion?.duration, DEFAULT_MOTION.duration))
}

/** Tracks worth evaluating: real path, and either real numbers or two real
 *  colours. A track that fails this is skipped rather than defaulted — writing
 *  `NaN` into `size` from a half-parsed blob is worse than not animating, and so
 *  is writing `undefined` into a fill.
 *
 *  A COLOUR track is admitted on its colours alone: `mergeTrack` gives it
 *  `from: 0, to: 1`, but a hand-written or agent-written blob may carry the two
 *  swatches and no numbers at all, and `trackProgress` reads neither. */
function usableTracks(cfg: VectorTypeConfig): VtMotionTrack[] {
  const raw = moveTracks(cfg?.motion) as unknown as VtMotionTrack[]
  return raw.filter((t): t is VtMotionTrack =>
    !!t && typeof t === 'object'
    && typeof (t as VtMotionTrack).path === 'string' && (t as VtMotionTrack).path.trim() !== ''
    && (isColorTrack(t as VtMotionTrack)
      || (isFinite_((t as VtMotionTrack).from) && isFinite_((t as VtMotionTrack).to))))
}

/**
 * Build a frame-specific config: clone `cfg` and overwrite each animated path
 * with its value at time `t`.
 *
 * CLONES, never mutates — a mutating version would write animation values back
 * into the config the surface is holding, and the next save would persist frame
 * 37 as the user's settings.
 *
 * With nothing to animate it returns `cfg` ITSELF rather than a pointless copy
 * (Gradient does the same), so the result is read-only to callers either way.
 */
export function applyMotion(cfg: VectorTypeConfig, t: number): VectorTypeConfig {
  const tracks = usableTracks(cfg)
  if (!tracks.length) return cfg
  const duration = resolveDuration(cfg)
  const out = cloneConfig(cfg)
  for (const track of tracks) {
    const path = track.path.trim()
    // The per-glyph namespace is `glyphTransform`'s, not the config's. Skipped
    // explicitly rather than relying on the parent guard below, so it stays
    // skipped even if a future config ever grows a real `glyph` field.
    if (path.startsWith(VT_GLYPH_PREFIX)) continue
    // A COLOUR track writes a STRING. Everything else about it — the path
    // resolution, the id addressing, the parent guard, the last-write-wins
    // overwrite — is the numeric path verbatim, which is the point of resolving
    // the value up here instead of duplicating the two write branches below.
    // `setByPath`/`setByIdPath` already take `unknown`, so neither needed a change.
    const value: number | string = isColorTrack(track)
      ? trackColor(track, t, duration)
      : trackValue(track, t, duration)
    // A STACK path is id-addressed (`appearance.Lstroke.width`), so it must be
    // resolved to a position before `setByPath` sees it — handed the raw id,
    // `setByPath` would create a property named `Lstroke` ON THE ARRAY and write
    // into it. `setByIdPath` resolves, applies the SAME parent guard as the
    // branch below, and returns false rather than guessing:
    //
    //   an unknown id (the layer was deleted) → the track is IGNORED, never
    //   re-aimed at whichever layer slid into its slot.
    //
    // An in-range positional path passes through unchanged, so tracks saved
    // before ids — and the ones `migrateLegacyAppearance` writes — still animate.
    if (isStackPath(path)) {
      setByIdPath(out, path, value)
      continue
    }
    // Guard on the PARENT container, not the leaf: `axes` is SPARSE by design,
    // so `axes.wght` legitimately has no leaf until something writes one. What
    // must not happen is fabricating structure — `setByPath` creates missing
    // containers, so a typo'd path would silently grow junk into the config and
    // then get SAVED. An absent or non-object parent is skipped.
    const lastDot = path.lastIndexOf('.')
    const parentPath = lastDot === -1 ? '' : path.slice(0, lastDot)
    const parent = parentPath ? getByPath(out, parentPath) : out
    if (typeof parent !== 'object' || parent === null) continue
    setByPath(out, path, value)
  }
  return out
}

// ── Per-glyph stagger ───────────────────────────────────────────────────────

/** The stagger block, defaulted field by field. The choke-point fallback: this
 *  is what makes a raw stored blob (or a `motion` written by an older version
 *  that had no stagger at all) behave as "no stagger" rather than throw. */
export function resolveStagger(cfg: VectorTypeConfig): VtStaggerConfig {
  const s = cfg?.motion?.stagger as Partial<VtStaggerConfig> | undefined
  const order = s?.order
  return {
    delay: Math.max(0, finite(s?.delay, DEFAULT_STAGGER.delay)),
    order: (VT_STAGGER_ORDERS as readonly string[]).includes(order as string)
      ? (order as VtStaggerOrder)
      : DEFAULT_STAGGER.order,
    seed: finite(s?.seed, DEFAULT_STAGGER.seed),
  }
}

// The shuffled ranks depend only on (count, seed), and within a frame both are
// constant — so a single-entry memo removes the per-glyph re-sort without
// needing a cache-eviction policy.
let shuffleMemo: { key: string; ranks: number[] } | null = null

/** Position of each glyph in the shuffled queue. Deterministic in (count, seed). */
function shuffledRanks(count: number, seed: number): number[] {
  const key = `${count}:${seed}`
  if (shuffleMemo && shuffleMemo.key === key) return shuffleMemo.ranks
  const order = Array.from({ length: count }, (_, i) => i)
  // Tie-broken by index so two colliding hashes still give one stable order.
  order.sort((a, b) => (hash32(a, seed) - hash32(b, seed)) || (a - b))
  const ranks = new Array<number>(count)
  order.forEach((glyph, position) => { ranks[glyph] = position })
  shuffleMemo = { key, ranks }
  return ranks
}

/**
 * Where glyph `index` sits in the queue, 0 = first to move.
 *
 * Every order leads at 0 and spans to (roughly) count-1, so switching order
 * changes WHO leads without changing how long the run takes. `center`/`edges`
 * use TWICE the distance from the midpoint for exactly that reason — the plain
 * distance halves the span and makes those two quietly faster than the others —
 * and `center` subtracts the even-count offset so its leaders still start at 0
 * rather than the whole word lagging by one delay.
 *
 * All five orders return integers: `2·|i − (n−1)/2|` is odd for even `n` and
 * even for odd `n`, never fractional.
 */
export function staggerRank(order: VtStaggerOrder, index: number, count: number, seed = 0): number {
  const n = Math.max(1, Math.floor(count))
  const i = Math.min(n - 1, Math.max(0, Math.floor(index)))
  const mid = (n - 1) / 2
  const spread = 2 * Math.abs(i - mid)
  switch (order) {
    case 'reverse': return (n - 1) - i
    case 'center': return spread - (n % 2 === 0 ? 1 : 0)
    case 'edges': return (n - 1) - spread
    case 'random': return shuffledRanks(n, Math.round(seed) | 0)[i] ?? 0
    default: return i
  }
}

/**
 * The time glyph `index` of `count` reads the tracks at.
 *
 * Later glyphs read an EARLIER time (t − rank·delay), which is what makes the
 * motion appear to travel forwards through the word: glyph 3 is showing what
 * glyph 0 showed three delays ago.
 */
export function glyphTime(cfg: VectorTypeConfig, t: number, index: number, count: number): number {
  const { delay, order, seed } = resolveStagger(cfg)
  if (!(delay > 0) || count <= 1) return t
  return t - delay * staggerRank(order, index, count, seed)
}

/**
 * The config as glyph `index` sees it at time `t` — `applyMotion` on that
 * glyph's own clock.
 *
 * This is the function a renderer loops over. With `delay === 0`, `glyphTime`
 * returns `t` for every glyph and this collapses to one shared `applyMotion`
 * result, so a renderer may (and should) hoist it out of the loop then.
 */
export function glyphConfig(cfg: VectorTypeConfig, t: number, index: number, count: number): VectorTypeConfig {
  return applyMotion(cfg, glyphTime(cfg, t, index, count))
}

/**
 * The value a STACK LEAF holds **for one glyph** — the same tracks, read on that
 * glyph's own staggered clock.
 *
 * ## Why this exists, when `applyMotion` already answers for the run
 *
 * The appearance stack is resolved ONCE per frame and every glyph paints under
 * it (`canvas.ts`'s `vtPaintLayers(frame.config, …)`), which is right: a layer's
 * colour, width, blend and anchor are properties of the LAYER, and there is no
 * meaning to "letter 3's version of the layer's opacity". So a stagger — which
 * shifts the clock each glyph reads the tracks at — cannot reach a layer leaf,
 * and measured against a 0 → 1 `appearance.<id>.draw` track at `delay: 0.8` it
 * did not: all four letters reported the same 0.4.
 *
 * **The DRAW-ON is the one exception, and it is an exception by construction
 * rather than by taste.** Its dash is *already* resolved per glyph and has to
 * be — the pattern is measured against the contour it dashes and every
 * letterform is a different length (see `./pathLength.ts`). So it is the one
 * layer leaf that is a per-glyph quantity, which is exactly the kind of thing
 * `motion.stagger` exists to shift the clock of: without this, "the letters draw
 * themselves" is the whole word drawing at once.
 *
 * Evaluates the matching tracks directly rather than cloning a config per glyph
 * (`glyphConfig` does that, and it is `n × layers` clones a frame). The LAST
 * matching track wins, mirroring `applyMotion`'s assignment — two tracks on one
 * path overwrite, they do not accumulate, and the two must agree about which one
 * survives.
 *
 * Returns `fallback` — the run-level value the caller already resolved — when
 * nothing staggers, when nothing animates this path, or when there is one glyph.
 * So a manually-set `draw` and an unstaggered clip are untouched.
 */
export function glyphStackLeaf(
  cfg: VectorTypeConfig,
  /** The layer's STABLE id — matched through `trackLayerId`, so a track saved
   *  against a POSITION still finds its layer and an id path is not confused by
   *  one. Asking "does this track drive this layer" rather than "is this the same
   *  string" is the same question every other proof in this area reduces to. */
  layerId: string,
  leaf: string,
  fallback: number,
  t: number,
  index: number,
  count: number,
): number {
  const { delay } = resolveStagger(cfg)
  if (!(delay > 0) || count <= 1 || !layerId) return fallback
  const tracks = usableTracks(cfg)
  if (!tracks.length) return fallback
  let hit: VtMotionTrack | null = null
  for (const track of tracks) {
    const p = track.path.trim()
    if (!isStackPath(p)) continue
    // A COLOUR track on this layer is not a candidate for a NUMERIC leaf. It
    // cannot match `leaf` today (the only leaf asked for is `draw`, and a colour
    // target is `paint.a` / `paint.b` / `strokeColor`), but this returns a
    // `number` and a colour track has none — so the guard is here rather than
    // resting on a coincidence between two lists that can both grow.
    if (isColorTrack(track)) continue
    const rest = p.slice(VT_STACK_PREFIX.length)
    const dot = rest.indexOf('.')
    if (dot < 0 || rest.slice(dot + 1) !== leaf) continue
    if (trackLayerId(cfg, p) !== layerId) continue
    hit = track
  }
  if (!hit) return fallback
  return trackValue(hit, glyphTime(cfg, t, index, count), resolveDuration(cfg))
}

/**
 * The per-glyph transform at time `t`: tracks in the `glyph.` namespace,
 * evaluated on that glyph's own clock. Identity when none are declared.
 *
 * Composes with placement rather than replacing it — `render.ts`'s
 * `glyphTransform` says where the glyph sits, this says what motion adds.
 */
export function glyphTransform(
  cfg: VectorTypeConfig,
  t: number,
  index: number,
  count: number,
): VtGlyphTransform {
  const tracks = usableTracks(cfg)
  const out: VtGlyphTransform = { ...IDENTITY_GLYPH_TRANSFORM }
  if (!tracks.length) return out
  const gt = glyphTime(cfg, t, index, count)
  const duration = resolveDuration(cfg)
  for (const track of tracks) {
    const field = GLYPH_FIELD[track.path.trim()]
    if (!field) continue
    // Same reason as `glyphStackLeaf`'s guard: every field here is a number, and
    // there is no colour target in the `glyph.` namespace to reach them — but a
    // hand-written track can name one, and `NaN` in `scale` makes the CTM
    // singular and Chrome drops the glyph entirely.
    if (isColorTrack(track)) continue
    out[field] = trackValue(track, gt, duration)
  }
  return out
}
