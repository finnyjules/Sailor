# DialKit-style Frame Motion UI — design

**Date:** 2026-09-17
**Status:** Approved (brainstorm) — pending user review of this spec.
**Scope:** the **Frame** compositor's motion authoring UI (`CompositorModal.vue` Motion tab + `app/components/vue-canvas/compositor/Motion*`), building on the shipped band-UI (Phase 3 Slices 1–5). Emulates the timeline + curve-editor UX of **DialKit** (github.com/joshpuckett/dialkit, MIT), skinned entirely in Sailor's design tokens. NOT the NLE video timeline; NOT the standalone studios.

## Context — what already exists

Phase 3 Slices 1–5 (all on `main`, verified) delivered the "everything is a band" motion UI driven by the pure `motionx` core:
- `app/lib/motionx/` — types, ease, timing, interpolate, track/evaluate, `behaviour` registry (fade/slide/scale/spin/pulse/sway/float/gradientScroll/gradientMorph), `bands.ts` (band model), `bandEdit.ts` (pure track editors), `behaviourStore.ts` (behaviours-first-class), `gallery.ts` (previewing catalog). Adapter `adapter/frame.ts`. Whole suite 79/79.
- `MotionBandTimeline.vue` (bands + interactions + popover), `MotionInspector.vue` (contextual, right column), `MotionGallery.vue` (grouped previewing gallery). Wired in `CompositorModal.vue`; authoring persists via `setMotion({ motionx, behaviours })`; render path unchanged.
- Old surfaces still live alongside: `CompositorMotionTimeline.vue` (dial keyframe timeline + transport + Bake), `MotionLayerEditor.vue` (In/Loop/Out `LayerAnimation` presets), the `EffectDialTrack`/`motion.tracks` fold.

**motionx is and remains the source of truth.** DialKit is a developer *tuning* tool (code-config → tune → Copy-to-code, `productionEnabled:false` by default) with no persistence API we can use. So we **emulate its UX in our own Vue components**; we do not depend on the `dialkit` package.

## The problem

The band timeline works but is visually/interaction-thin next to DialKit: no ruler ticks, no zoom/pan, a basic 4-preset easing control, and a plain look. Two real feature gaps also block retiring the old surfaces: no way to author an **effect dial** (or any property) directly as a band, and the band timeline has **no transport** of its own (play/scrub/dur/fps/Bake live only on the old timeline).

## Design language — emulate DialKit geometry/gestures/math, skin in Sailor

**Keep from DialKit (dimensions, gestures, math — ported verbatim where math):**
- Row heights: clip/track row **28px**, group row **22px**, ruler row **28px**; lane `border-radius:8px`; clip bar inset `top/bottom:3px`, `border-radius:6px`; dock/popover `border-radius:14px`; label column **96px** (76px < 720px); dock `position:fixed; left/right/bottom:12`, `max-height: min(400px, 100vh-24)`, drag-resize handle.
- **time→x:** `pxPerSecond = laneWidth / (duration/zoom)`; `left=(at-viewStart)*pps`; `playheadX=clamp((time-viewStart)*pps,0,laneWidth)`.
- **Ruler ticks:** snap `rawStep=140/pps` up the ladder `[.001,.002,.005,.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,60,120,300,600]`; `fineStep=major/10`; `%10` skipped, `%5` medium (16px), else fine (8px); labels `formatClock` (mm:ss) or `toFixed(1..3)+"s"`.
- **Zoom/pan (component-local state, not a store):** alt-drag ruler = `zoom*exp(dx/180)` clamped `[1,maxZoom]`, pinning `anchorTime - anchorRatio*nextDuration`; `maxZoom=max(8,(140*duration)/(0.01*laneWidth))`; shift-drag = reset (`zoom=1,viewStart=0`) then scrub; wheel (deltaX or shift+deltaY) + a real sticky scrollbar row (inner width `laneWidth*zoom`) with a 0.5px-deadband two-way `scrollLeft↔viewStart` sync.
- **Gestures:** drag ruler/playhead/empty-lane = seek (`clamp` into visible range, pause-during-drag-resume-after); drag clip = move (`at += dx/pps`); drag clip edges/segment boundaries = retime; click clip/segment = select+edit; `DRAG_THRESHOLD_PX=3`.
- **Curve editor math (port verbatim from `easing-geometry.ts`/`easing-control.ts`):** `fitEasingGraph(ease,w,h)` (equal x/y scale, inverted-Y `project()`, `radiusY` fits overshoot); handles as `<button>` with pointer-down-frozen `scale`+`ratioX/Y`; `moveEasingHandle` X∈[0,1], Y∈[-1,2], `round2`; keyboard ±0.01 / shift ±0.1; path `M start C a,b,end`; `easingGuideEnd` shortens tangents; **no tabs, no preview dot** (a reference dashed line + 2 tangents + path + 2 endpoint dots + 2 handles). Source saved in scratchpad for reference.

