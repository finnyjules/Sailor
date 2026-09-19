> **STATUS 2026-09-19: Phase 3 is COMPLETE**, including Slice 6b (legacy Motion authoring retired). This handoff is historical. Current state, decisions and what deliberately remains: `docs/superpowers/plans/2026-09-18-unified-motion-6b-retire-legacy.md` (see Non-goals) and the local ledger `.superpowers/sdd/progress-unified-motion.md`.

# Handoff — Unified Motion, Phase 3: the band timeline UI

**For a fresh session with zero prior context.** Goal: build the "everything is a band" motion timeline UI. The whole model underneath is already built, proven, and wired — this handoff is the last (and biggest) piece: the visual authoring surface.

## Start here (read in this order)
1. **Spec (the whole model + the refined UX):** `docs/superpowers/specs/2026-09-17-unified-motion-model-design.md` — read §5 "The authoring UI — everything is a band" carefully; that's what you're building.
2. **Ledger (task-by-task status + remaining):** `.superpowers/sdd/progress-unified-motion.md`.
3. **Mockups from the UX session** (open the files; they were served by a local companion): `.superpowers/brainstorm/51095-1789671177/content/` — `everything-is-a-band.html`, `inspector-states.html`, `popover-minimal.html`, `motion-tab-primary-flow.html`. Earlier gallery mocks in `.superpowers/brainstorm/9369-1789632904/content/`.

## What already works (built, reviewed, committed on `main`)
- **The core** `app/lib/motionx/` (Phase 1): `types.ts` (Ease/PropertyType/PropertyValue/Keyframe/Track/Timing/Behaviour/BehaviourTarget), `ease.ts`, `timing.ts`, `interpolate.ts` (typed number/colour/gradient over the landed `gradientTween`), `track.ts` (`evaluateTrack`), `evaluate.ts` (`evaluateTracks`), `behaviour.ts` (`compileBehaviour` + registry: fade/slide/gradientScroll/gradientMorph), `index.ts`. **Pure, zero compositor coupling.** Final review: Ready to merge.
- **The Frame adapter** `app/lib/motionx/adapter/frame.ts` (Phase 2 — the ONE Frame-coupled file): `applyResolvedValue`, `applyMotionxTracks` (the single fold), `frameTarget(layer)`, `animatableProperties(layer)`, `compileBehaviourForLayer(layer, behaviour)` (compiles + prefixes paths `layers.<id>.`).
- **The render is wired** (Phase 2): `useCompositorLayers.paintLayerStack` (~line 5470) folds `motion.motionx` (gated on presence → byte-identical when absent). The animated preview call in `CompositorModal.vue` (~line 4236) already passes `motionDoc.value` as the motion arg, so **any `motionx` stored on the doc animates automatically.**
- **A live author path** (Phase 3 so far): `FrameMotion.motionx` field (`app/lib/motion/types.ts`); a **temporary** "+ Add behaviour" trigger in `CompositorModal.vue` Motion tab (~line 7862, chips "Fade in" / "Scroll") + `addBehaviour(kind)` (~3665–3743) + `motionxTracks` computed. It calls `compileBehaviourForLayer(selectedLocal, behaviour)` and `setMotion({ motionx })`. **This proves the whole thing works live** and is the crude entry point the real UI replaces.
- Tests: `npm run test:unit -- motionx` = 33/33. Key commits: core `75a1a75b1..f7fd8784d`; adapter `9fc16380c`,`c0429ffde`,`46f1eec76`; render fold `c6a7f4232`; pipeline proof `0d539a037`; live author path `e05dbd99b`. UX spec `c87309a5e`.

## Verify it works (do this first)
- `cd frontend && npm run test:unit -- motionx` → 33/33.
- Live: reuse the running `:3002` dev server (NEVER `npm run dev` — it kills `:3002`). In a Frame with a gradient-filled rectangle: select it → **Motion** tab → **+ Add behaviour** → **Scroll** → ▶. The gradient should cycle via the new core.

