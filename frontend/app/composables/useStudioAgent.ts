/**
 * useStudioAgent — Phase 1 "tune, everywhere". Generalizes Vibe (NL → validated
 * param patch via /api/vibe) into the unified agent UX: a per-control proposal
 * the user accepts/rejects/re-rolls, then keeps or reverts. Works for ANY studio
 * that exposes a ControlSpec list + a reactive Params object (Gradient, Shader,
 * Type, …) — reusing describeControls + validatePatch inside requestPatch.
 *
 * Tuning is single-op (set a control's value), so changes are param patches, not
 * structural commands — but they ride the same one-prompt UI (`StudioPromptHost`).
 *
 * ## Three takes
 *
 * A studio that passes `opts.takes` gets the OTHER answer shape: instead of one
 * guess shown as a proposal list, the ask comes back as three genuinely different
 * readings, shown as a filmstrip (`PromptTakes.vue`, mounted once in
 * `StudioModalShell.vue` — so every studio wired here gets it without its own
 * template). This composable owns the session: capture the original ONCE, preview
 * a take by writing it into the live params, restore exactly on unhover/dismiss,
 * commit through the SAME `recompute()` + `keep()` path an accepted proposal
 * always used (so undo/autosave integration follows for free).
 *
 * Everything degrades: a server that rejects or ignores `variants`, or a reply
 * with fewer than two usable takes, falls back to today's single proposal.
 * A studio that passes no `opts.takes` never sends `variants` at all, and its
 * request stays byte-identical to what it sends today.
 */
import { computed, ref, shallowRef } from 'vue'
import { $fetch } from 'ofetch'
import type { ControlSpec, Params, ParamValue } from '~/lib/spacetype/effect'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import { useVibeControl, type VibeTakesReply } from '~/composables/useVibeControl'
import { describeControls, validatePatch, type DescribedControl } from '~/lib/spacetype/controlDescriptor'
import { buildReviewPrompt, buildReviewSchema, parseReviewResponse } from '~/lib/agent/protocol'
import type { SurfaceSnapshot } from '~/lib/agent/commandSurface'
import {
  DIFFERS_SUFFIX, PARTIAL_SUFFIX, SIMILAR_SUFFIX,
  TAKE_DISTINCT_MIN,
  hasHonestySuffix, seededIndex, withSuffix,
  checkPromise, logTakeEvent, spreadAroundTake, thumbDistance, thumbSignature, pixelDistance,
  type PromiseCheck, type StudioTake,
} from '~/lib/agent/takes'
import { VARIANTS_UNSUPPORTED, type PromiseDirection } from '~/lib/vibePrompt'
import type { TakeReviewEntry, TakeVerdict } from '~/lib/vibeReview'
import type { GradientRecipe } from '~/lib/gradientfx/recipes'
import { fillPicks, type EyePick } from '~/lib/gradientfx/eyePick'
import { takeThumbFor, type TakeThumb } from '~/lib/agent/takeThumbs'
import { TAKES_PER_SET } from '~/lib/prompt/takesSession'

/** How many readings to ask for: always three (AI in Sailor spec §3.1). The API
 *  accepts 2–4 and rejects anything else loudly, so this is a constant. */
const TAKE_COUNT = TAKES_PER_SET
const THUMB_SIZE = 160
/** Tile-resolution JPEG for the see-first review — a few KB per picture, which
 *  is plenty for judging colour, direction and contrast. */
const REVIEW_JPEG_QUALITY = 0.7

/**
 * A control that swaps the studio's WHOLE base config rather than nudging one
 * value — Gradient's `preset`. Generic on purpose: Shader's `effect` is the same
 * shape (and the same hazard) and can ride this hook when its takes land.
 *
 * Two halves, both required, mirroring `studioTune`'s macro-ordering contract:
 * the macro applies FIRST, and the take's remaining changes are then validated
 * against the SWAPPED config's vocabulary — a preset can change how many colour
 * stops exist, so a stop-colour written against the old list would be dropped
 * (or, worse, land on a stop that means something else).
 */
export interface StudioTakeMacro {
  /** The control key that carries the swap (Gradient: `preset`). */
  key: string
  /** Build the base config for a macro value, or null for an unknown one. */
  apply: (value: string, config: unknown) => unknown | null
  /** The vocabulary of a config AFTER the swap. */
  recontrol: (config: unknown) => ControlSpec[]
}

/**
 * The one repair a promise check is allowed to make.
 *
 * Deliberately narrow. A direction is the only claim with an unambiguous local
 * correction — "the user asked for top-to-bottom and got side-to-side" has one
 * obvious answer, and it is a value the model already implied. A colour or a
 * tone does not: picking one would be choosing something nobody asked for and
 * calling it the model's idea.
 */
export interface StudioTakeRepair {
  /** Candidate writes for a promised direction. Validated against the take's
   *  post-macro vocabulary before anything is applied, so a key this studio does
   *  not offer is dropped rather than invented; return `{}` for a direction this
   *  studio cannot aim. */
  directionPatch: (direction: PromiseDirection, config: unknown) => Record<string, ParamValue>
}

/** What a studio must tell us to draw take thumbnails: which adapter to use, its
 *  config root, and how to view a COPY of that config as Params. The copy is why
 *  `paramsOf` exists — a thumbnail must never be drawn by mutating the config the
 *  user is looking at. */
export interface StudioTakeSource {
  studio: string
  config: () => unknown
  paramsOf: (config: unknown) => Params
  /** Vocabulary for the TAKES ask. Defaults to the tune vocabulary — Gradient
   *  overrides it to add the `preset` macro, which the single-tune path
   *  deliberately still withholds. */
  controls?: () => ControlSpec[]
  /** Guidance for the TAKES ask. MUST match whatever `controls` offers: guidance
   *  naming a key the list lacks is the failure this whole seam exists to stop. */
  guidance?: () => string
  /** Replace the whole base config. Required when `macro` is set — a macro
   *  cannot be expressed through the leaf-writing Params proxy. */
  setConfig?: (config: unknown) => void
  /** The document's width/height ratio, when the CONFIG cannot say — Shape and
   *  Vector Type keep their canvas dimensions on the node. A tile rendered
   *  square for a wide document is a different picture, and the promise checker
   *  and the duplicate pass both measure the tile. */
  aspect?: () => number
  /** Studio-owned view state a macro swap is allowed to disturb — Gradient's
   *  selected layer, which `setConfig` must clamp when a preset arrives with
   *  fewer layers. Captured when the strip opens and put back with the config,
   *  so one hover cannot permanently move the user's selection. */
  captureView?: () => unknown
  restoreView?: (view: unknown) => void
  macro?: StudioTakeMacro
  /** Compose-and-pick, for a studio that has a menu of looks to compose FROM.
   *  Present, the "different directions" ask goes through it and only falls back
   *  to the direct patch path when composing fails. */
  compose?: {
    summarize: (config: unknown) => { base: string, palette: string[] }
    materialize: (recipe: GradientRecipe, own: unknown, seed: string) => unknown | null
  }
  /** How to re-aim this studio's picture when a take's promised DIRECTION did
   *  not come out. Omit it and a direction miss is labelled instead of fixed —
   *  which is the right answer for a studio with no key that aims anything. */
  repair?: StudioTakeRepair
}

/** A cheap deep copy. Every studio config this runs against is the same JSON blob
 *  the studio persists, so JSON round-tripping is the honest tool; anything it
 *  cannot copy is handed back as-is rather than half-copied. */
function cloneConfig<T>(v: T): T {
  try { return JSON.parse(JSON.stringify(v)) as T } catch { return v }
}

/**
 * True ONLY for the 400 `/api/vibe` raises for its own `variants` field — the
 * one that means "this server won't answer in takes". A bare 400 is not enough:
 * the route forwards Anthropic's status verbatim, so a real bad-request from the
 * model call arrives as a 400 too, and silently degrading on that one would hide
 * the bug AND bill the user for a second metered call it can never fix.
 */
