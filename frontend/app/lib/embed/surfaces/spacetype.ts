import type { EmbedSurface, EmbedHandle } from '../contract'
import { fontFaceRule, fontFaceId } from '../fontFace'
import { SpaceTypeEngine, type EngineOptions } from '~/lib/spacetype/engine'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects/index'
import { RAW_WORD_EFFECTS, type SpaceTypeEffect, type Params } from '~/lib/spacetype/effect'
import { separatorFromParams } from '~/lib/spacetype/separator'
import type { TextTextureOptions } from '~/lib/spacetype/textTexture'
import { buildRibbonLabel } from '~/lib/spacetype/ribbonMath'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { DEFAULT_POST } from '~/lib/spacetype/postSettings'
import type { PostSettings, SpaceTypeState } from '~~/shared/spacetype/state'

/**
 * Space Type is the first embed surface that draws TEXT and the first with
 * genuine transparency. Both properties shape this file:
 *
 *  - The font must be present in the DOCUMENT before the first render — canvas
 *    text falls back to sans-serif silently, not with an error, if the family
 *    named in `font` / `params.font` is not yet loaded. mount() is async
 *    exactly so this asset inflation can happen once, up front (see the font
 *    block below).
 *  - `caps.alpha: true` is genuine here (measured — see below), unlike
 *    shader/gradient which both declared `false` because they never produce
 *    a transparent pixel.
 */
export interface SpaceTypeEmbedConfig {
  effectId: string
  params: Params
  opts: Omit<EngineOptions, 'effect'>
  /** Seconds one pass lasts (loopDuration × loops — see spaceTypeEmbedDuration in
   *  ~/lib/spacetype/embedConfig). Present for parity with EmbedSnapshot.duration and the
   *  other two embed configs, but UNUSED here: engine.renderFrameAt takes t01
   *  directly (already normalized, already synchronous — see engine.ts's docstring),
   *  unlike GradientFxRenderer.render/composePasses which want seconds. */
  duration: number
  /** Pre-resolved custom font to inject, or null to use whatever family
   *  `params.font` names as-is (e.g. a generic/system family already present
   *  in the viewer's browser — nothing to inject or await). */
  font: { family: string; weight: number; dataUrl: string } | null
  /** Gradient-across-text stops — mirrors SpaceTypeState.gradientStops, folded
   *  into the text texture exactly as texOptsFromState does (see buildTexOpts).
   *  Optional/absent degrades to [] (gradient off), matching older configs
   *  saved before this field existed. */
  gradientStops?: SpaceTypeState['gradientStops']
  /** Post-processing (bloom / colour / chroma / lens blur) — mirrors
   *  SpaceTypeState.post. Optional/absent defaults to DEFAULT_POST (everything
   *  off) at mount(), preserving the pre-existing no-post-processing export
   *  behaviour for configs saved before this field existed. */
  post?: PostSettings
  /** Base loops one pass of the embed spans (the studio's seamless k). Absent = 1.
   *  setTime(t01) draws renderFrameAt(t01 * loops). */
  loops?: number
}

// Effects whose glyphs size to their own (uppercased or as-typed) word with NO
// trailing-gap pad, rather than the tiled-ribbon label. RAW_WORD_EFFECTS now
// comes straight from ~/lib/spacetype/effect.ts — that module is network-free
// (state.ts, which is NOT safe for this bundle, is what used to force the
// duplication; see effect.ts's own doc for the shared definition).