**Replace with Sailor tokens (colors + font — never DialKit's):**
- Font **`PP Neue Montreal`** (`--font-sans`) everywhere; numerics use it with `tabular-nums` (NOT Geist Mono).
- Surfaces: compositor idiom already in use — `bg-[#1a1a1a]/95` / `#0e0e10`, `border-white/10`, text `white/70–85` / `white/40` muted.
- **Accent `#7c9cff`**; **behaviour bands emerald** (`rgba(120,220,170,…)`), **property bands** the current number/colour/gradient interiors; **selection ring `#7c9cff`** (NOT pure white); clips are NOT DialKit's flat `#E8E8E8` — they keep their value-showing interiors; playhead in Sailor accent/white.
- Reuse Sailor controls where they exist (StudioSlider/StudioColor/segmented idiom) over re-creating DialKit's.

## DialKit → motionx mapping

| DialKit concept | Our motionx representation |
|---|---|
| Clip (from→to) | a behaviour band, or a 2-keyframe property band |
| `steps` sequence (segments + boundaries) | a multi-keyframe number band; boundaries = control points |
| `props` track (composite bar → expand) | a behaviour's baked property bands, shown/expandable under it |
| Group (nested clips) | layer grouping on the timeline (per-layer rows already exist) |
| `transition.ease [x1,y1,x2,y2]` | the bézier `Ease` added to the motionx core (6c) |
| `computeClipStatic` pure resolver | our pure `bands.ts` (extend as needed) |
| Playback clock / seek / loop-fold | existing `previewT`/`play`/`pause`/`scrubTo` in `CompositorModal` |

## The programme (4 slices — build order 6d → 6a → 6c → 6b)

Each slice ships working software; the app stays working; old surfaces deleted LAST. Shared files (`CompositorModal.vue`, `CompositorMotionTimeline.vue`, `useCompositorLayers.ts`, `motion/types.ts`, `effectTracks.ts`, `effectDials.ts`) committed via PRIVATE GIT INDEX only.

### 6d — DialKit timeline look + gestures (FIRST)
Re-skin `MotionBandTimeline.vue` to DialKit's geometry, in Sailor tokens, and add the timeline canvas behaviors:
- **Ruler** with the tick ladder + labels; **playhead** with a Sailor-skinned flag (`time.toFixed(2)`), drag-to-seek.
- **Zoom/pan:** component-local `zoom`/`viewStart` + derived `pxPerSecond`/`visibleDuration`/`safeViewStart`; alt-drag pivot-zoom, shift-reset, wheel pan + sticky scrollbar row (all math above).
- **Clip/band rendering** at DialKit dimensions; **segments** for multi-keyframe number bands with boundary handles; **groups** as collapsible layer rows; selection ring `#7c9cff`.
- Extract the time↔x + tick + zoom math into a **pure `timelineView.ts`** (TDD): `pxPerSecond`, `clampViewStart`, `maxZoom`, `zoomAboutPivot(zoom,viewStart,dx,anchorRatio,anchorTime,duration,laneWidth)`, `computeTicks(step ladder)`. Transport CONTROLS stay on the old timeline this slice (both mounted); 6d owns the canvas + ruler-scrub only.
- Verify live: ruler ticks, drag-seek, alt-zoom pins cursor, pan, groups, Sailor skin; no console errors.

### 6a — Add property + transport
- Extend `animatableProperties(layer)` (adapter) to enumerate **Transform** (x/y/scale/rotation/opacity), **Fill** (gradient + scroll phase when gradient), **Effects** (every dial per effect — number/colour/gradient), each with `{path,type,label,group}` (reuse `effectDials`/`effectDialTargets`).
- **"Add property" picker** (peer of "Add behaviour") → grouped list → picking one seeds a **flat hold band** (2 keyframes `[0,duration]` = current value) as an untagged motionx track via `setBandTrack`, auto-selected. Pure helper `seedHoldTrack(path,type,value,duration)` (TDD).
- **Transport controls** onto the band timeline: play/pause/replay, duration/fps inputs, loop toggle, **Bake** button (+ stale/progress/error) — wired to the modal handlers the old timeline uses. After 6a the band timeline stands alone.
- Note (no guard, resolved by 6b): a dial could be double-authored via old `tracks` + new motionx band during coexistence — harmless (both fold).

### 6c — Bézier easing + curve editor
- **Core (pure, TDD, byte-identity preserved for named eases):** extend `Ease` in `motionx/types.ts` from the 4 named eases to also accept `['bezier',[x1,y1,x2,y2]]` (or a discriminated shape); implement in `ease.ts`/`interpolate.ts` via a cubic-bézier solver; the 4 presets map to their bézier tuples. Optional spring (`{bounce,duration}` → the `cubic-bezier(0.34,1.2+bounce,0.64,1)` display mapping) — bézier first, spring only if wanted.
- **UI:** a `MotionEasingCurve.vue` (ported `fitEasingGraph`/`moveEasingHandle`/`easingGuideEnd`, Sailor-skinned) in `MotionInspector`, replacing the 4-preset buttons for per-point "ease to next" and per-band easing; presets → custom.
- Verify live: editing a curve reshapes the band interior + the played motion.

### 6b — Retire old models
- Delete `MotionLayerEditor.vue`, `CompositorMotionTimeline.vue`, the `applyEffectDialTracks`/`applyFillPhaseTracks` folds, `EffectDialTrack`/`motion.tracks` and duplicate keyframe types — once 6d/6a/6c make the band UI a full replacement. Migrate any remaining In/Loop/Out authoring to behaviours; ensure Bake + effect-dial authoring exist in the band UI first. Private-index commits; careful, its own plan.

## Testing
- Pure/TDD backbone: `timelineView.ts` (px/zoom/tick math), `seedHoldTrack`, `animatableProperties` enumeration, the bézier `Ease` (endpoint fidelity + named-ease byte-identity), curve geometry (`fitEasingGraph`/`moveEasingHandle` parity with the ported formulas).
- UI verified live in the running `:3002` (never `npm run dev`): ruler/zoom/pan/gestures, add-property, transport, curve editing. Screenshots as proof.

## Scope boundaries / out of scope
- No dependency on the `dialkit` npm package; we emulate. No adoption of DialKit's config/Copy-to-code model.
- Springs are optional within 6c (bézier is the commitment).
- NLE timeline, standalone studios, and migration of legacy saved animations remain out of scope.
- DialKit's dark-glass palette + Geist Mono are explicitly NOT adopted; Sailor tokens only.

## Rules (repo)
- App works at every step; build alongside, retire last. Never `npm run dev` (kills `:3002`); verify in the browser pane; re-check ComfyUI after any restart. Shared-file commits via private git index; new files via pathspec. UI copy sentence-case; selects over internal values carry `optionLabels`. Attribution: `Co-Authored-By: Claude Opus 4.8`.
</content>