function isVariantsUnsupported(e: unknown): boolean {
  const err = e as {
    statusCode?: number; status?: number; statusMessage?: string
    response?: { status?: number }
    data?: { statusMessage?: string; data?: { code?: string } }
  } | null
  const status = err?.statusCode ?? err?.status ?? err?.response?.status
  if (status !== 400) return false
  // `data.code` is the load-bearing one: it is the response BODY the route
  // wrote, so it survives every transport. The two `statusMessage` spellings
  // are ofetch's alias for the HTTP reason phrase, which is a courtesy — HTTP/2
  // has no reason phrase at all, and proxies rewrite it — so they are accepted
  // as a bonus, never relied on.
  return err?.data?.data?.code === VARIANTS_UNSUPPORTED
    || err?.data?.statusMessage === VARIANTS_UNSUPPORTED
    || err?.statusMessage === VARIANTS_UNSUPPORTED
}

/** opts.render returns a PNG data URL of the current studio canvas (enables the
 *  visual self-review pass); opts.apiKey is the Anthropic key for that pass. Both
 *  optional — omit them and the agent is tune-only (no review). */
export function useStudioAgent(opts: { controls: () => ControlSpec[]; params: Params; label: () => string; render?: () => string | null | Promise<string | null>; apiKey?: () => string; tier?: string; guidance?: () => string; takes?: StudioTakeSource }) {
  const { requestPatch, requestTakes, requestTakeReview, requestRecipes, requestEyePick } = useVibeControl()
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const lastPhrase = ref('')
  const changes = ref<ProposedChange[]>([])
  /** The visual self-review: a designer's-eye critique of the rendered result. */
  const review = ref<VisualReview | null>(null)
  const reviewing = ref(false)
  const hovered = ref<number | null>(null)
  /** Prior value of every key a change touched — for accept/reject + revert. */
  const original: Record<string, ParamValue> = {}
  const hasProposal = computed(() => changes.value.length > 0)

  function clearOriginal() { for (const k of Object.keys(original)) delete original[k] }

  /** The vocabulary and guidance the TAKES ask uses. A studio may widen both —
   *  Gradient adds the `preset` macro here and nowhere else, because a take is
   *  previewed non-destructively and only committed on an explicit Keep, whereas
   *  the single-tune path would apply a whole-config swap the instant it landed.
   *  They move together on purpose: guidance that names a key its own list lacks
   *  is the exact failure this pair exists to prevent. */
  function takeControls(): ControlSpec[] { return opts.takes?.controls?.() ?? opts.controls() }
  function takeGuidance(): string | undefined { return opts.takes?.guidance?.() ?? opts.guidance?.() }

  /** Re-apply the accepted patches live onto the reactive params (rejected keys
   *  fall back to their original value). The studio re-renders from params. */
  function recompute() {
    for (const ch of changes.value) {
      const key = ch.command.target!
      opts.params[key] = ch.accepted ? (ch.command.args!.value as ParamValue) : (original[key] as ParamValue)
    }
  }

  function changeFor(key: string, value: ParamValue, rationale: string): ProposedChange {
    const ctrl = opts.controls().find(c => c.key === key)
    return {
      command: { op: 'setParam', target: key, args: { value } },
      label: ctrl?.label ?? key,
      before: String(opts.params[key] ?? ''),
      after: String(value),
      rationale,
      rerollable: true,
      accepted: true,
    }
  }

  // ── Four Takes session ─────────────────────────────────────────────────────
  // shallowRef throughout: the strip keys its thumbnails by the take OBJECT, and
  // a deep ref would hand the component reactive proxies that no longer match
  // the raw keys in that map.
  const takes = shallowRef<StudioTake[]>([])
  const takeThumbs = shallowRef<Map<StudioTake, TakeThumb>>(new Map())
  const takeCurrentThumb = shallowRef<TakeThumb>(null)
  const selectedTake = shallowRef<StudioTake | null>(null)
  const takeDescribed = shallowRef<DescribedControl[]>([])
  /** Every described control's value at the moment the strip opened — the frame
   *  of reference the neighbour spread measures against. Must NOT be re-read
   *  from live params, which carry whatever take is currently previewing. */
  const takeBase = shallowRef<Record<string, ParamValue>>({})
  /** The ONE capture: the prior value of every key any take touches. Restoring
   *  writes these back verbatim, `undefined` included, so a key the config never
   *  had does not survive a preview. */
  let takeOriginal: Record<string, ParamValue> | null = null
  /** A deep copy of the base config as the strip opened — the only way back from
   *  a macro swap. Null for a studio with no macro. */
  let takeOriginalConfig: unknown = null
  /** The studio's own view state at that same moment (Gradient's active layer). */
  let takeOriginalView: unknown = null
  /**
   * One materialized base config per macro VALUE, for the life of the strip.
   *
   * `buildGradientPreset` re-seeds itself on every call — noise seed, flow angle,
   * light azimuth. Calling it once per consumer would mean the tile you looked
   * at, the preview you hovered, and the config you kept were three different
   * gradients, and a second hover would visibly re-roll. So a macro value is
   * built ONCE and every consumer works from a copy of that instance.
   */
  const macroConfigs = new Map<string, unknown>()

  /** The one materialization of `value`, or null if the studio rejects it. */
  function materializeMacro(value: string): unknown | null {
    const src = opts.takes
    const macro = src?.macro
    if (!macro || !src) return null
    if (macroConfigs.has(value)) return macroConfigs.get(value)!
    const built = macro.apply(value, src.config())
    if (built) macroConfigs.set(value, built)
    return built ?? null
  }
  let takeRound = 0

  /** Keys a take asked for that nothing could apply — per take, for the log and
   *  for the `(partial)` caption. */
  const takeDropped = shallowRef<Map<StudioTake, string[]>>(new Map())
  /** How each take's promise measured against its real render. */
  const takePromiseResults = shallowRef<Map<StudioTake, PromiseCheck[]>>(new Map())
  /** What the model said when it looked at its own picture for this take. */
  const takeVerdicts = shallowRef<Map<StudioTake, TakeReviewEntry>>(new Map())
  /** True while the see-first pass is out. The strip is fully usable meanwhile —
   *  this drives a quiet hint, never a block. */
  const reviewingTakes = ref(false)

  const hasTakes = computed(() => takes.value.length > 0)

  /**
   * Turn ONE raw model take into the take the rest of the system handles:
   * macro first (it decides which keys even exist), everything else validated
   * against the resulting vocabulary, and an honest count of what was lost.
   *
   * Returns null for a take with nothing applicable left — that take IS the
   * current config, and showing it as an alternative would be a lie.
   */
  function finalizeTake(rawTake: StudioTake, described: DescribedControl[]): { take: StudioTake, dropped: string[] } | null {
    const src = opts.takes
    const macro = src?.macro
    const raw: Record<string, ParamValue> = {}
    for (const ch of rawTake.changes) raw[ch.key] = ch.value

    let vocabulary = described
    let macroChange: { key: string, value: ParamValue } | null = null
    const macroValue = macro ? raw[macro.key] : undefined
    if (macro && src && typeof macroValue === 'string') {
      const swapped = materializeMacro(macroValue)
      if (swapped) {
        macroChange = { key: macro.key, value: macroValue }
        // Re-describe against the SWAPPED config: a preset can change how many
        // colour stops exist, and a stop colour validated against the old list
        // would be dropped or land on a stop that now means something else.
        vocabulary = describeControls(macro.recontrol(swapped), src.paramsOf(swapped))
      }
    }

    const rest: Record<string, ParamValue> = {}
    for (const [k, v] of Object.entries(raw)) { if (k !== macro?.key) rest[k] = v }
    const valid = validatePatch(rest, vocabulary)
    const changes = Object.entries(valid).map(([key, value]) => ({ key, value }))
    const dropped = Object.keys(rest).filter(k => !(k in valid))
    // A macro value the studio did not recognise is a dropped key like any other.
    if (macro && macroValue !== undefined && !macroChange) dropped.push(macro.key)
    if (macroChange) changes.unshift(macroChange) // macro FIRST — every consumer applies in order
    if (!changes.length) return null

    // More than half the ask lost? Say so on the tile, the same way `(subtle)`
    // does — silent dropping is what let a sunset rationale sit over a rainbow.
    const asked = Object.keys(raw).length
    const label = dropped.length * 2 > asked ? withSuffix(rawTake.label, PARTIAL_SUFFIX) : rawTake.label
    return {
      take: { label, changes, rationale: rawTake.rationale, ...(rawTake.promise ? { promise: rawTake.promise } : {}) },
      dropped,
    }
  }

  /**
   * The ONE place a take's changes become writes. The macro (if any) is at the
   * head of `changes`, so a single ordered pass gives the required
   * macro-then-overrides sequence; `swapBase` is handed the macro VALUE and
   * returns the Params view of whatever base it installed.
   */
  function applyTakeWith(t: StudioTake, params: Params, swapBase: (value: string) => Params | null): void {
    const macro = opts.takes?.macro
    let write = params
    // A COMPOSED take is a whole config, exactly like a macro swap — and it
    // rides the same restore, because the same thing was replaced.
    if (t.config && opts.takes?.setConfig) opts.takes.setConfig(cloneConfig(t.config))
    for (const ch of t.changes) {
      if (macro && ch.key === macro.key) {
        const next = swapBase(String(ch.value))
        if (next) write = next
        continue
      }
      write[ch.key] = ch.value
    }
  }

  /** Install a macro's base config on the LIVE studio. Returns null because the
   *  live Params proxy reads through to whatever `setConfig` installed — there is
   *  no second view to hand back. */
  function swapLiveBase(value: string): Params | null {
    const src = opts.takes
    if (!src?.setConfig) return null
    const swapped = materializeMacro(value)
    // A COPY: the materialization is the shared source of truth for this macro
    // value, and the live config is about to be edited by the take's overrides.
    if (swapped) src.setConfig(cloneConfig(swapped))
    return null
  }

  /** Apply a take to the LIVE studio. */
  function applyTake(t: StudioTake) {
    applyTakeWith(t, opts.params, swapLiveBase)
  }

  /**
   * Undo whatever a preview applied. Two mechanisms, because a macro cannot be
   * undone key-by-key: it replaced the whole base config, so the whole base
   * config is what has to come back. A studio without a macro keeps the
   * (cheaper, byte-exact) per-key restore it always had.
   */
  function restoreTakeOriginal() {
    const src = opts.takes
    // Gated on the SNAPSHOT, not on `macro`: a composed take replaces the whole
    // config without any macro being involved, and a studio that only ever
    // composes would otherwise lose its restore entirely.
    if (src?.setConfig && takeOriginalConfig !== null) {
      src.setConfig(cloneConfig(takeOriginalConfig))
      // The view goes back BEFORE anything else reads it — `setConfig` clamps a
      // selection that a fewer-layer preset made invalid, and leaving it clamped
      // means one hover permanently moved the user's selected layer.
      if (src.restoreView) src.restoreView(takeOriginalView)
      // …and then STOP. The whole config is already back. Replaying the captured
      // keys on top would re-resolve every `layer.` path against whatever index
      // is current now — writing one layer's values into another, which the deep
      // watcher then saves. A hover must not be able to corrupt a document.
      return
    }
    if (!takeOriginal) return
    for (const k of Object.keys(takeOriginal)) opts.params[k] = takeOriginal[k] as ParamValue
  }

  function resetTakes() {
    takes.value = []
    takeThumbs.value = new Map()
    takeCurrentThumb.value = null
    selectedTake.value = null
    takeDescribed.value = []
    takeBase.value = {}
    takeOriginal = null
    takeOriginalConfig = null
    takeOriginalView = null
    macroConfigs.clear()
    takeDropped.value = new Map()
    takePromiseResults.value = new Map()
    takeVerdicts.value = new Map()
    reviewingTakes.value = false
  }

  function logTake(action: 'keep' | 'dismiss' | 'switch', t: StudioTake | null) {
    if (!opts.takes) return
    // How different this take LOOKED from the current design. Free to collect
    // and the only way THUMB_DIFF_MIN ever stops being a guess.
    const visualDiff = t ? thumbDistance(takeThumbs.value.get(t), takeCurrentThumb.value) : null
    logTakeEvent({
      studio: opts.takes.studio,
      prompt: lastPhrase.value,
      takeLabel: t?.label ?? 'yours',
      changes: t?.changes ?? [],
      action,
      ...(visualDiff === null ? {} : { visualDiff: Number(visualDiff.toFixed(2)) }),
      ...(t && takeDropped.value.get(t)?.length ? { droppedKeys: takeDropped.value.get(t)! } : {}),
      ...(t && takePromiseResults.value.get(t)?.length ? { promiseResults: takePromiseResults.value.get(t)! } : {}),
      ...(t && takeVerdicts.value.get(t) ? { reviewVerdict: takeVerdicts.value.get(t)! } : {}),
      // A composed take has no `changes` to record, so without this it would log
      // nothing about itself — and the pick log is the whole taste-data thesis.
      ...(t?.recipe ? { recipe: t.recipe } : {}),
    })
  }

  /**
   * Draw every tile. Fire-and-forget on purpose — the strip is already on screen
   * with pending tiles, and each thumbnail replaces one as it lands. The base
   * config is copied ONCE, synchronously, before the first await: the user can
   * hover (and so mutate the live config) while these are still rendering.
   */
  async function renderTakeThumbs(list: StudioTake[]) {
    const src = opts.takes
    if (!src) return
    const adapter = takeThumbFor(src.studio)
    const baseSnapshot = cloneConfig(src.config())
    const draw = async (t: StudioTake) => {
      // A macro take is drawn from the config the macro produces, not from a
      // copy of the user's — otherwise a preset tile shows the old base look
      // with a couple of colours moved, which is precisely the lie that was
      // shipped.
      // A composed take IS its config — there is nothing to patch onto a copy.
      if (t.config) return adapter(cloneConfig(t.config), THUMB_SIZE, src.aspect?.())
      let snapshot = cloneConfig(baseSnapshot)
      applyTakeWith(t, src.paramsOf(snapshot), (value) => {
        const swapped = materializeMacro(value)
        if (!swapped) return null
        // The same instance every consumer sees, copied so the overrides below
        // cannot leak back into it.
        snapshot = cloneConfig(swapped)
        return src.paramsOf(snapshot)
      })
      return adapter(snapshot, THUMB_SIZE, src.aspect?.())
    }
    if (!takeCurrentThumb.value) {
      const yours = await adapter(cloneConfig(baseSnapshot), THUMB_SIZE, src.aspect?.())
      if (takes.value === list) takeCurrentThumb.value = yours
    }
    for (const t of list) {
      const thumb = await draw(t)
      if (takes.value !== list) return // superseded by a re-roll or a dismiss
      takeThumbs.value = new Map(takeThumbs.value).set(t, thumb)
    }
    // The see-first loop: give the model a chance to catch its own mistakes.
    await reviewOwnTakes(list, draw)
    // The checkers still run, and still run LAST: they were the judge, they are
    // now the backstop. Nothing they used to catch stops being caught.
    await verifyPromises(takes.value, draw)
    await separateDuplicates(takes.value, draw)
  }

  /**
   * Four takes must be four PICTURES. Nothing checked that for MODEL takes —
   * the pairwise pass only ever ran over parametric spreads — and the owner got
   * three near-identical tiles with no word said. Reproduced on the real
   * renderer: two takes with different change lists measured 0.00 apart.
   *
   * Same remedy shape as everywhere else in this feature, and the same bounds:
   * ONE deterministic local attempt per slot, then honesty. The attempt here is
   * a spread around the take ITSELF — the neighbours `spreadAroundTake` already
   * knows how to build — and the first candidate that clears `THUMB_DIFF_MIN`
   * against every other tile wins. No second model call, ever.
   *
   * Runs AFTER the promise pass on purpose: `(differs)` outranks `(similar)`,
   * and letting the louder suffix land first means neither has to rewrite the
   * other.
   */
  async function separateDuplicates(list: StudioTake[], draw: (t: StudioTake) => Promise<TakeThumb>) {
    if (takes.value !== list) return
    let current = takes.value
    const tried = new Set<number>()
    /** Slots that tried and failed. Kept as a SET rather than read off the label,
     *  because a take that already carried a louder suffix keeps it (see the
     *  concede branch) and so cannot be recognised by its badge. */
    const conceded = new Set<number>()

    const sigOf = (i: number) => thumbSignature(takeThumbs.value.get(current[i]!))
    /** The nearest other tile to slot `i`, and how far away it is. */
    const nearest = (i: number, sig: Uint8ClampedArray | null): { j: number, d: number } | null => {
      if (!sig) return null
      let best: { j: number, d: number } | null = null
      for (let j = 0; j < current.length; j++) {
        if (j === i) continue
        const d = pixelDistance(sig, sigOf(j))
        if (d === null) continue
        if (!best || d < best.d) best = { j, d }
      }
      return best
    }
    const loneliness = (i: number, sig: Uint8ClampedArray | null): number | null =>
      nearest(i, sig)?.d ?? null

    for (let guard = 0; guard < current.length * 2; guard++) {
      // The most crowded slot that has not had its attempt yet.
      let worst: { i: number, d: number } | null = null
      for (let i = 0; i < current.length; i++) {
        // Only a take that has already CONCEDED is out of moves. A `(partial)`
        // or `(differs)` take is still a candidate — in fact it is the likeliest
        // duplicate of all, because a take whose ask was gutted has thin
        // surviving fragments that easily converge with its neighbour's. Skipping
        // every labelled take is what let two "(partial)" twins render as one
        // picture with nothing said.
        if (tried.has(i) || conceded.has(i) || current[i]!.label.includes(SIMILAR_SUFFIX.trim())) continue
        const near = nearest(i, sigOf(i))
        if (!near || near.d >= TAKE_DISTINCT_MIN) continue
        // If the tile it resembles has ALREADY conceded, the resemblance is
        // recorded. Two "(similar)" badges say the same thing twice and blame
        // both members for something only one of them has to fix.
        if (conceded.has(near.j) || current[near.j]!.label.includes(SIMILAR_SUFFIX.trim())) continue
        if (!worst || near.d < worst.d) worst = { i, d: near.d }
      }
      if (!worst) break
      const i = worst.i
      tried.add(i)
      const take = current[i]!

      let kept = false
      const macroKey = opts.takes?.macro?.key
      const macroChange = macroKey ? take.changes.find(c => c.key === macroKey) : undefined
      // The vocabulary this take's values actually live in — POST-swap for a
      // macro take. Rebuilding against the pre-swap list would quietly shed the
      // changes that only exist because the macro ran, which is the very defect
      // this feature exists to catch, committed by the feature itself.
      const vocabulary = vocabularyFor(take)
      // Spread in the take's OWN vocabulary, with its own config as the frame of
      // reference. Handing `spreadAroundTake` the pre-swap list would make it
      // drop the post-swap keys before a candidate ever got here — no amount of
      // re-validation downstream can recover what was never offered.
      const spreadBase = vocabulary === takeDescribed.value
        ? takeBase.value
        : Object.fromEntries(vocabulary.map(d => [d.path, d.current]))
      const candidates = spreadAroundTake(
        vocabulary, spreadBase, take, `${lastPhrase.value}#distinct${i}`,
      )
      for (const candidate of candidates) {
        // Keep the take's own identity — a spread caption would rename a tile
        // the model labelled, and only its VALUES are in question here. The
        // macro rides at the head, untouched: separating a take must never
        // change which base look it is.
        const valid = validatePatch(
          Object.fromEntries(candidate.changes.filter(c => c.key !== macroKey).map(c => [c.key, c.value])),
          vocabulary,
        )
        const rebuilt = Object.entries(valid).map(([key, value]) => ({ key, value }))
        const changes = macroChange ? [macroChange, ...rebuilt] : rebuilt
        // Anything the take HAD that the candidate cannot carry is a loss, and
        // losses are counted, never swallowed.
        const shed = take.changes
          .filter(c => c.key !== macroKey && !(c.key in valid))
          .map(c => c.key)
        const moved: StudioTake = { ...take, changes }
        const thumb = await draw(moved)
        if (takes.value !== current) return
        const d = loneliness(i, thumbSignature(thumb))
        if (d === null || d < TAKE_DISTINCT_MIN) continue
        // …and it must still keep the promise the previous pass just verified.
        // Separation moves the very dials a direction claim depends on, so a
        // candidate that lands off-promise is refused rather than committed
        // behind an already-passed check.
        if (take.promise && checkPromise(thumbSignature(thumb), take.promise).some(r => !r.ok)) continue
        replaceTake(i, moved, thumb, (next) => { current = next })
        if (shed.length) {
          console.warn(`[takes] separating "${take.label}" could not carry: ${shed.join(', ')}`)
          const nextDropped = new Map(takeDropped.value)
          nextDropped.set(moved, [...(nextDropped.get(moved) ?? []), ...shed])
          takeDropped.value = nextDropped
        }
        kept = true
        break
      }
      // Nudging dials could not do it. On a studio with a whole-look macro there
      // is one more honest move: offer a DIFFERENT BASE. "Four different
      // directions" that delivers the same picture twice has wasted a slot, and
      // a genuinely different base look is the fulfilment the ask deserved.
      if (!kept) kept = await offerDifferentBase(i, take, draw, (next) => { current = next })

      if (!kept) {
        conceded.add(i)
        console.warn(`[takes] "${take.label}" renders too close to another take (${worst.d.toFixed(1)} apart) and could not be separated`)
        // Only badge a tile that has nothing to say yet. `withSuffix` TRIMS the
        // label to make room, so stamping a second suffix does not append — it
        // replaces, and "(partial)" (this take lost half its ask) is a louder
        // admission than "(similar)". The warning above still records the
        // finding either way; what is protected here is the tile's one badge.
        if (!hasHonestySuffix(take.label)) {
          replaceTake(i, { ...take, label: withSuffix(take.label, SIMILAR_SUFFIX) }, takeThumbs.value.get(take) ?? null, (next) => { current = next })
        }
      }
    }
  }

  /**
   * Replace a stuck duplicate with a base look no take is using.
   *
   * Only for a studio with a macro, because only there does "a different base"
   * mean anything. Everything about the replacement is deliberately OURS and
   * says so: it carries the preset's own name as its label and a plain sentence
   * explaining why it is on screen, never the duplicate's label wearing a new
   * value — passing our substitution off as the model's reading would be the
   * same species of dishonesty this whole feature exists to prevent.
   *
   * Its promise is dropped, necessarily: a claim about how the OLD look would
   * render says nothing true about a different base.
   *
   * Deterministic: the unused presets are walked from a seeded offset, so the
   * same crowded strip yields the same substitution every time.
   */
  async function offerDifferentBase(
    i: number,
    take: StudioTake,
    draw: (t: StudioTake) => Promise<TakeThumb>,
    onList: (list: StudioTake[]) => void,
  ): Promise<boolean> {
    const macro = opts.takes?.macro
    if (!macro) return false
    const offered = takeDescribed.value.find(d => d.path === macro.key)?.options ?? []
    if (!offered.length) return false
    const inUse = new Set(
      takes.value.map(t => t.changes.find(c => c.key === macro.key)?.value).filter(v => typeof v === 'string'),
    )
    const spare = offered.filter(name => !inUse.has(name))
    if (!spare.length) return false

    const list = takes.value
    const start = seededIndex(`${lastPhrase.value}#base${i}`, spare.length)
    for (let k = 0; k < spare.length; k++) {
      const name = spare[(start + k) % spare.length]!
      const candidate: StudioTake = {
        label: name,
        changes: [{ key: macro.key, value: name }],
        rationale: `A different base look — offered because two takes came out the same.`,
        // promise deliberately absent
      }
      const thumb = await draw(candidate)
      if (takes.value !== list) return false // superseded while we were drawing
      const sig = thumbSignature(thumb)
      if (!sig) continue
      let lonely = true
      takes.value.forEach((other, j) => {
        if (j === i) return
        const d = pixelDistance(sig, thumbSignature(takeThumbs.value.get(other)))
        if (d !== null && d < TAKE_DISTINCT_MIN) lonely = false
      })
      // "yours" is a tile in this strip too. A spare preset that renders like the
      // design already on screen has separated nothing the user can see.
      const vsYours = pixelDistance(sig, thumbSignature(takeCurrentThumb.value))
      if (vsYours !== null && vsYours < TAKE_DISTINCT_MIN) lonely = false
      if (!lonely) continue
      console.info(`[takes] "${take.label}" matched another take, so a different base is offered instead: ${name}`)
      replaceTake(i, candidate, thumb, onList)
      // A fresh take carries none of the old one's baggage — neither the keys it
      // could not apply nor, crucially, its promise findings: those were
      // measured on a picture that is no longer on this tile, and logging them
      // against the new one would put fabricated evidence into the taste stream.
      const nextDropped = new Map(takeDropped.value)
      nextDropped.delete(candidate)
      takeDropped.value = nextDropped
      const nextResults = new Map(takePromiseResults.value)
      nextResults.delete(candidate)
      takePromiseResults.value = nextResults
      return true
    }
    return false
  }

  /** Swap one slot's take, carrying its thumbnail and its side-tables with it. */
  function replaceTake(i: number, next: StudioTake, thumb: TakeThumb, onList: (list: StudioTake[]) => void) {
    const old = takes.value[i]!
    const nextList = takes.value.slice()
    nextList[i] = next
    const move = <V>(m: Map<StudioTake, V>) => {
      const out = new Map(m)
      const v = out.get(old)
      out.delete(old)
      if (v !== undefined) out.set(next, v)
      return out
    }
    const nextThumbs = new Map(takeThumbs.value)
    nextThumbs.delete(old)
    nextThumbs.set(next, thumb)
    takes.value = nextList
    takeThumbs.value = nextThumbs
    takePromiseResults.value = move(takePromiseResults.value)
    takeDropped.value = move(takeDropped.value)
    if (selectedTake.value === old) selectedTake.value = next
    onList(nextList)
  }



  /**
   * Compose-and-pick: the flow that stops asking the model to drive our machinery.
   *
   * The old path handed it sixty control keys and asked for four parameter
   * patches — a translation job it is bad at, and every failure of the last week
   * was a symptom of that. Here it does the two things it IS good at, and neither
   * of them is translation:
   *
   *   1. compose recipes from menus we wrote (which look, which colours, which
   *      moods) — it never names a control key;
   *   2. look at the candidates OUR code built and rendered, and pick four.
   *
   * Everything between and after those two is deterministic and ours. Returns
   * false when the composing call fails, and the caller falls back to the old
   * blind path entirely unchanged — the two do not entangle.
   */
  async function composeAndPick(phrase: string, avoid: string[] = []): Promise<boolean> {
    const src = opts.takes
    const compose = src?.compose
    if (!src || !compose) return false

    // ── THE BASELINE IS TAKEN HERE, BEFORE THE FIRST AWAIT ──────────────────
    //
    // Not merely "once per call" — once BEFORE anything can be awaited. `ask`
    // empties the strip first, so nothing is interactive during its awaits; a
    // re-roll does not: the OLD strip stays on screen and hoverable right
    // through the recipe call and the candidate renders. A hover landing in that
    // window makes the live config a candidate, and reading the baseline after
    // the await would adopt that candidate as the user's design — restored onto
    // forever after, and saved by the deep watcher. The same reading poisons
    // `baseSnapshot`, so the anchor tile and every "yours" recipe would be built
    // on a tile the user merely passed the mouse over.
    //
    // `moreDirections` calls `restoreTakeOriginal()` synchronously before this,
    // so entry-time state is the true original. A hover arriving during the
    // awaits is then handled by `showPicks`'s pre-swap restore, which now has
    // the right baseline to restore TO.
    const entryConfig = cloneConfig(src.config())
    const entryView = src.captureView?.() ?? null
    const entrySummary = compose.summarize(entryConfig)

    /** Say it once, loudly, and put it where it can be COUNTED. A silent
     *  fallback is how the owner came to judge the old engine believing it was
     *  the new one — the strip looked plausible, and nothing anywhere said which
     *  path had built it. */
    const noteFallback = (reason: string) => {
      if (!opts.takes) return
      logTakeEvent({
        studio: opts.takes.studio,
        prompt: phrase,
        takeLabel: '',
        changes: [],
        action: 'fallback',
        fallback: reason,
      })
    }
    const fellBack = (reason: string) => {
      console.warn(`[takes] compose-and-pick unavailable, using the direct path — ${reason}`)
      noteFallback(reason)
      return false
    }

    let recipes: GradientRecipe[]
    try {
      recipes = await requestRecipes(
        avoid.length
          ? `${phrase} — and make these DIFFERENT from what was already shown: ${avoid.join(', ')}`
          : phrase,
        entrySummary,
      )
    } catch (e) {
      // Surface what the SERVER said where it is available — a 405 (route not
      // reachable), a 503 (no key) and a 502 (nothing usable came back) are
      // three completely different problems that used to look identical.
      const err = e as { statusCode?: number, status?: number, data?: { message?: string, statusMessage?: string } } | null
      const status = err?.statusCode ?? err?.status
      const detail = err?.data?.message ?? err?.data?.statusMessage ?? (e instanceof Error ? e.message : String(e))
      return fellBack(`the recipe call failed${status ? ` (${status})` : ''}: ${detail}`)
    }
    if (recipes.length < 2) return fellBack(`only ${recipes.length} usable recipe(s) came back`)

    // ── build and render every candidate. Local, free, and entirely ours. ────
    const adapter = takeThumbFor(src.studio)
    const built: { recipe: GradientRecipe, config: unknown, thumb: TakeThumb }[] = []
    // The user's design as it was when they asked — NOT as it is now, which may
    // be whatever they are hovering.
    const baseSnapshot = entryConfig
    for (const recipe of recipes) {
      // A STABLE seed per recipe: `buildGradientPreset` re-rolls its noise and
      // its orientation on every call, so without this the same recipe would
      // materialize differently for the candidate render, the hover and the
      // keep — and the descriptor's direction facts would be true of one roll
      // only. Same phrase and name ⇒ same picture, always.
      const config = compose.materialize(recipe, baseSnapshot, `${phrase}#${recipe.name}`)
      if (!config) continue
      const thumb = await adapter(cloneConfig(config), THUMB_SIZE, src.aspect?.())
      built.push({ recipe, config, thumb })
    }
    if (built.length < 2) return fellBack(`only ${built.length} of ${recipes.length} recipes rendered`)

    const yoursThumb = await adapter(cloneConfig(baseSnapshot), THUMB_SIZE, src.aspect?.())
    const current = asReviewImage(yoursThumb)
    const shots = built.map(b => asReviewImage(b.thumb))
    const sigs = built.map(b => thumbSignature(b.thumb))
    const spread = (a: number, b: number) => pixelDistance(sigs[a] ?? null, sigs[b] ?? null)
    let shownList: StudioTake[] | null = null

    // ── the baseline is captured ONCE, here, before anything is on screen ────
    //
    // It must not be re-taken per paint. The strip paints twice — ours, then the
    // eye-pick's reorder — and by the time the reorder lands the user may be
    // hovering or holding a provisional tile, which means the LIVE config is a
    // candidate. Re-capturing then would enshrine that candidate as "the user's
    // design", and every later restore — unhover, dismiss, a click on "yours" —
    // would land on it and the studio's deep watcher would save it. A document
    // replaced by a hover, one seam over from the same bug in the macro path.
    takeDescribed.value = describeControls(takeControls(), opts.params)
    takeBase.value = Object.fromEntries(takeDescribed.value.map(d => [d.path, (opts.params[d.path] ?? d.current) as ParamValue]))
    takeOriginal = {}
    takeOriginalConfig = cloneConfig(entryConfig)
    takeOriginalView = entryView
    takeCurrentThumb.value = yoursThumb

    /**
     * Put four on screen. Called twice: once immediately on OUR distinctness
     * ranking, once more when the eye-pick lands.
     *
     * Painting first is the answer to this flow's real latency: the candidates
     * are already rendered and already good, our ranking costs microseconds, and
     * the eye-pick is a second network round trip the user would otherwise spend
     * looking at an empty strip. So first paint stops depending on that call at
     * all, and the pick reorders in place when it arrives.
     */
    const showPicks = (picks: EyePick[], source: 'ours' | 'the eye') => {
      const filled = fillPicks(picks, built.length, spread)
      const chosen = filled.map((p) => {
        const b = built[p.index]!
        return {
          // Code POINTS, not UTF-16 units — slicing mid-surrogate leaves a lone
          // half in the label, the exact bug `truncateLabel` exists for upstream.
          label: [...(p.label ?? b.recipe.name)].slice(0, 24).join(''),
          changes: [],
          recipe: { base: b.recipe.base, palette: b.recipe.palette, mood: b.recipe.mood },
          rationale: p.reason ?? `${b.recipe.base} base, ${b.recipe.palette.join(' → ')}${b.recipe.mood.length ? `, ${b.recipe.mood.join(' and ')}` : ''}`,
          config: b.config,
        } as StudioTake
      })

      // Whatever was being previewed belonged to the OLD list. Put the user's
      // own design back before the tiles change identity underneath them, so the
      // canvas is never showing a design no tile on screen claims.
      restoreTakeOriginal()
      takes.value = chosen
      shownList = chosen
      takeThumbs.value = new Map(chosen.map((t, i) => [t, built[filled[i]!.index]!.thumb]))
      // POLICY: a reorder clears the selection and leaves the user's own design
      // live. The alternative — carry the selection over when its take survived
      // — is inconsistent by construction: the eye-pick's whole job is to
      // replace candidates our ranking got wrong, so it sometimes replaces the
      // very tile the user had selected and sometimes does not, and the strip
      // would behave differently for reasons invisible to the person watching
      // it. Re-applying a preview after the tiles visibly changed identity is
      // also a decision they did not make. Clearing is uniform, and it rests on
      // the one thing that is unambiguously theirs.
      selectedTake.value = null

      // TELEMETRY, not a gate — and the distinction is the point. The badge
      // machinery that used to police the strip is deliberately NOT run in this
      // flow: these four were chosen by LOOKING at them, which is a stronger
      // check than any of it, and a tile the model picked after seeing it does
      // not need a badge apologising for itself. The measurement is free though,
      // so the distances are logged and nothing is labelled.
      const pairs: number[] = []
      for (let a = 0; a < filled.length; a++) {
        for (let b = a + 1; b < filled.length; b++) {
          const d = spread(filled[a]!.index, filled[b]!.index)
          if (d !== null) pairs.push(d)
        }
      }
      console.info(
        `[takes] composed ${built.length}, showing ${filled.length} chosen by ${source}`
        + (pairs.length ? ` · closest pair ${Math.min(...pairs).toFixed(1)}` : '')
        + ` · ${filled.map(p => `${built[p.index]!.recipe.name}${p.reason ? ` (${p.reason})` : ' (ours)'}`).join(' · ')}`,
      )
    }

    showPicks([], 'ours') // on screen NOW, before the second call

    if (!current || shots.some(s => !s)) return true
    const picks = await requestEyePick(
      phrase,
      built.map((b, i) => ({ name: b.recipe.name, thumbnail: shots[i]! })),
      current,
    )
    if (takes.value !== shownList) return true // the user moved on; leave it be
    if (!picks.length) {
      // Same shape of event as a recipe fallback, for the same reason: without
      // it, "the eye-pick never runs" and "the eye-pick always agrees with us"
      // are indistinguishable in the data.
      noteFallback('the eye-pick was unavailable — kept the four we chose ourselves')
      return true
    }
    showPicks(picks, 'the eye')
    return true
  }

  /** A tile as the review route wants it: tile-resolution JPEG, a few KB. */
  function asReviewImage(thumb: TakeThumb): string | null {
    if (!thumb) return null
    if (typeof thumb === 'string') return thumb
    try { return thumb.toDataURL('image/jpeg', REVIEW_JPEG_QUALITY) } catch { return null }
  }

  /**
   * The see-first loop: show the model the four pictures its own takes produced,
   * with the design the user already had for reference, and let it keep, fix or
   * replace each one BEFORE the user judges them.
   *
   * This is the architecture change the checkers were always heading towards.
   * They used to be an after-the-fact court — measuring the result and labelling
   * what was wrong. Now the model gets to see its own work first, and they run
   * afterwards as a backstop.
   *
   * Bounded hard, in every direction:
   *   • ONE round. A fixed take is never re-reviewed; recursion here would be a
   *     model arguing with itself on the user's time.
   *   • Fails CLOSED. No key, any error, a timeout — the strip is exactly what it
   *     would have been, and one console line says the review was skipped.
   *   • Never first-paint. The tiles are already on screen and fully usable; this
   *     runs after them, behind a quiet hint.
   *   • Superseded-checked at every await. If the user picked, kept or dismissed
   *     while the review was out, what they SAW is what they get.
   */
  async function reviewOwnTakes(list: StudioTake[], draw: (t: StudioTake) => Promise<TakeThumb>) {
    const src = opts.takes
    if (!src || takes.value !== list || !lastPhrase.value) return
    const current = asReviewImage(takeCurrentThumb.value)
    const shots = list.map(t => asReviewImage(takeThumbs.value.get(t) ?? null))
    // Every tile must have a picture: reviewing a strip where some tiles failed
    // to draw would ask the model to judge blanks.
    if (!current || shots.some(s => !s)) {
      console.info('[takes] see-first review skipped: not every tile has a picture yet')
      return
    }

    reviewingTakes.value = true
    let reviews: TakeReviewEntry[] | null = null
    try {
      reviews = await requestTakeReview(
        takeDescribed.value,
        lastPhrase.value,
        list.map((t, i) => ({ label: t.label, changes: t.changes, thumbnail: shots[i]! })),
        current,
      )
    } finally {
      reviewingTakes.value = false
    }
    if (!reviews) { console.info('[takes] see-first review skipped (no key, an error, or too slow)'); return }
    if (takes.value !== list) return // the user moved on while it was out

    let current2 = list
    const applied: TakeVerdict[] = []
    for (let i = 0; i < current2.length; i++) {
      const verdict = reviews[i]
      if (!verdict) continue
      const take = current2[i]!
      takeVerdicts.value = new Map(takeVerdicts.value).set(take, verdict)
      applied.push(verdict.verdict)
      if (verdict.verdict === 'keep' || !verdict.changes?.length) continue

      // Through the SAME door as an original take: macro first, validated
      // against the post-swap vocabulary, losses counted. A reviewed take is a
      // take, and gets no shortcuts the model's first answer did not get.
      const done = finalizeTake({
        label: verdict.label ?? take.label,
        changes: verdict.changes as { key: string, value: ParamValue }[],
        rationale: verdict.reason ?? take.rationale,
        // A fix keeps the take's promise (same intent, corrected values); a
        // REPLACE is a different reading, so the old claim would not be about it.
        ...(verdict.verdict === 'fix' && take.promise ? { promise: take.promise } : {}),
      }, takeDescribed.value)
      if (!done) continue

      const thumb = await draw(done.take)
      if (takes.value !== current2) return
      replaceTake(i, done.take, thumb, (next) => { current2 = next })
      takeVerdicts.value = new Map(takeVerdicts.value).set(done.take, verdict)
      const nextDropped = new Map(takeDropped.value)
      if (done.dropped.length) nextDropped.set(done.take, done.dropped)
      else nextDropped.delete(done.take)
      takeDropped.value = nextDropped
      // The old picture's promise findings describe a picture that is gone.
      const nextResults = new Map(takePromiseResults.value)
      nextResults.delete(done.take)
      takePromiseResults.value = nextResults
    }

    const counts = applied.reduce<Record<string, number>>((a, v) => ({ ...a, [v]: (a[v] ?? 0) + 1 }), {})
    console.info(
      `[takes] see-first review: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`
      + ` · ${reviews.map((r, i) => `"${list[i]?.label}" ${r.verdict}${r.reason ? `: ${r.reason}` : ''}`).join(' · ')}`,
    )
  }

  /** The vocabulary a take's non-macro changes were (and must be) validated
   *  against — the swapped config's when the take carries a macro. */
  function vocabularyFor(t: StudioTake): DescribedControl[] {
    const src = opts.takes
    const macro = src?.macro
    const value = macro ? t.changes.find(c => c.key === macro.key)?.value : undefined
    if (macro && src && typeof value === 'string') {
      const swapped = materializeMacro(value)
      if (swapped) return describeControls(macro.recontrol(swapped), src.paramsOf(swapped))
    }
    return takeDescribed.value
  }

  /**
   * Check what each take PROMISED against what it actually rendered — the
   * general safety net over the whole intent chain. The model can be wrong, the
   * vocabulary can be missing a key, a preset can be mis-aimed, a renderer can
   * surprise us; all of those end as a picture that does not match the claim,
   * and this is the one place that notices without needing to know which.
   *
   * Three outcomes, in order of preference:
   *   1. the claim holds — say nothing;
   *   2. a DIRECTION claim broke and this studio offers something to aim with —
   *      one local repair, kept only if the check then passes;
   *   3. anything still broken — label the tile, warn with what was measured,
   *      and record it. Never a second model call, and never a repair for a
   *      colour or a tone: choosing one would be inventing an intent.
   *
   * A take with no promise, or one whose render failed, is skipped entirely.
   * Missing evidence is not a broken promise.
   */
  async function verifyPromises(list: StudioTake[], draw: (t: StudioTake) => Promise<TakeThumb>) {
    const src = opts.takes
    if (!src) return
    // Resync rather than trust the argument. `reviewOwnTakes` runs first and
    // may have replaced whole slots, so `list` can already be a stale array —
    // and writing through a stale one would resurrect the tiles it replaced.
    if (takes.value !== list) return
    let current = takes.value

    const commit = (i: number, next: StudioTake, thumb: TakeThumb) => {
      const old = current[i]!
      const nextList = current.slice()
      nextList[i] = next
      const nextThumbs = new Map(takeThumbs.value)
      nextThumbs.delete(old)
      nextThumbs.set(next, thumb)
      const nextResults = new Map(takePromiseResults.value)
      const carried = nextResults.get(old)
      nextResults.delete(old)
      if (carried) nextResults.set(next, carried)
      const nextDropped = new Map(takeDropped.value)
      const lost = nextDropped.get(old)
      nextDropped.delete(old)
      if (lost) nextDropped.set(next, lost)
      current = nextList
      takes.value = nextList
      takeThumbs.value = nextThumbs
      takePromiseResults.value = nextResults
      takeDropped.value = nextDropped
      if (selectedTake.value === old) selectedTake.value = next
    }

    for (let i = 0; i < current.length; i++) {
      let take = current[i]!
      const promise = take.promise
      if (!promise) continue
      let results = checkPromise(thumbSignature(takeThumbs.value.get(take)), promise)
      if (!results.length) continue // nothing measurable — not a miss

      // ── one local repair, for direction only ────────────────────────────
      const missedDirection = results.some(r => r.claim === 'direction' && !r.ok)
      if (missedDirection && promise.direction && src.repair) {
        const patch = validatePatch(
          src.repair.directionPatch(promise.direction, src.config()),
          vocabularyFor(take),
        )
        const entries = Object.entries(patch)
        if (entries.length) {
          const changes = take.changes.filter(c => !(c.key in patch))
            .concat(entries.map(([key, value]) => ({ key, value })))
          const candidate: StudioTake = { ...take, changes }
          const thumb = await draw(candidate)
          if (takes.value !== current) return // superseded while we were drawing
          const after = checkPromise(thumbSignature(thumb), promise)
          if (after.every(r => r.claim !== 'direction' || r.ok)) {
            // Kept — and only now, so a repair that did not work leaves no trace.
            commit(i, candidate, thumb)
            take = candidate
            results = after
          }
        }
      }

      const failed = results.filter(r => !r.ok)
      takePromiseResults.value = new Map(takePromiseResults.value).set(take, results)
      if (!failed.length) continue

      for (const r of failed) {
        console.warn(`[takes] "${take.label}" promised ${r.claim} ${JSON.stringify((promise as Record<string, unknown>)[r.claim])} — the render is ${r.measured}`)
      }
      // ONE suffix. `(partial)` already says the stronger thing about a take
      // that lost half its changes, so `(differs)` does not pile on.
      if (!hasHonestySuffix(take.label)) {
        commit(i, { ...take, label: withSuffix(take.label, DIFFERS_SUFFIX) }, takeThumbs.value.get(take) ?? null)
      }
    }
  }

  /** Show a list of takes. The live config MUST equal the original when this is
   *  called — that is what makes the capture below the real prior value. */
  function setTakes(list: StudioTake[]) {
    takeOriginal ??= {}
    for (const t of list) {
      for (const ch of t.changes) {
        if (!(ch.key in takeOriginal!)) takeOriginal![ch.key] = opts.params[ch.key] as ParamValue
      }
    }
    takes.value = list
    takeThumbs.value = new Map()
    selectedTake.value = null
    void renderTakeThumbs(list)
  }

  /** Validate a whole reply into showable takes, recording what each one lost. */
  function finalizeTakes(reply: VibeTakesReply): { takes: StudioTake[], dropped: Map<StudioTake, string[]> } {
    const out: StudioTake[] = []
    const dropped = new Map<StudioTake, string[]>()
    for (const raw of reply.takes) {
      const done = finalizeTake(raw, reply.described)
      if (!done) continue
      out.push(done.take)
      if (done.dropped.length) dropped.set(done.take, done.dropped)
    }
    const lost = [...dropped.values()].flat()
    if (lost.length) {
      // Third time this class has bitten. It is no longer allowed to be silent.
      console.warn(
        `[takes] ${lost.length} requested key(s) could not be applied and were dropped:`,
        [...new Set(lost)].join(', '),
      )
      // …and one STRIP-level line beside it, so a single console paste from a
      // screenshot is enough to diagnose a vocabulary gap: which take lost what,
      // rather than a merged set with no idea who asked for which key.
      console.info(
        '[takes] dropped by take: '
        + out.map(t => `"${t.label}" ${(dropped.get(t) ?? []).length} (${(dropped.get(t) ?? []).join(', ') || 'none'})`).join(' · '),
      )
    }
    return { takes: out, dropped }
  }

  function openTakes(reply: VibeTakesReply, finalized: { takes: StudioTake[], dropped: Map<StudioTake, string[]> }) {
    takeDescribed.value = reply.described
    takeBase.value = Object.fromEntries(
      reply.described.map(d => [d.path, (opts.params[d.path] ?? d.current) as ParamValue]),
    )
    takeOriginal = {}
    takeOriginalConfig = (opts.takes?.macro || opts.takes?.compose) ? cloneConfig(opts.takes.config()) : null
    takeOriginalView = opts.takes?.captureView?.() ?? null
    takeCurrentThumb.value = null
    takeDropped.value = finalized.dropped
    setTakes(finalized.takes)
  }

  /** Hover: show `t`, or fall back to whatever is SELECTED (a selection is live,
   *  so leaving the row must not undo it) and only then to the original. */
  function previewTake(t: StudioTake | null) {
    restoreTakeOriginal()
    const show = t ?? selectedTake.value
    if (show) applyTake(show)
  }

  /** Click a tile, or "yours" (null) to reselect the original. */
  function selectTake(t: StudioTake | null) {
    selectedTake.value = t
    restoreTakeOriginal()
    if (t) applyTake(t)
    logTake('switch', t)
  }

  /**
   * Commit the pick. Deliberately NOT "the values are already live, just clear
   * the strip": the take is put back to the original and then written through
   * `recompute()` — the exact writer an accepted proposal used — and committed
   * with the existing `keep()`. Anything hanging off that path (undo, autosave,
   * the studio's own watchers) therefore sees a keep identical to today's.
   */
  function keepTake() {
    const t = selectedTake.value
    if (!t) return
    restoreTakeOriginal()
    clearOriginal()
    const macro = opts.takes?.macro
    // A COMPOSED take is nothing but its config: there are no leaf changes to
    // route through `recompute`, so installing it IS the commit. Without this,
    // keep restored the original, found an empty proposal, and handed the user
    // back the design they were trying to replace — the flow's terminal action
    // throwing away the whole point of it.
    if (t.config && opts.takes?.setConfig) opts.takes.setConfig(cloneConfig(t.config))
    // The macro half has no older equivalent to route through — swapping the
    // base config IS its apply path, and it must land before the overrides so
    // they are measured against the config they will live in.
    if (macro) {
      const swap = t.changes.find(c => c.key === macro.key)
      if (swap) swapLiveBase(String(swap.value))
    }
    const built: ProposedChange[] = []
    for (const ch of t.changes) {
      if (macro && ch.key === macro.key) continue
      if (ch.value === opts.params[ch.key]) continue // skip no-ops, same as ask()
      original[ch.key] = opts.params[ch.key] as ParamValue
      built.push(changeFor(ch.key, ch.value, t.rationale))
    }
    changes.value = built
    recompute()
    logTake('keep', t)
    resetTakes()
    keep()
  }

  function dismissTakes() {
    if (!hasTakes.value) return
    restoreTakeOriginal()
    logTake('dismiss', selectedTake.value)
    resetTakes()
  }

  /** Abandoning an open strip — by retyping, or by closing the studio — must
   *  behave exactly like dismissing it. Anything less turns a hovered take into
   *  the new baseline, which is unrecoverable (the original is gone) and
   *  unrecorded (the pick log never sees the rejection). */
  function abandonTakes() {
    if (hasTakes.value) dismissTakes()
  }

  /** "↻ different directions" — a fresh ask, pushed away from what came back
   *  last time by naming those labels. */
  async function moreDirections() {
    if (busy.value || !opts.takes || !lastPhrase.value) return
    restoreTakeOriginal()
    // A composed strip re-rolls by composing again — falling back to the direct
    // path here would quietly hand the user a strip built the old way, from a
    // button that says the same thing.
    if (opts.takes.compose) {
      const avoid = takes.value.map(t => t.label)
      selectedTake.value = null
      busy.value = true; error.value = ''
      try {
        if (await composeAndPick(lastPhrase.value, avoid)) return
        console.info('[takes] compose re-roll failed — falling back to the direct path')
      } finally { busy.value = false }
    }
    // Drop the selection with the preview it was showing: if the re-roll fails
    // the old strip stays up, and a tile still ringed as "selected" over an
    // unapplied config would be lying about what the studio is showing.
    selectedTake.value = null
    busy.value = true; error.value = ''
    try {
      const avoid = takes.value.map(t => t.label).join(', ')
      const phrase = `${lastPhrase.value} — give ${TAKE_COUNT} DIFFERENT directions${avoid ? `, none of them a restatement of: ${avoid}` : ''}. (round ${++takeRound})`
      const reply = await requestTakes(takeControls(), opts.params, opts.label(), phrase, takeGuidance(), TAKE_COUNT)
      const finalized = finalizeTakes(reply)
      if (finalized.takes.length >= 2) openTakes(reply, finalized)
      else notice.value = 'No different directions came back — try rewording it.'
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      busy.value = false
    }
  }

  /** Visual self-review: render the result, let a multimodal model critique it,
   *  surface findings + append setParam fixes as fromReview changes. Best-effort. */
  async function runVisualReview(intent: string) {
    if (!opts.render || !opts.apiKey) return
    reviewing.value = true
    try {
      const image = await opts.render()
      if (!image) return
      const described = describeControls(opts.controls(), opts.params)
      const snapshot: SurfaceSnapshot = {
        surface: opts.label(),
        objects: [{ id: 'settings', label: 'Tunable settings', type: 'settings', current: { controls: described } }],
        commands: [{ op: 'setParam', hint: 'Tune one control toward a better result. target = a control key from settings; args: { value } within that control\'s range/options.' }],
      }
      const res = await $fetch<{ text: string }>('/api/agent-review', {
        method: 'POST',
        body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', prompt: buildReviewPrompt(snapshot, intent), schema: buildReviewSchema(snapshot.commands), image },
        timeout: 60_000,
      })
      const parsed = parseReviewResponse(res.text)
      if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
      const { assessment, issues: found, fixes, fixRationales } = parsed
      review.value = { assessment, issues: found }
      fixes.forEach((cmd, i) => {
        if (cmd.op !== 'setParam' || typeof cmd.target !== 'string') return
        const value = cmd.args?.value as ParamValue | undefined
        if (value === undefined) return
        const valid = validatePatch({ [cmd.target]: value }, described)
        const v = valid[cmd.target]
        if (v === undefined || v === opts.params[cmd.target]) return
        if (!(cmd.target in original)) original[cmd.target] = opts.params[cmd.target] as ParamValue
        const ch = changeFor(cmd.target, v, fixRationales[i] || 'Visual review fix')
        ch.fromReview = true
        changes.value = [...changes.value, ch]
      })
      recompute()
    } catch { /* review is best-effort */ }
    finally { reviewing.value = false }
  }

  /** Today's answer shape: one patch, shown as an accept/reject proposal. */
  function showProposal(patch: Record<string, ParamValue>, rationale: string, phrase: string) {
    const built: ProposedChange[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === opts.params[key]) continue // skip no-ops
      original[key] = opts.params[key] as ParamValue
      built.push(changeFor(key, value, rationale))
    }
    changes.value = built
    if (!built.length) notice.value = rationale || 'No changes for that request.'
    recompute()
    if (built.length) void runVisualReview(phrase) // fire-and-forget: proposal shows now, review catches up
  }

  async function ask(phrase: string) {
    const p = phrase.trim()
    if (!p || busy.value) return
    // BEFORE lastPhrase moves: an open strip is being abandoned, and it is the
    // OLD phrase that rejection belongs to.
    abandonTakes()
    busy.value = true; error.value = ''; notice.value = ''; review.value = null; lastPhrase.value = p
    clearOriginal()
    resetTakes()
    try {
      // Compose-and-pick first, where a studio has a menu to compose from. It
      // returns false for any failure and the old path runs untouched below.
      if (opts.takes?.compose && await composeAndPick(p)) return
      if (opts.takes) {
        let reply: VibeTakesReply | null = null
        try {
          reply = await requestTakes(takeControls(), opts.params, opts.label(), p, takeGuidance(), TAKE_COUNT)
        } catch (e) {
          // Only this server's own "I don't do takes" 400 is re-asked the
          // single-patch way; every other failure is the user's to see.
          if (!isVariantsUnsupported(e)) throw e
        }
        if (reply) {
          const finalized = finalizeTakes(reply)
          if (finalized.takes.length >= 2) { openTakes(reply, finalized); return }
          // One usable take, or the old single-patch shape: either way the answer
          // is already paid for — show it as today's proposal. A lone take's
          // macro cannot ride the proposal list (it is not a setParam), so it is
          // dropped here and counted like any other unapplicable key.
          const only = finalized.takes[0]
          const macroKey = opts.takes?.macro?.key
          const leaves = (only?.changes ?? []).filter(c => c.key !== macroKey)
          // A proposal list is setParam-only, so a lone take's whole-look macro
          // cannot ride it. That is a dropped key like any other and is counted
          // like one — dropping it quietly, under a rationale describing the
          // look it would have produced, IS the defect this seam exists to fix.
          const lostMacro = !!macroKey && leaves.length !== (only?.changes.length ?? 0)
          if (lostMacro) {
            console.warn(`[takes] only one usable take came back, so the whole-look change was dropped: ${macroKey}`)
          }
          const patch = reply.patch ?? Object.fromEntries(leaves.map(c => [c.key, c.value]))
          showProposal(patch, lostMacro ? '' : (reply.rationale ?? only?.rationale ?? ''), p)
          if (lostMacro) {
            notice.value = 'Only part of that could be applied: the overall style change needs the takes view, so just the adjustments were kept.'
          }
          return
        }
      }
      const { patch, rationale } = await requestPatch(opts.controls(), opts.params, opts.label(), p, opts.guidance?.())
      showProposal(patch, rationale, p)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      busy.value = false
    }
  }

  function acceptChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = true; recompute() } }
  function rejectChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = false; recompute() } }

  async function reroll(i: number) {
    const ch = changes.value[i]
    if (!ch || busy.value) return
    busy.value = true; error.value = ''
    try {
      const key = ch.command.target!
      const ctrl = opts.controls().find(c => c.key === key)
      const nonce = Math.random().toString(36).slice(2, 7)
      const phrase = `${lastPhrase.value ? `For "${lastPhrase.value}": ` : ''}give a DISTINCTLY DIFFERENT value for "${ctrl?.label ?? key}" (currently ${ch.after}) — not ${ch.after}. Change nothing else. (variation ${nonce})`
      const { patch } = await requestPatch(opts.controls(), opts.params, opts.label(), phrase, opts.guidance?.())
      if (key in patch && patch[key] !== undefined) {
        ch.command.args!.value = patch[key]
        ch.after = String(patch[key])
        recompute()
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      busy.value = false
    }
  }

  function keep() { changes.value = []; clearOriginal(); notice.value = ''; review.value = null } // accepted values already live
  function revert() {
    for (const [k, v] of Object.entries(original)) opts.params[k] = v
    changes.value = []; clearOriginal(); notice.value = ''; review.value = null
  }

  return {
    busy, error, notice, review, reviewing, changes, hasProposal, hovered, ask, acceptChange, rejectChange, reroll, keep, revert,
    // Four Takes
    takes, takeThumbs, takeCurrentThumb, takeDropped, takePromiseResults, takeVerdicts, reviewingTakes,
    selectedTake, hasTakes,
    previewTake, selectTake, keepTake, dismissTakes, abandonTakes, moreDirections,
  }
}
