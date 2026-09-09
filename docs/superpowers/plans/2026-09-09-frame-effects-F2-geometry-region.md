# Frame Effects F2 — Geometry Region (trim · offset · round corners · roughen) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, task-by-task. Steps use `- [ ]`.

**Goal:** Add a geometry-effect region to the layer effect stack — effects that transform a vector layer's outline BEFORE it rasterises — and ship its first four kinds (trim path, offset path, round corners, roughen), each reordering only within the region and applying to rect, ellipse, path, library shape, polygon/star, and outlined text (F1).

**Architecture:** A pure `applyGeometry(d, effects, {W})` transforms an SVG `d` string; the effect stack gains a `geometry` region between the pinned `background_blur` and `dof`, with region-aware reorder/add. `paintLayer` gains a shared "render this layer from a computed outline `d`" path — the same hook F1 built for text — used whenever a geometry effect is present (and for text-with-outline): it takes `outlinePathData(layer)`, runs `applyGeometry`, and fills+strokes the resulting Path2D instead of the imperative rect/ellipse draw. A layer with no geometry effect is byte-identical. Geometry effects reuse the Frame's existing path toolkit (`pathFlatten.flattenPath`, `strokeShapes.offsetPolyline`/`resamplePolyline`, `morph.parsePathD`/`subpathsToD`) — paper.js 0.12.18 has no offset API, so offset uses the normal-based `offsetPolyline`.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Canvas 2D, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-frame-effects-programme.md` (slice F2), incl. the F1-recorded decoration gate.

## Global Constraints

