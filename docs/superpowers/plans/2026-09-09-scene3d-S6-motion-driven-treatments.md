# Slice S6 · Motion-driven treatments (task-level plan)

> Part of the **3D Studio Treatments & Modifiers Programme**
> (`docs/superpowers/plans/2026-09-09-scene3d-treatments-programme.md`). Task-level plan for
> slice S6, written when the slice was reached, executed with
> superpowers:subagent-driven-development as S1–S5 were.
>
> **ATTRIBUTION — RESOLVED (controller, 2026-09-15).** The programme plan (line 17) says commits
> end `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; S1–S5 were driven by a Fable
> session and their commits sign Fable. **S6 is driven by an Opus 4.8 session**, whose F-cap
> commits this same session sign Opus 4.8, and whose standing attribution reminder says the model
> doing the work signs. **S6 commits therefore end:**
> `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Mixed trailers across the programme
> honestly record who executed each slice.
>
> **Doc location note:** the programme, spec and S1–S5 plans live at the **repo-root** `docs/`
> (`/Users/julien/Documents/GitHub/Sailor/docs/…`), NOT `frontend/docs/`. This plan lives at
> `docs/superpowers/plans/2026-09-09-scene3d-S6-motion-driven-treatments.md`. All code anchors
> below are under `frontend/` (the Nuxt app root).

**Base:** current `main` tip `cb02c8842` (verify with `git rev-parse HEAD` at implementation start).

**Goal:** two per-object **motion-driven treatments** — **velocity motion blur** and
**ghost trails / onion skin** — that read an object's on-screen motion and render it as a
directional smear or a fan of faded past copies, in the treatment stage. Added and tuned as
treatment tree rows exactly like every S1–S5 treatment (tree, add-menu, breadcrumb inspector,
agent and motion pick them up). Unlike masked/edge/buffer/finish families, these need to know
where the object *was* a moment ago, which the current motion system never produces.

---

## Controller ratification of Task 0 (2026-09-15) — ALL AS RECOMMENDED