## What to build (Phase 3, the band UI)
Replace the two current authoring surfaces — `CompositorMotionTimeline.vue` (the dial keyframe timeline) and `MotionLayerEditor.vue` (the In/Loop/Out preset panel) — with ONE band timeline. The model:
1. **Band timeline component.** Everything is a band. Behaviour = a labeled band. A property animation = a band whose **interior shows the value over time**: a fade **curve** (number), the **colour transition** (colour), the **morphing gradient A→B across its length** (gradient). **Control points live on the band.** Retime = drag band ends. Bands are the clean default; keyframe detail is opt-in via **Open**.
2. **Contextual inspector (right panel — decision A, NOT popovers for the rich stuff):** behaviour band → its params + "Open into keyframes"; property band → timing + an **easing/value curve editor**; control point → the full typed value editor (number field / colour picker / the full `GradientEditor`). Strong selection highlight + a header naming the selection.
3. **Minimal input popover on a control point:** just the input (a number field, or a colour swatch+hex) for quick tweaks; rich edits stay in the inspector.
4. **Previewing gallery** (replaces the temp chips + `MotionLayerEditor`): each tile plays a live preview; grouped **In / Loop / Out / Gradient**; **filtered to what the layer supports** (text-only moves hidden on a shape; Gradient only when the fill is a gradient). Wire clicks to `addBehaviour`/`compileBehaviourForLayer`.
5. **Port the ~40 kinetic presets** (`app/data/kinetic-presets.ts`) into behaviour compilers in `motionx/behaviour.ts` (register more kinds), with parity vs the old `app/lib/motion/evaluate.ts` `evaluateAnimation`. These become the gallery's In/Out/Loop entries.
6. **Behaviour param editing → recompile:** editing a behaviour's params in the inspector recompiles its tracks and re-stores via `setMotion({ motionx })`. **Open = bake:** convert a behaviour into editable control-point bands.
7. **Phase 4 (last):** retire the old models — the `applyEffectDialTracks`/`applyFillPhaseTracks` folds, `LayerKeyframe`, `MotionLayerEditor`, the In/Loop/Out `LayerAnimation` — once the band UI fully drives authoring.

## Facts a builder needs
- **Author = store `motionx` on the doc.** `setMotion({ motionx: Track[] })` (in `CompositorModal.vue`, ~3637). It flows to the already-wired fold. No render-call change needed.
- **Track shape (`~/lib/motionx`):** `Track { path, type:'number'|'color'|'gradient', keyframes:[{t,value,ease}], loop?, mode?:'crossfade'|'travel', space?:'oklab'|'hybrid' }`. Value types: number / hex string / `GradientStop[]` ({pos,color}). Paths: `layers.<id>.{x,y,rotation,scale,opacity | fill | fill.phase | effects.<fx>.<dial>}`.
- **Enumerate animatable props:** `animatableProperties(layer)` (adapter) → `{path,type,label}[]` (extend it as you add property lanes).
- **Gradient stop shapes:** colour-lib `{pos,color}` vs compositor fill `{offset,color}` — convert only via `app/lib/compositor/gradientPaint.ts` (`withGradientStops`/`withScrolledStops`/`paintStopsToColor`). The adapter already handles apply; the UI's gradient editors emit compositor `{offset,color}`.
- **Reuse `GradientEditor.vue`** (`app/components/vue-canvas/compositor/GradientEditor.vue`, v-model over `Gradient`) as the control-point gradient value editor.

## Rules (non-negotiable in this repo)
- **App stays working at every step.** Build the band UI alongside the old one; switch on only when complete; delete old models LAST (Phase 4).
- **Shared-file commits via PRIVATE GIT INDEX only.** `CompositorModal.vue`, `CompositorMotionTimeline.vue`, `useCompositorLayers.ts`, `effectDials.ts`, `effectTracks.ts`, `motion/types.ts` are all continually staged-deleted / `MM` by a parallel session. Commit only your hunks: `GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD; git add -- <file>; git commit -m "…" -- (or just commit); rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE`. NEW files → pathspec commit. Never `git add -A`/bare commit. See memory `private-git-index-fixes-shared-staging`.
- **Never run `npm run dev`** (kills `:3002`). Reuse the running server; verify in the browser pane.
- **UI copy:** sentence case; selects over internal values carry `optionLabels`. Motion authoring lives in the Motion tab/timeline, never inspector blocks (that's what this IS).
- Follow superpowers: brainstorming is done (spec approved) → writing-plans → subagent-driven-development. Suggested first slice: the band timeline component rendering existing `motionx` tracks read-only (from the doc), THEN interactions (add/retime/edit), THEN the gallery, THEN the preset port.

## Open UX bits still to decide in-context (minor)
Gallery invocation (panel vs modal), multi-layer timeline rows, transport/loop controls, empty state. Resolve against the running app.