- A layer with **no geometry effect** renders byte-identically to before F2 (real-canvas A/B when the paint path changes). Rect/ellipse keep their imperative draw unless a geometry effect (or F1 text-outline) forces the computed-`d` path.
- Geometry effects apply only to vector-backed layers (rect, ellipse, path, polygon, star, library shape, and outlined text). On image, wired and brush layers they are greyed in the add menu with a reason.
- **F1 decoration gate (decided in F1's review):** a text layer carrying underline/strikethrough or a distance-band stroke cannot render a full outline; when such a layer has a geometry effect, it renders `fillText` and the geometry effect is skipped, and the add menu greys geometry kinds for it with a title. No text renders a partial/wrong outline.
- Geometry effects reorder only among themselves (a `geometry` region); they never cross into the pixel region. `background_blur`/`dof`/`drop_shadow` stay pinned.
- `applyGeometry` is pure and cached by (`d`, JSON(geometry effects), W); deterministic (seeded roughen).
- UI copy sentence case, human names, never a stored kind string.
- `useCompositorLayers.ts`, `CompositorModal.vue`, `effectStack.ts`, `postEffects.ts` are shared with parallel sessions — stage own hunks by hunk (`git diff <file> > p; prune; git apply --cached p`), never `git add <file>` with foreign hunks; check `git log -3 --stat -- <file>` before committing.
- One dev server per checkout (`:3002`); never start another; no browser pane during Playwright. Avoid the stray `frontend/frontend_verify_tmp*.unit.spec.ts`. Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `frontend/app/lib/compositor/geometryEffects.ts` — kinds, defaults, `applyGeometry`, and the four transforms. Pure.
- Create `frontend/app/lib/vector/pathOps.ts` — `flatten(d)`, `resampleByLength(pts, step, closed)`, `toPathD(subpaths)`; thin wrappers over the existing engines so geometry effects share one toolkit. Pure.
- Modify `frontend/app/lib/compositor/effectStack.ts` — region model; region-aware `addEffect`/`canReorder`; the geometry kinds in `EFFECT_ORDER`.
- Modify `frontend/app/composables/useCompositorLayers.ts` — `applyGeometry` wired into the outline path; the shared computed-`d` render hook; `needsTextOutline` OR-in geometry; the decoration gate; silhouette-cache key.
- Modify `frontend/app/components/vue-canvas/CompositorModal.vue` — region captions in the row list; geometry-kind add-menu gating.
- Modify `frontend/app/lib/agent/surfaces/compositor.ts` — accept the new kinds.
- Tests: `frontend/tests/unit/compositor-geometry-effects.unit.spec.ts`, `frontend/tests/unit/vector-path-ops.unit.spec.ts`, extend `compositor-effect-stack.unit.spec.ts`, extend `frontend/tests/compositor-layer-effects.spec.ts`.

---

### Task 1: Region model in the effect stack (pure)

**Files:** Modify `effectStack.ts`; extend `tests/unit/compositor-effect-stack.unit.spec.ts`.

**Interfaces produced:**
- `GEOMETRY_KINDS` (the four: `trim`, `offset`, `round_corners`, `roughen`); they slot into `EFFECT_ORDER` between `dof` and `inner_shadow` — i.e. after the two backdrop/content pins, before the pixel region (a geometry effect runs on the outline BEFORE rasterise, which in list terms is after `background_blur`/`dof` and before the pixel passes). Confirm the exact index in the task; the invariant is: geometry kinds are contiguous and precede every pixel kind.
- `type EffectRegion = 'backdrop' | 'geometry' | 'pixel' | 'stamp'`; `regionOf(kind): EffectRegion` (`background_blur`→backdrop, `dof`→content/backdrop-adjacent — keep it in its own pinned slot, `drop_shadow`→stamp, the four geometry→geometry, everything else→pixel).
- `canReorder` gains `regionOf(from)===regionOf(to)` alongside the existing not-pinned checks.
- `addEffect`'s orderable branch inserts after the last entry **in the same region** (not the last orderable entry overall), or before the first entry of a later region.
- `isGeometryKind(kind): boolean`.

- [ ] Step 1: failing tests — `regionOf` for every kind; `addEffect('trim')` on a stack with a `bloom` lands the trim BEFORE bloom (geometry precedes pixel); a second `roughen` lands at the end of the geometry region, not after bloom; `canReorder` allows two geometry kinds to swap and REFUSES a geometry↔pixel swap; a pixel kind still lands in the pixel region as before (no regression — existing add/reorder tests still pass).
- [ ] Step 2: run, fail.
- [ ] Step 3: implement `regionOf`, `GEOMETRY_KINDS`, `isGeometryKind`, region-aware `addEffect`/`canReorder`. Keep `orderablePasses`/`rasterablePasses`/`splitTrailingBlurs` correct (geometry kinds are NOT pixel passes — they must be excluded from `orderablePasses`, which feeds `applyPasses`; add a guard so a geometry kind never reaches the pixel pass loop).
- [ ] Step 4: run, pass; run the whole existing effect-stack spec (no regression).
- [ ] Step 5: commit — `feat(frame): a geometry region in the layer effect stack`.

### Task 2: `pathOps` toolkit (pure)

**Files:** Create `frontend/app/lib/vector/pathOps.ts`; Test `tests/unit/vector-path-ops.unit.spec.ts`.

**Interfaces produced:**
- `flatten(d: string, tolerance?: number): { pts: {x:number;y:number}[]; closed: boolean }[]` — one entry per subpath, via `pathFlatten.flattenPath` (open+closed, tolerance-based).
- `resampleByLength(pts, closed, step): {x:number;y:number}[]` — via `strokeShapes.resamplePolyline`/`resampleStep`.
- `toPathD(subpaths: { pts; closed }[], precision?): string` — polylines → `d` (moveTo/lineTo/Z; reuse `morph.subpathsToD` if it accepts polylines, else a small serializer).
- `pathLength(pts, closed): number`, `cumulativeLengths(pts, closed): number[]` — arc-length helpers for trim.

- [ ] TDD: a square `d` flattens to 4+ points closed; `resampleByLength` at a step yields evenly spaced points whose count ≈ perimeter/step; `toPathD(flatten(d))` round-trips a polygon within tolerance; `pathLength` of a unit square ≈ 4. Commit — `feat(frame): shared path toolkit for geometry effects`.

### Task 3: `applyGeometry` with trim and roughen

**Files:** Create `frontend/app/lib/compositor/geometryEffects.ts`; Test `tests/unit/compositor-geometry-effects.unit.spec.ts`.

**Interfaces produced:**
- `GEOMETRY_KINDS`/labels/defaults; per-kind interfaces (`TrimEffect {start,end,offset}`, `RoughenEffect {amount,detail,seed}`, plus `OffsetEffect`/`RoundCornersEffect` filled in Task 4).
- `applyGeometry(d: string, effects: {type; ...}[], ctx: {W:number}): string` — applies each geometry effect in list order over the `d`, returning a new `d`; empty/none → returns `d` unchanged (identity, so the no-effect path is provably a no-op). Cached by (`d`, JSON(effects), W) with a small LRU.
- Trim: flatten → arc-length → keep the `[start,end]` fraction (with `offset` rotating the start), emit an OPEN polyline `d` (trim opens a closed path). Roughen: flatten → `resampleByLength(1/detail of perimeter)` → displace each point along its normal by `amount·W·seededNoise(i,seed)` → close.

- [ ] TDD: trim `{start:0,end:0.5}` of a square yields a path whose length ≈ half the perimeter; `offset` rotates which half; trim `{0,1}` ≈ the original outline. Roughen is deterministic per seed (two calls identical), a different seed differs, `amount:0` ≈ identity. `applyGeometry(d, [])` === `d`. Commit — `feat(frame): trim and roughen geometry effects`.

### Task 4: offset and round corners

**Files:** Modify `geometryEffects.ts`; extend its spec.
- Offset (distance, join): flatten → `strokeShapes.offsetPolyline(pts, closed, distance·W)` → `toPathD`; `join` maps to the miter behaviour offsetPolyline already has. Unit test: a rect offset outward grows its bbox by ~2·distance·W; inward shrinks.
- Round corners (radius): on the flattened polyline, replace each vertex with a quadratic/arc fillet of radius `min(radius·W, half the shorter adjacent edge)`; emit a `d` with curves (reuse `morph`'s cubic segs or Q commands). Unit test: a square with radius r has its corner vertices replaced by curves and its bbox unchanged; radius 0 ≈ identity. Commit — `feat(frame): offset and round-corners geometry effects`.

### Task 5: Wire into `paintLayer` — the shared computed-`d` render path + byte-identity

**Files:** Modify `useCompositorLayers.ts`; extend both the unit spec and `tests/compositor-layer-effects.spec.ts`.

**Interfaces produced:**
- `layerGeometryEffects(layer): EffectInstance[]` — the enabled geometry-region effects on a layer (via `effectStackOf` + `isGeometryKind`).
- `needsComputedOutline(layer)` — true when `needsTextOutline(layer)` (F1) OR `layerGeometryEffects(layer).length > 0` AND the layer is a vector kind that can produce an outline (rect/ellipse/path/polygon/star/library/text). For text carrying underline/strikethrough/distance-bands, returns FALSE (the F1 decoration gate) so geometry silently skips and the layer renders `fillText`.
- `computedOutlineD(layer, W)` = `applyGeometry(outlinePathData(layer, W), layerGeometryEffects(layer), {W})`.
- `paintLayer`: when `needsComputedOutline`, fill a `Path2D(computedOutlineD)` with the layer's paint and run the stroke stack over the same `d` — one code path shared by F1 text and F2 geometry, replacing the imperative rect/ellipse draw for that case only. Rect/ellipse/path/text with no geometry effect and no text-outline are byte-identical.
- Silhouette-cache key includes the geometry-effect list (a trimmed shape must not serve a cached full-shape raster).

- [ ] Step 1: unit — `computedOutlineD` returns a trimmed `d` for a rect with a trim effect; identity for a rect with none; a decorated text layer with a geometry effect returns null from `needsComputedOutline`. Playwright: seed a rect with a `round_corners` effect → the rendered corners differ from the sharp rect; seed with none → byte-identical to pre-F2 (capture with the flag path off vs the imperative path — assert identical); prove sensitivity (a real geometry effect differs).
- [ ] Steps 2–4: implement the shared hook (smallest change; reuse F1's Path2D fill/stroke seam), the cache key, the decoration gate; run.
- [ ] Step 5: commit — `feat(frame): render a layer through its geometry-transformed outline`.

### Task 6: Tree region captions, add-menu gating, geometry rows

**Files:** Modify `CompositorModal.vue`; extend `tests/compositor-layer-effects.spec.ts`.
- `flatRows` emits a `{kind:'region-caption', label}` when the region changes (a "Geometry" caption above the geometry rows, "Pixels" above the pixel rows); a template branch renders it (muted, non-interactive).
- `fxKindDisabled`: geometry kinds greyed on image/wired/brush layers, and on decorated/distance-band text, each with a `fxKindDisabledTitle` reason.
- Geometry effect rows tune their dials in the breadcrumb inspector (reuse the effect-row + `PostEffectsControls`-style dial rendering; geometry dials come from a `geometryControls(kind)` declaration mirroring `treatmentControls`).
- Playwright: add trim from the menu on a rect → a `trim` row under a "Geometry" caption, its dials in the inspector; drag two geometry effects to reorder (trim-then-roughen ≠ roughen-then-trim in pixels); a geometry kind is greyed on an image layer. Commit — `feat(frame): geometry effect rows, region captions, add-menu gating`.

### Task 7: Agent surface
- `setLayerEffect` accepts the four geometry kinds (they flow through the same stack write); the hint lists them; a unit test adds a geometry effect via the agent and it lands in the geometry region. Commit — `feat(frame): the agent can add geometry effects`.

### Task 8: Finish
- Full unit suite (report failing files not ours); typecheck delta on touched files; a whole-slice review package; update the build dashboard (read live first) and memory. Confirm the F1 decoration gate behaves in a real browser (decorated text + geometry effect → fillText, no wrong outline).

## Self-Review checklist
- No layer's pixels change without a geometry effect (Task 5 A/B).
- Geometry effects never reach the pixel pass loop (`orderablePasses` excludes them) (Task 1).
- Trim/offset/round/roughen each proven on rect, path, library shape and outlined text.
- Decorated text never renders a partial outline; geometry is skipped and the menu greys it (Tasks 5, 6).
- Region reorder is closed under the region; add lands in-region (Task 1).