/**
 * Text-texture options for one embed frame. Mirrors texOptsFromState in
 * ~/lib/spacetype/state.ts (the studio's own builder) for every field, INCLUDING
 * font resolution and gradient stops — the two used to diverge from
 * texOptsFromState here, which is exactly the "looks plausible, is wrong"
 * failure this file exists to avoid:
 *
 *  - fontFamily/fontWeight: when the embed carries a pre-resolved `font`
 *    (family + weight, computed once by the export pipeline), that wins —
 *    trust the export-time resolution rather than re-deriving it. When
 *    `font` is null, this now calls the SAME resolveFontFamily/
 *    fontHasWeightAxis that texOptsFromState calls, and that 12 of the 25
 *    Space Type effects (cascade.ts, cylinder.ts, spiral.ts, ...) call
 *    independently to build their own per-glyph textures. Previously this
 *    function took `params.font`/`params.typeWeight` raw instead, so a
 *    config with `font: null` and a legacy id like 'inter' in params.font
 *    would resolve to 'Inter' inside those effects but pass the raw
 *    'inter' through here as a CSS family — not a real family name, so
 *    canvas silently fell back to sans-serif with no visible sign anything
 *    was wrong. `~/lib/font/resolveFamily` is safe to import here — unlike
 *    ~/data/google-fonts.ts (which this comment used to warn against
 *    importing, before commit 7fe308c9d), it holds only synchronous reads
 *    of a module-level cache: no `fetch`, no fonts.googleapis.com URL
 *    literals, so it carries none of the network dependency an embed bundle
 *    must never reach for. See its own header doc for the "why".
 *  - gradientStops/gradientOn now come from the embed config's own
 *    `gradientStops` field and `params.gradientMode` (see
 *    SpaceTypeEmbedConfig), rather than being hardcoded to [] / off.
 */
function buildTexOpts(
  effect: SpaceTypeEffect,
  params: Params,
  font: { family: string; weight: number } | null,
  gradientStops: SpaceTypeState['gradientStops'],
): TextTextureOptions {
  const family = font?.family ?? resolveFontFamily(String(params.font ?? 'Inter'))
  // Static families have no weight axis — pin to 400 so we don't faux-bold a
  // single cut, matching texOptsFromState. Only applies when `font` is null;
  // a pre-resolved `font.weight` from the export pipeline is trusted as-is.
  const weight = font?.weight ?? (fontHasWeightAxis(family) ? Number(params.typeWeight ?? 700) : 400)
  const multiAware = effect.controls.some(c => c.kind === 'textList')
  const rawTexts = String(params.text ?? '').split('\n').map(t => t.trim()).filter(Boolean)
  const texts = rawTexts.length ? rawTexts : ['']
  const rawWords = RAW_WORD_EFFECTS.has(effect.id)
  const asis = String(params.textCase ?? 'upper') === 'asis'
  const caseMode = asis ? 'as-typed' as const : 'upper' as const
  const cased = (t: string) => (asis ? t : t.toUpperCase())
  const labels = multiAware
    ? texts.map(t => (rawWords ? cased(t) : buildRibbonLabel(t, caseMode)))
    : [rawWords ? cased(texts[0] ?? '') : buildRibbonLabel(texts[0] ?? '', caseMode)]
  // Supersample the text atlas — see texOptsFromState's identical comment.
  const cpSS = texts.length <= 2 ? 5 : texts.length === 3 ? 4 : texts.length <= 5 ? 3 : 2
  const atlasSS = effect.id === 'cornerpin' ? cpSS : effect.id === 'slitscan' ? 3 : 2
  return {
    label: labels[0]!,
    labels,
    fontFamily: family,
    fontWeight: weight,
    axes: { wght: weight },
    typeColor: String(params.typeColor),
    fontSizePx: Number(params.typeYScale ?? params.typeHeight ?? 180) * atlasSS,
    heightPx: 256 * atlasSS,
    scaleX: Number(params.typeXScale ?? 1),
    tracking: Number(params.tracking),
    strokeColor: '#000000',
    strokeWidth: Number(params.typeStroke),
    gradientStops: gradientStops.map(g => ({ ...g })),
    gradientOn: String(params.gradientMode) === 'on',
    uRepeat: Number(params.textRepeat),
    separator: separatorFromParams(effect.id, params),
  }
}

// Exported for unit testing — buildTexOpts is pure (no DOM, no THREE, no
// engine instance), so its font-resolution and gradient-passthrough logic
// (the two correctness gaps this file's own history records) can be asserted
// directly without mounting a real WebGL engine. See
// tests/unit/embed-spacetype.unit.spec.ts.
export { buildTexOpts }