The controller ratifies every Task-0 recommendation below **as written**:
1. **Two kinds** — `velocityBlur` + `ghostTrails` (not one moded kind). ✅
2. **New `MOTION_TREATMENT_KINDS` family** (mirrors S3's BUFFER precedent), not folded into masked. ✅
3. **Re-sample** velocity at `t`/`t−dt` via `evaluateObjectMotion` (dt = one frame). ✅
4. **Object-only velocity** (both samples through camera-at-`t`): an orbiting camera does not blur a static object. ✅
5. **Symmetric directional smear** reusing the existing separable-blur GLSL. ✅
6. **Dials** as specified — velocityBlur `amount`+`shutter`; ghostTrails `count`/`spacing`/`fade`. ✅
7. **v1 unparented objects only**; parented is a documented follow-up (silent degrade to zero motion, never misfire). ✅
8. **Add `__scene3dSnapshotAt(t01)` harness hook** — essential moving-frame oracle. ✅
9. **"Still" = smear `< 1` device px ⇒ hard no-op**, byte-identical to amount-0. ✅

---

## The crux (read first): how `t`/`dt` reach the stage

Verified against the code, this is the single hardest fact of the slice:

- Motion is **stateless** and applied **before** rendering, never inside the stage.
  `applyMotionToDoc(doc, t01)` (`app/lib/scene3d/motion/apply.ts:62`) deep-clones the doc and
  composes each object's `ObjectMotion` deltas onto its home transform
  (`obj.position += s.dPosition`, `obj.rotation += s.dRotation`, `obj.scale *= s.scaleMul`,
  lines 71-75), where `s = evaluateObjectMotion(obj.motion, tSec, duration)`
  (`motion/evaluate.ts:9`). Path-based `SceneMotionTrack`s **never** touch transform
  (`motion/types.ts:31-48` — transforms are `animatable:false`), so `evaluateObjectMotion` is
  the *complete* determinant of where an object sits at time `t`.
- The live loop (`Scene3DStudioSurface.vue:2098-2126`) and the export/video path
  (`Scene3DStudioSurface.vue:541` via `renderMotionFrame`, `motion/render.ts:48`) both do:
  `applyMotionToDoc` → `engine.syncFromDoc(sampled)` → `engine.applyCameraFromDoc(sampled)` →
  `engine.render()`. **By the time `engine.render` runs, the scene graph holds the object at its
  `t`-pose and the doc/`t01`/motion are gone** — `engine.lastDoc` is the *sampled* doc.
- `TreatmentStage.render(scene, camera, plan, bufferPlan, ctx)`
  (`treatmentStage.ts:1634`) is therefore **completely stateless per frame**: it only sees the
  current pose. `StageContext` today is just `{ objectRoots }` (`treatmentStage.ts:59`).

**Consequence / chosen approach:** velocity and ghost poses must be computed **at the seam that
still holds the original doc + `t01`** (the live loop and `renderMotionFrame`), using
`evaluateObjectMotion` at `t` and `t − dt` (cheap — no doc clone), then pushed into the engine
and threaded through `StageContext` into the stage. The stage stays a dumb consumer of a
per-object velocity vector and a per-object list of past poses. This matches the programme's
literal wording ("sample motion at `t` and `t − dt`") and is deterministic and bake-safe (a
re-sample gives the same velocity for a given `t` regardless of frame history, so the exported
video's blur is reproducible).

---

## Task 0 · Decisions (RATIFIED — see ratification block above; rationale retained)

1. **Two kinds or one with a mode?** → **TWO kinds**: `velocityBlur` and `ghostTrails`. They have
   disjoint dials and disjoint render mechanisms (a directional filter of one layer vs. N extra
   geometry draws). One-with-a-mode would force a union of unused dials and a branch in every seam.
   Matches the programme's two separate S6 bullets.

2. **New treatment family, or fold into `masked`?** → a **NEW family**
   `MOTION_TREATMENT_KINDS = ['velocityBlur','ghostTrails']`, mirroring how S3 added
   `BUFFER_TREATMENT_KINDS` with its own `bufferTreatmentPlan` + its own stage sub-loop.
   Rationale: (a) `ghostTrails` cannot fit the masked single-layer `treatAndComposite` path — it
   needs scene/camera/root to re-draw at past poses; (b) the masked family auto-appends an
   "Everything else" `invert` row (`treatmentControls.ts:222`), which is meaningless for both
   kinds — a new non-masked family suppresses it cleanly; (c) it gives a clean byte-identity gate
   (`motionTreatmentPlan(doc).length === 0 ⇒ stage untouched`) identical in shape to the S3
   buffer gate. Cost: velocityBlur cannot compose in one chain with a stacked masked blur/grade
   on the same object (each family draws the object alone separately, painter-composited — the
   same pre-existing limitation buffer treatments have). Noted as a follow-up.

3. **Velocity source: re-sample vs temporal history.** → **re-sample** at `t` and `t − dt` via
   `evaluateObjectMotion` (per the spec). `dt` = one frame: `dt01 = 1/(fps·duration)`
   (guard `fps·duration > 0`, else fallback `1/120`). Deterministic and bake-safe; a
   temporal-history diff would give a different `dt` under a stuttering rAF and a different smear
   in export vs. playback.

4. **Does camera motion blur a static object?** → **object-only velocity**: project both samples
   (`t`, `t − dt`) through the **camera-at-`t`** view-projection, so "still" means *the object
   isn't moving in the world*; an orbiting camera does **not** smear a static object. Keeps the
   "none when still" Playwright assertion clean. (Screen-true velocity, each sample through its own
   sampled camera, is a follow-up if camera-blur is wanted.)

5. **Blur shape.** → a **symmetric directional smear** reusing the existing separable blur
   mechanism (`BLUR_FRAG` / `blurMat` / `blurPasses`, `treatmentStage.ts:46,71,1146,~366`) run
   along the velocity direction only (skip the perpendicular pass). Lowest-risk, reuses proven
   GLSL. A backward-only (trailing) box is a follow-up.

6. **Dials.** velocityBlur → `amount` (0..3, strength multiplier on smear length) + `shutter`
   (0..1, fraction of a frame's motion captured, default 0.5). ghostTrails → `count`
   (1..8 int, default 3), `spacing` (1..12 frames between ghosts, default 2), `fade` (0..1
   per-ghost alpha falloff, default 0.5).

7. **Parented objects.** → **v1 supports unparented objects only** (world pose = home∘motion
   local, which `evaluateObjectMotion` gives directly). Parented-object velocity/ghosts (compose
   the animated parent chain) is a documented follow-up. **Velocity/ghosts silently degrade to
   zero motion for a parented object rather than misfiring.**

8. **Test harness gap.** The existing hooks (`__scene3dSnapshot`, `__scene3dBeauty`,
   `Scene3DStudioSurface.vue:1997-1998`) render **at `t=0` only** (still). A motion-blur test
   needs a *moving* frame captured deterministically. → **add** `window.__scene3dSnapshotAt(t01)`
   that runs the full sample→velocity→ghost→render→toDataURL path at an arbitrary `t01` (Task 1).

9. **"Still" epsilon.** → smear length `< 1` device px ⇒ velocityBlur is a **hard no-op**
   (return src unchanged, `haloPx 0`), byte-identical to the same treatment at `amount 0`.
   Ghosts: an object whose N past poses are all within `< 1` px of the current pose draws no ghosts.

---

## Global constraints (from the programme; bind every task)

- **Byte-identical when absent.** An object with none of the S6 kinds renders byte-for-byte as
  before, proven by (a) `parseTreatments` round-trip identity (a doc without the kinds
  `serializeDoc→parseDoc` unchanged) and (b) a real-canvas A/B on `/dev/scene3d-lab` (data-URL
  `.toBe()` equal — the exact pattern `tests/scene3d-finishes.spec.ts:84-93` uses). Run RED first
  against a stub that forces the motion stage on unconditionally.
- Dials are motion targets and agent controls by stable id via `iterateTreatmentControls`, which
  is **fully derived** from `treatmentControls(kind)` (`agentControls.ts:116`, consumed by
  `motion/targets.ts:78-86`) — so **no per-kind agent edit** and **no colour whitelist** (S4/S5
  lesson). A new numeric dial is a motion target automatically.
- UI copy sentence case, human names, no dead controls; **layer bits 29–31 reserved** (the motion
  family adds **no** new layer bits — it reuses the existing `STAGE_LAYER` via `drawAlone`).
- One dev server per checkout; verify through `/dev/scene3d-lab?state=` and the `__scene3d*`
  hooks. **A hidden browser pane pauses the scene3d rAF** (blank snapshot, `groups:0`), so the
  live oracle is **headless Playwright with the pane visible**, not an in-pane manual snapshot
  (S4/S5 lesson). **NEVER run `npm run dev`** in a subagent (kills the shared :3002 / ComfyUI
  :8188). The Playwright harness spins its own preview (`PW_BASE_URL=http://127.0.0.1:<port>`).
- Shared scene3d files (`treatmentStage.ts`, `engine.ts`, `Scene3DStudioSurface.vue`) are staged
  **by hunk** — own hunks only, never `git add -A`, never `git stash` (a concurrent session's
  foreign hunks may live in this checkout). Commits are made by the CONTROLLER, not the subagent.

## The GPU lessons S4/S5 recorded (bind every shader/stage task)

- **Never interpolate a JS number into a GLSL float context without a decimal.** `${X}` where X
  is `3.0` stringifies to `"3"`; `6.28/3` is a float÷int ANGLE (Chromium) rejects at compile — the
  program silently never links. Emit float literals (`X.toFixed(7)`); ship a source-guard unit
  that greps the built shader for a bare-int operand (as S4/S5 did). *This slice adds little raw
  GLSL* (velocityBlur reuses `BLUR_FRAG`), but any new snippet obeys this.
- **CPU twins pass over broken GPU shaders** (S4: GLSL float÷int; S5: HDR-lum pivot). Every
  visual task ships a CPU twin for its math **and** a live Playwright case (applied-changes-render
  + absent-byte-identity). The Playwright gate runs **before** closeout.
- The stage accumulator is **premultiplied, linear-HDR** until the final `UNPREMUL` + OutputPass
  (`treatmentStage.ts:12,1740-1745`). Any new composite writes premultiplied "over" like the
  existing `composite()` (`treatmentStage.ts:1405-1428`). Sampled textures are `NoColorSpace`.

---

## Interfaces produced

### `app/lib/scene3d/treatments.ts` (three-free, Vue-free — keep it so)
- `export const MOTION_TREATMENT_KINDS = ['velocityBlur','ghostTrails'] as const` — the **fifth**
  family, added beside `MASKED`/`EDGE`/`BUFFER`/`FINISH` (near line 30).
- `TREATMENT_KINDS = [...MASKED, ...EDGE, ...BUFFER, ...FINISH_TREATMENT_KINDS, ...MOTION_TREATMENT_KINDS]`
  (append at line 31).
- `type MotionTreatmentKind = typeof MOTION_TREATMENT_KINDS[number]`; fold into `TreatmentKind`
  (line 36).
- `isMotionKind(kind): kind is MotionTreatmentKind` beside the other `is*Kind` guards
  (lines 340-355).
- Per-kind interfaces extending `TreatmentBase` (NOT `RampFields` — motion kinds are not ramped,
  matching finishes), added to the `Treatment` union (line 255) and a new
  `type MotionTreatment = VelocityBlurTreatment | GhostTrailsTreatment` (mirroring
  `FinishTreatment`, line 264):
  ```ts
  export interface VelocityBlurTreatment extends TreatmentBase {
    kind: 'velocityBlur'; amount: number; shutter: number
  }
  export interface GhostTrailsTreatment extends TreatmentBase {
    kind: 'ghostTrails'; count: number; spacing: number; fade: number
  }
  ```
- `TREATMENT_LABELS` (line 40, **total Record — a missing key is TS2739**): add
  `velocityBlur: 'Velocity blur', ghostTrails: 'Ghost trails'`.
- `TREATMENT_DEFAULTS` (line 268): `velocityBlur: { amount: 1, shutter: 0.5 }`,
  `ghostTrails: { count: 3, spacing: 2, fade: 0.5 }`.
- `parseTreatment` (line 408): a `case` per kind with clamps —
  `velocityBlur`: `amount: clampTo(num(...), VELOCITY_BLUR_AMOUNT_MAX)`, `shutter: clamp01(...)`;
  `ghostTrails`: `count: round-clamp [1, GHOST_COUNT_MAX]`, `spacing: clamp [1, GHOST_SPACING_MAX]`,
  `fade: clamp01(...)`. Add the shared bound consts (`VELOCITY_BLUR_AMOUNT_MAX = 3`,
  `GHOST_COUNT_MAX = 8`, `GHOST_SPACING_MAX = 12`) beside the existing per-kind maxima
  (lines 318-338) so dial and parser can't drift.
- `export interface MotionGroup { objectId: string; treatments: Treatment[] }` and
  `export function motionTreatmentPlan(doc: SceneDoc): MotionGroup[]` — a near-verbatim copy of
  `bufferTreatmentPlan` (lines 592-601): one group per visible host object carrying an enabled
  motion treatment, in tree order, capped at `TREATED_OBJECT_CAP`. **Empty ⇒ the motion stage
  never runs ⇒ byte-identical.** Add `docHasMotionTreatment(doc)` mirroring
  `docHasGBufferTreatment` (line 605) for the engine gate.
- `isTreatmentHost` already admits `primitive` + `glb` (line 360) — motion kinds inherit that;
  no new host predicate needed.

### `app/lib/scene3d/motion/velocity.ts` (NEW — may import three's `Matrix4`/`Vector3`)
The single home of the "sample twice, project to screen" math. Pure and unit-testable (inject the
view-projection as a `Matrix4`, no WebGL).
```ts
export interface ScreenVelocity { x: number; y: number } // NDC delta per frame (dt)
// One helper both live loop and renderMotionFrame call.
export function sceneScreenVelocities(
  doc: SceneDoc, t01: number, viewProj: THREE.Matrix4,
): Map<string, ScreenVelocity>
```
- Early-out empty when `!sceneHasMotion(doc)` (`motion/render.ts:5`) or no object carries an
  enabled `velocityBlur`/`ghostTrails` (use `motionTreatmentPlan(doc)` to restrict the work to
  objects that actually need it).
- `dur = doc.motion.duration; fps = doc.motion.fps; dt01 = (fps*dur>0) ? 1/(fps*dur) : 1/120`.
- `prev01 = doc.motion.loop ? ((t01 - dt01) % 1 + 1) % 1 : Math.max(0, t01 - dt01)`.
- For each relevant object: `pNow = homePos + evaluateObjectMotion(obj.motion, t01*dur, dur).dPosition`;
  `pPrev = homePos + evaluateObjectMotion(obj.motion, prev01*dur, dur).dPosition` (Vector3s).
  Project **both through the same `viewProj`** (camera-at-`t`): `ndc = p.clone().applyMatrix4(viewProj)`
  (perspective divide is done by `applyMatrix4` on a `Vector3`). `v = { x: ndcNow.x - ndcPrev.x,
  y: ndcNow.y - ndcPrev.y }`. Store only when `|v| > 0`.
- `export function ghostLocalPoses(obj, doc, t01, count, spacingFrames): {position;rotation;scale}[]`
  — for `k = 1..count`, sample `evaluateObjectMotion` at `t01 - k·spacingFrames·dt01` (wrapped like
  above) and compose onto the home transform exactly as `apply.ts:71-75` does. Returns local TRS
  poses oldest-last (or oldest-first — document the order the stage expects). Skip a pose within
  `<` sub-pixel of the current pose.

Both reuse `evaluateObjectMotion` (`motion/evaluate.ts:9`) — the *same* function live sampling
uses, so poses are consistent with the rendered frame. NOTE for parenting (Decision 7): `homePos`
is the object's local home; for an unparented object local == world. A parented object's world
requires composing the animated parent chain — v1 skips it (returns the local delta, which for a
parented object is still a valid *object-space* velocity; document that on-screen accuracy is only
guaranteed for unparented objects).

### `app/lib/scene3d/engine.ts`
- `private motionVelocities = new Map<string, ScreenVelocity>()` and
  `private ghostPoses = new Map<string, LocalPose[]>()`, with
  `setMotionVelocities(m)` / `setGhostPoses(m)` setters (near `objectRoots`, line 566). Both
  default empty ⇒ an ordinary scene pays nothing.
- `renderWithPost` (line 1454): after the existing plans (lines 1458-1464) add
  `const motionPlan = this.lastDoc ? motionTreatmentPlan(this.lastDoc) : []` and extend the gate
  `const runStage = stageGroups > 0 || bufferPlan.length > 0 || motionPlan.length > 0`. Pass the
  new inputs into the stage: `this.treatmentStage.render(scene, camera, plan, bufferPlan,
  motionPlan, { objectRoots: this.objectRoots, velocities: this.motionVelocities, ghosts: this.ghostPoses })`
  (line 1485). **Byte-identity:** when `motionPlan` is empty and the maps are empty, `runStage`
  and every downstream branch are unchanged from pre-S6.
- Import `motionTreatmentPlan` alongside the existing plan imports (line 33).

### `app/lib/scene3d/treatmentStage.ts`
- `StageContext` (line 59) grows to
  `{ objectRoots: Map<string, THREE.Object3D>; velocities?: Map<string, ScreenVelocity>; ghosts?: Map<string, LocalPose[]> }`
  (optional so existing call sites and tests compile; the stage treats absent as empty).
- `render()` (line 1634) gains a `motionPlan: MotionGroup[]` param (after `bufferPlan`). Compute
  `const motionGroups = motionPlan.filter(g => ctx.objectRoots.has(g.objectId))` and
  `motionRoots = motionGroups.map(...)`. **Extend the base-hide set** so motion-family objects are
  hidden from the base pass exactly like masked ones: at the non-invert base pass (line 1684) and
  wherever `treatedRoots` is used as the drawAlone exclude, use `[...treatedRoots, ...motionRoots]`.
  Add a **loop 2d** after the buffer loop (after line 1739), before the un-premultiply (line 1740):
  ```
  for (const g of motionGroups) {
    const root = ctx.objectRoots.get(g.objectId)!
    const exclude = [...treatedRoots, ...bufRoots, ...motionRoots]
    for (const t of g.treatments) {
      if (t.kind === 'velocityBlur') this.velocityBlurComposite(scene, camera, root, exclude, t, ctx.velocities?.get(g.objectId) ?? null)
      else if (t.kind === 'ghostTrails') this.ghostTrailsComposite(scene, camera, root, exclude, t, ctx.ghosts?.get(g.objectId) ?? [])
    }
  }
  ```
- `stats.groups` (line 1755) += `motionGroups.length`.
- Two new private methods (Tasks 2 & 3) + reuse of `drawAlone` (line 1372), `blur`/`blurPasses`
  (1146/71), `composite` (1405), `this.layer` and `this.free()` scratch pool.
- **No new material to dispose** for velocityBlur (reuses `blurMat`); ghostTrails also reuses
  `blurMat`/`composite` — no `dispose()` list change (line 1761) unless a dedicated velocity frag
  is chosen over reuse.

### `app/lib/scene3d/treatmentControls.ts`
- `treatmentControls(kind)` (line 50): a `case` per kind. **These are NOT masked**, so the trailing
  `invert` row (`isMaskedKind` guard, line 222) is correctly not appended.
  ```
  case 'velocityBlur': rows = [
    slider(g,'amount','Amount',0,VELOCITY_BLUR_AMOUNT_MAX,0.01,D.velocityBlur.amount,'How strong the motion smear is'),
    slider(g,'shutter','Shutter',0,1,0.01,D.velocityBlur.shutter,'How much of the movement each frame captures'),
  ]; break
  case 'ghostTrails': rows = [
    slider(g,'count','Trails',1,GHOST_COUNT_MAX,1,D.ghostTrails.count,'How many faded copies trail behind'),
    slider(g,'spacing','Spacing',1,GHOST_SPACING_MAX,1,D.ghostTrails.spacing,'How far apart the copies are, in frames'),
    slider(g,'fade','Fade',0,1,0.01,D.ghostTrails.fade,'How quickly the copies fade out'),
  ]; break
  ```
  Import the new bound consts at line 6.

### `app/components/vue-canvas/studio/Scene3DTreatmentRow.vue`
- `TREATMENT_ICONS` (line 6, **the ONE total-`Record<TreatmentKind, Component>` guard — a missing
  key is a TS2739 compile error**): add `velocityBlur` and `ghostTrails`. Pick lucide icons NOT
  already used in the map (line 3): `Ghost` is taken by `fade`, `Wind` by `dissolve`. Recommend
  `velocityBlur: Gauge` (or `FastForward`) and `ghostTrails: Footprints` (or `History`). Add the
  imports to line 3.

### `app/components/vue-canvas/Scene3DStudioSurface.vue`
- **Live loop** (lines 2098-2126): after `engine.applyCameraFromDoc(sampled)` (line 2123) and
  before `engine.render(...)` (line 2126), compute and push velocity/ghosts when the doc has a
  motion treatment:
  ```
  if (docHasMotionTreatment(doc)) {
    const viewProj = new THREE.Matrix4().multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse)
    engine.setMotionVelocities(sceneScreenVelocities(doc, t01, viewProj))
    engine.setGhostPoses(collectGhostPoses(doc, t01)) // per-object ghostLocalPoses for ghostTrails hosts
  } else { engine.setMotionVelocities(EMPTY); engine.setGhostPoses(EMPTY) }
  ```
  In the **not-playing** branch (lines 2128-2133) clear both maps → a paused frame is still →
  velocityBlur no-ops → "none when still" holds for a paused clip.
- **`renderMotionFrame`** (`motion/render.ts:48`): the same three lines after `applyCameraFromDoc`
  (line 51), before `engine.render()` (line 55) — so **export video** (`Scene3DStudioSurface.vue:541`),
  node-card thumbnails and any headless caller get blur/ghosts for free. This is why the math lives
  in `motion/velocity.ts`, imported by both seams.
- **New test hook** (Decision 8) in the `onMounted` hook block (line 1986-1999):
  `window.__scene3dSnapshotAt = (t01: number) => { <sample doc at t01, syncFromDoc, applyCameraFromDoc, set velocities+ghosts, engine.render(), return canvas.toDataURL('image/png')> }`.
  This is `renderMotionFrame` + `snapshot()` inlined so a Playwright test gets a deterministic
  moving frame without racing the playhead. Add its key to the `onBeforeUnmount` cleanup list
  (line 2001).

---

## Tasks

### Task 1 · The motion family + velocity/ghost sampling + engine & stage plumbing (no visual effect yet)
The scaffold that makes `t`/`dt` reach the stage — the crux, landed first and provable in
isolation.
- `treatments.ts`: `MOTION_TREATMENT_KINDS`, append to `TREATMENT_KINDS`, `MotionTreatmentKind`,
  `isMotionKind`, both interfaces + `MotionTreatment` union, `TREATMENT_LABELS` (both),
  `TREATMENT_DEFAULTS` (both), `parseTreatment` cases + bound consts, `MotionGroup`,
  `motionTreatmentPlan`, `docHasMotionTreatment`.
- `motion/velocity.ts` (new): `sceneScreenVelocities`, `ghostLocalPoses`, `collectGhostPoses`,
  `ScreenVelocity` + `LocalPose` types, CPU twin exports.
- `engine.ts`: the two maps + setters; `motionTreatmentPlan` in `renderWithPost`; extend the gate;
  thread `motionPlan` + `velocities` + `ghosts` into `stage.render`.
- `treatmentStage.ts`: `StageContext` fields; `render()` new param; `motionGroups`/`motionRoots`;
  extend base-hide; **empty loop 2d** (methods stubbed to no-op this task); `stats.groups`.
- `treatmentControls.ts` cases; `Scene3DTreatmentRow.vue` icons (both — total-Record forces both at
  once); surface loop + `renderMotionFrame` wiring; `__scene3dSnapshotAt` hook.
- **Tests (RED first):**
  - Unit `tests/unit/scene3d-motion-velocity.unit.spec.ts`: `sceneScreenVelocities` on a synthetic
    doc — an object with a `spin`/`bob`/`move`-in `ObjectMotion` returns a non-zero NDC vector at a
    moving `t01` and a **zero/absent** vector for a still object (no motion) or at a motion apex;
    `ghostLocalPoses` returns `count` distinct poses spaced by `spacing` frames. Inject a fixed
    `Matrix4` viewProj (no WebGL).
  - Unit extend `tests/unit/scene3d-treatments.unit.spec.ts`: `parseTreatment` round-trips both
    kinds with clamps; `motionTreatmentPlan` empty ⇒ byte-identity gate; unknown-field backfill.
  - Unit `tests/unit/scene3d-motion-targets.unit.spec.ts` (extend): both kinds' sliders appear in
    `animatableTargets` by `objects.<id>.treatments.<tid>.<field>` (agent/motion derivation, no
    per-kind edit).
  - **Byte-identity Playwright** (`tests/scene3d-motion.spec.ts`, first case): a sphere with no
    motion treatment snapshots identical before/after (data-URL `.toBe`) — done by comparing a
    plain sphere against the same sphere with a `disabled` velocityBlur row (the finishes-spec
    pattern, `scene3d-finishes.spec.ts:155-164`). Proves the gate.
- **Acceptance:** the two kinds appear in the tree/add-menu/inspector; `__scene3dTreatmentStats`
  still `groups:0`/`frames` unchanged for a scene without them; typecheck at baseline; no visual
  change yet.

### Task 2 · Velocity motion blur in the stage
- `treatmentStage.ts` `velocityBlurComposite(scene, camera, root, exclude, t, v: ScreenVelocity | null)`:
  1. `if (!v) return;` compute `lenPx = 0.5 * hypot(v.x * this.width, v.y * this.height) * t.shutter * t.amount`
     (NDC→device px; the `0.5` maps NDC's [-1,1] span to pixels). **`if (lenPx < 1) { draw the
     object once and composite unblurred — OR skip entirely so it matches amount-0 } `** (Decision
     9 — the "still" hard no-op; choose the branch that makes still-velocityBlur byte-identical to
     amount-0-velocityBlur: both draw the object alone + composite with no blur).
  2. `drawAlone(scene, camera, root, exclude, this.layer, null)` — the lit object alone (reuses
     line 1372).
  3. Directional blur: reuse `blurMat` (line 958) but run the passes along the **velocity
     direction** only (not separable H+V). `const dir = normalize(v.x*width, v.y*height)`;
     `const { passes } = blurPasses(...)`-style pass count sized to `lenPx`; each pass sets
     `blurMat.uniforms.uDir.value.set(dir.x*step/this.width, dir.y*step/this.height)` and runs one
     `this.pass(blurMat, scratch)` (single axis). `step = lenPx / (passes * TAPS)`. This reuses the
     existing symmetric-Gaussian `BLUR_FRAG` (line ~366) unchanged — a symmetric streak along the
     path (Decision 5). Consider a thin `velocityBlur` wrapper next to `blur()` (line 1146) rather
     than inlining.
  4. `this.composite(blurred.texture, this.layer.depthTexture, invDepth, 1, lenPx, null)`
     (line 1405) — depth-tested premultiplied over, `haloPx = lenPx` so the smear that reaches past
     the silhouette isn't clipped (the exact role `haloPx` plays for chromaticSplit/glitch,
     lines 1327-1346).
- **Tests:**
  - CPU twin unit: the NDC→px smear-length formula and the "still ⇒ no-op below 1 px" branch.
  - Source-guard unit (if any new GLSL is authored — reuse means likely none; still assert no
    bare-int operand if a dedicated frag is added).
  - **Live Playwright — "blur along the path":** seed a scene where the left object has a
    horizontal `move`/`spin` motion + a `velocityBlur`; capture `__scene3dSnapshotAt(t01)` at a `t01`
    where velocity is non-zero. Assert (a) `__scene3dTreatmentStats().groups >= 1` and `frames > 0`
    (the stage actually ran — the S4/S5 loud-failure guard); (b) **directional** smear: gradient
    energy (the `sharpness`/`bandEnergy` metric already in `scene3d-treatments.spec.ts:57-72`)
    drops sharply **along the velocity axis** while the perpendicular axis stays sharp — i.e.
    horizontal-step energy ≪ vertical-step energy for a horizontally-moving object; (c) the object's
    silhouette extends **along +/- the path** beyond the clean silhouette (sample pixels offset
    along the velocity direction are now non-empty). Compare against the same moving object with
    `velocityBlur.amount = 0` (control) — moving-with-amount differs; the change is concentrated on
    the path axis.
  - **Live Playwright — "none when still":** the same object with `velocityBlur` captured at a
    still moment (paused clip, or `t01` at a motion apex where velocity ≈ 0) is **byte-identical**
    (data-URL `.toBe`) to the same object with `velocityBlur.amount = 0`. Proves the sub-pixel
    no-op.
- **Byte-identity guarantee:** velocityBlur is only in `MOTION_TREATMENT_KINDS`; absent ⇒
  `motionTreatmentPlan` empty ⇒ stage untouched (Task 1 gate). Present-but-still ⇒ the `lenPx < 1`
  hard no-op ⇒ identical to amount-0.
- **Acceptance:** a moving primitive smears along its path in the lab page; still ⇒ no smear;
  export video (renderMotionFrame path) shows the same blur.

### Task 3 · Ghost trails / onion skin
- `treatmentStage.ts` `ghostTrailsComposite(scene, camera, root, exclude, t, poses: LocalPose[])`:
  - Snapshot the root's current local transform (`position`/`rotation`/`scale`).
  - For each ghost pose, **oldest→newest** (faintest first): assign the root's local TRS to the
    past pose, `root.updateMatrixWorld(true)`, `drawAlone(scene, camera, root, exclude, this.layer,
    null)`, then `this.composite(this.layer.texture, this.layer.depthTexture, invDepth,
    alpha_k, 0, null)` where `alpha_k = Math.pow(t.fade, ghostIndexFromNewest)` (or a linear
    falloff — document which). Ghosts are depth-tested against the base so they sit behind other
    scene geometry correctly.
  - **Restore** the root's local transform + `updateMatrixWorld(true)` in a `finally` (a throw
    mid-loop must never leave the object parked at a past pose — the object is live in the scene
    graph). The crisp current object is already excluded from base (motionRoots hidden), so draw it
    last: `drawAlone` at the restored pose → `composite(..., 1, 0, null)` on top.
  - **Cost:** N+1 `drawAlone`+`composite` per ghosted object (N = `count`, default 3). Capped by
    `GHOST_COUNT_MAX = 8` and `TREATED_OBJECT_CAP` groups; note the cost in the row's help/dashboard.
  - **Interaction with the premultiplied accumulator:** each ghost goes through the same
    `composite()` premultiplied-over path as every masked layer, so no special HDR handling; the
    faded alpha is a plain composite opacity (the `uOpacity` path, line 1414 — not the display-space
    fade branch, since a constant alpha < 1 without a ramp still uses the linear composite; verify
    the `uDisplayBlend` branch at line 1421 — a constant opacity < 1 *does* take the tone-mapped
    path when ACES is on, which is correct for perceptual fade).
- **Tests:**
  - CPU twin unit: `ghostLocalPoses` produces `count` poses at the right `spacing`-frame offsets
    with wrap; `alpha_k` falloff sequence.
  - **Live Playwright — ghosts present:** a moving object with `ghostTrails` at a moving `t01` shows
    **multiple silhouettes** — sample along the path at the ghost offsets and assert non-empty
    faded copies at those positions, decreasing in coverage/alpha with distance; assert
    `stats.groups >= 1`. Bump `count` ⇒ more copies (more non-empty sample positions).
  - **Live Playwright — none when still:** a still object with `ghostTrails` (all poses collapse to
    the current pose) is byte-identical to the same object with `count = 1` at rest / to a plain
    object drawn through the stage — the sub-pixel-collapse no-op.
- **Byte-identity guarantee:** same family gate as Task 2; a still object's ghosts collapse to the
  current pose and are suppressed.
- **Acceptance:** a moving object fans faded copies behind it; still ⇒ single crisp object; export
  video matches.

### Task 4 · Whole-slice live Playwright suite + the harness hook
- Finalize `tests/scene3d-motion.spec.ts` (created RED in Task 1): per kind —
  blur/ghosts-along-path (directional/multi-silhouette), none-when-still (byte-identical to the
  amount-0/count-1 control), absent-byte-identity (plain object unchanged), determinism (same
  `t01` twice ⇒ identical data-URL). Add a **camera-orbit-does-not-blur-a-static-object** case
  (Decision 4): a static object with `velocityBlur` under a `camera.motion.orbit` preset stays
  crisp.
- Every visual assertion paired with `__scene3dTreatmentStats()` (`frames > 0`, `groups >= 1`) so a
  stage that silently fell back to the plain render fails loudly (the S4/S5 loud-failure discipline).
- Console-error gate: assert no shader-link/console errors during each case
  (`scene3d-finishes.spec.ts:92` pattern) — catches an ANGLE float÷int link failure that a CPU twin
  would miss.
- Run live against a **fresh harness preview** (`PW_BASE_URL=http://127.0.0.1:<port>`), pane
  visible — NOT the shared :3002, which may be hidden (paused rAF ⇒ blank).
- **Acceptance:** the full `scene3d-motion` describe green live; whole-slice unit sweep green;
  typecheck at baseline.

### Task 5 · Agent / motion / copy sweep
- Assert (test) `iterateTreatmentControls` emits every velocityBlur/ghostTrails dial by
  `objects.<id>.treatments.<tid>.<field>` and that `animatableTargets` lists them (no per-kind
  agent edit, no colour whitelist — both kinds are numeric-only, so no colour concern).
- Copy sweep: labels/hints sentence case, human names, no dead controls; confirm no `invert` row is
  rendered for either kind (non-masked); the row icons render (`TREATMENT_ICONS` total-Record).
- Dashboard/memory: record the slice landed (base→tip, live gate N/N), mirroring the S5 closeout
  memory `scene3d-finishes-s5-landed`.
- **Acceptance:** agent can add/animate both kinds by id; whole-slice review; copy pass.

---

## Acceptance (whole slice)
- velocityBlur and ghostTrails add as treatment rows on a primitive; a **moving** object shows a
  directional smear / faded trails, a **still** object shows neither, and an object with **neither
  kind** is byte-identical to pre-S6 (unit gate + lab real-canvas A/B).
- Every dial is a motion target and agent control by stable id.
- Live Playwright describe green against a fresh preview; unit sweep green; typecheck at baseline.
- Export video (renderMotionFrame path) shows the same blur/trails as live playback.

## Follow-ups (owed, non-blocking)
- **Parented objects** (Decision 7): compose the animated parent chain in `sceneScreenVelocities`
  / `ghostLocalPoses` for on-screen-accurate velocity of a parented object.
- **Trailing (backward-only) motion blur** and **camera-induced blur** (Decisions 4/5).
- velocityBlur composing in one chain with masked blur/grade on the same object (currently separate
  family passes, painter-composited).
- GLB hosts: velocity/ghosts already work through `objectRoots` + `drawAlone` (host-agnostic), but
  add a live GLB case to the suite to confirm.

## Top risks (from the planner's investigation)
1. **The `t`/`dt`→stage seam is the whole slice.** Motion is stateless and applied *before* the
   stage runs; velocity/ghosts must be computed at BOTH seams that still hold the doc + `t01` (the
   live rAF loop `Scene3DStudioSurface.vue:2098-2126` **and** `renderMotionFrame`
   `motion/render.ts:48`) and pushed through the engine into `StageContext`. Miss either seam and
   the effect works live but not in export (or vice-versa). Centralizing the math in
   `motion/velocity.ts` imported by both is the mitigation.
2. **Verification harness gap.** Existing `__scene3d*` hooks snapshot only at `t=0`, and a hidden
   pane pauses the rAF (blank). The `__scene3dSnapshotAt(t01)` hook must land in Task 1 or the
   "blur along the path" test races the playhead.
3. **"Byte-identical when absent" ≠ "none when still".** Absent is the standard family-gate A/B.
   "None when still" is asserted as still-velocityBlur == amount-0-velocityBlur (both route through
   the same stage and hard-no-op at `lenPx < 1`), NOT as identity with the no-stage path.
   Secondary: ghost trails mutate the live scene-graph root mid-frame — restore MUST be in a
   `finally`.