/**
 * Factory rather than a ready-made surface: a per-effect embed bundle must
 * mount from exactly one pre-supplied effect, never by searching the full
 * `SPACE_TYPE_EFFECTS` registry — that array statically imports all 25 effect
 * modules (the entire reason spacetype.js was 1.85MB), and the per-effect
 * Vite entry (see vite.embed.config.ts's virtual-module plugin) imports only
 * this function plus the ONE effect module it needs, passed in as a
 * single-element array. Nothing inside this function body references
 * `effects/index.ts` — only the default export below does, for the
 * long-standing "resolve by id against the full registry" callers (the
 * studio app's own surfaces.ts registry, and this file's existing unit
 * tests), and that reference is annotated /* @__PURE__ *\/ so a build that
 * never imports the default export (i.e. every per-effect bundle) can prove
 * it dead and drop it — see the default export below for why that's safe.
 *
 * The unknown-effectId throw here is what keeps a per-effect bundle honest:
 * passed a single-element array, `effects.find` still fails (and still
 * throws) the moment `cfg.effectId` names anything other than that one
 * effect — a per-effect bundle can never silently render the wrong effect
 * just because it was only ever built to hold one.
 */
export function createSpaceTypeEmbedSurface(effects: SpaceTypeEffect[]): EmbedSurface {
  return {
    kind: 'spacetype',
    // Measured, not assumed (mirrors the discipline in gradient.ts/shader.ts): the
    // renderer in engine.ts is ALWAYS constructed with `alpha: true`
    // (`new THREE.WebGLRenderer({ canvas, alpha: true, ... })`), and
    // applyBackground() — run on construction and again from setBackground() —
    // sets `scene.background = null` and clears to (0,0,0,0) whenever
    // `opts.alpha` is true, rather than hardcoding an opaque clear the way
    // GradientFxRenderer/ShaderFxRenderer's pipelines do. So when a config's
    // opts.alpha is true, the canvas Space Type hands back genuinely carries a
    // transparent background through to its pixels.
    caps: { alpha: true },

    async mount(container: HTMLElement, config: unknown): Promise<EmbedHandle> {
      const cfg = config as SpaceTypeEmbedConfig
      if (!cfg?.effectId) throw new Error('space type embed: config has no effectId')
      if (!cfg.opts) throw new Error('space type embed: config has no opts')

      // Throw on an unknown effectId rather than falling back to a default
      // effect (unlike getEffect() in effects/index.ts, which is deliberately
      // lenient for the live studio). A silently substituted effect renders
      // something plausible-looking that is simply the wrong export — worse
      // than a failed one, because nothing signals it happened.
      const lower = String(cfg.effectId).toLowerCase()
      const effect = effects.find(e => e.id.toLowerCase() === lower)
      if (!effect) {
        throw new Error(`space type embed: unknown effectId "${cfg.effectId}"`)
      }

      // Inject and await the font BEFORE the first render. Skipped only when
      // `font` is explicitly null (params.font already names a family the
      // viewer's browser provides natively). A failed font load rejects mount()
      // (after releasing the face below), never renders confidently in the
      // wrong typeface with no visible sign anything went wrong.
      //
      // The face is SHARED by id and COUNTED: a mount that finds its id already
      // present uses that style (the config builder names a face after its own
      // bytes — privateFontFamily in ~/lib/spacetype/embedConfig — so one id is
      // one face), and every mount releases its hold on destroy() or on a failed
      // mount. The last release removes the style, so a player mounted in the
      // app's own document (the in-app poster bake) leaves no face behind.
      const releaseFont = cfg.font ? holdFontFace(cfg.font) : () => {}
      let engine: SpaceTypeEngine | null = null
      const canvas = document.createElement('canvas')
      try {
        if (cfg.font) {
          await document.fonts.load(`${cfg.font.weight} 16px "${cfg.font.family}"`)
          await document.fonts.ready
        }

        // Own canvas + own engine instance, not a pooled/shared one — two Space
        // Type embeds on one page must not share a GL context (mirrors the
        // gradient/shader adapters' identical guard). Per-effect state lives on
        // root.userData (see engine.ts's build()), which is what makes two
        // concurrent engines safe.
        canvas.style.display = 'block'
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        engine = new SpaceTypeEngine(canvas, { ...cfg.opts, effect })
        // Absent `post` (older configs saved before this field existed) must
        // render exactly as before this fix — DEFAULT_POST is all-off, and
        // setPost is a no-op cost-wise when postEnabled() is false (see
        // engine.ts's setPost doc).
        engine.setPost(cfg.post ?? DEFAULT_POST)

        const texOpts = buildTexOpts(effect, cfg.params, cfg.font, cfg.gradientStops ?? [])
        engine.build(cfg.params, texOpts)

        container.appendChild(canvas)
        // Draw once at mount so the container is never empty before the first tick.
        engine.renderFrameAt(0, cfg.params)
      } catch (err) {
        canvas.remove()
        try { engine?.dispose() } catch { /* the mount has failed either way */ }
        releaseFont()
        throw err
      }
      const eng = engine

      // A seamless piece spans k base loops (the studio's loopMultiplier): one pass of the
      // embed runs t01 over [0, k), so every motion finishes whole cycles before the wrap —
      // the same span the studio's seamless video export and wired frame source cover.
      // Absent (every config saved before this field, and every non-seamless piece) = 1.
      const loops = Number(cfg.loops) >= 1 ? Number(cfg.loops) : 1

      let destroyed = false
      return {
        // renderFrameAt takes the base-loop position and is synchronous — no seconds
        // conversion, unlike the gradient/shader adapters' `t01 * duration`.
        setTime: (t01: number) => eng.renderFrameAt(t01 * loops, cfg.params),
        setSize: (nw: number, nh: number) => {
          eng.setSize(Math.max(1, Math.round(nw)), Math.max(1, Math.round(nh)))
        },
        destroy: () => {
          // Twice is once: a second destroy must not release another mount's hold on the face.
          if (destroyed) return
          destroyed = true
          canvas.remove()
          // Frees GPU resources AND force-loses the WebGL context (see
          // engine.dispose()'s doc) — browsers cap live contexts at ~16.
          try { eng.dispose() } finally { releaseFont() }
        },
      }
    },
  }
}

/** Injects `font`'s @font-face into the document (or joins the mount already holding it) and
 *  returns this mount's release. Holds are counted on the style element itself, so every copy
 *  of this adapter in one document — each nested bundle carries its own — shares one count. The
 *  last release removes the style. Exported for unit testing. */
export function holdFontFace(font: { family: string; weight: number; dataUrl: string }): () => void {
  const id = fontFaceId(font.family, font.weight)
  let styleEl = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-sailor-embed-font]')]
    .find(el => el.getAttribute('data-sailor-embed-font') === id) ?? null
  // A face under this id that no player holds (the Frame surface's own, which it removes itself)
  // is used as it is and never removed from here. With private names that only happens to a
  // config built before them.
  if (styleEl && styleEl.dataset.sailorEmbedFontHolds == null) return () => {}
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.setAttribute('data-sailor-embed-font', id)
    styleEl.textContent = fontFaceRule(font)
    document.head.appendChild(styleEl)
  }
  const el = styleEl
  el.dataset.sailorEmbedFontHolds = String(Number(el.dataset.sailorEmbedFontHolds ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = Number(el.dataset.sailorEmbedFontHolds ?? 1) - 1
    if (left > 0) el.dataset.sailorEmbedFontHolds = String(left)
    else el.remove()
  }
}

// Kept for the app-side registry (surfaces.ts, which dynamically imports this
// module and reads `.default` when the live Nuxt app itself needs to mount a
// Space Type piece — e.g. bakePoster() in export.ts — and can legitimately
// carry all 25 effects) and for this file's own pre-existing unit tests. The
// /* @__PURE__ */ annotation tells Rollup this call has no observable side
// effect, so a build graph that never imports `default` (every per-effect
// embed bundle) can prove the whole statement — and therefore its only
// reference to SPACE_TYPE_EFFECTS, and therefore all 25 effect modules — dead
// and drop it. Verified by measuring the built per-effect bundles, not just
// assumed: see tests/unit/embed-build-output.unit.spec.ts's spacetype-*
// ceiling and the build report for the actual sizes.
const spaceTypeEmbedSurface: EmbedSurface = /* @__PURE__ */ createSpaceTypeEmbedSurface(SPACE_TYPE_EFFECTS)

export default spaceTypeEmbedSurface
