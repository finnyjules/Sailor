# 3D Studio — Projection (perspective/isometric) + custom output dimensions

> **For agentic workers:** implement task-by-task, TDD. Steps use `- [ ]`.

**Goal:** Add a Perspective/Isometric projection toggle to the 3D Studio camera, and replace the fixed output-size presets with free width/height fields.

**Design (agreed):**
- **Isometric = orthographic at the current angle** — switching does NOT move the camera; it drops perspective convergence in place. A separate **Snap to isometric angle** button moves the camera to azimuth 45° / elevation 35.264° about the target. Orbit stays enabled in both projections.
- **Custom dimensions = two always-visible Width/Height number fields** (presets removed), clamped 256–4096 integers, driving `doc.output`.
- OrbitControls already supports OrthographicCamera (zoom via `camera.zoom`), so ortho zoom is free once its `.object` points at the active camera.

**Tech:** three r0.171 (`OrthographicCamera`, `OrbitControls`), Vitest, Playwright.

## Global constraints
- Work in main checkout. Commit with a private index **seeded from HEAD** (`git read-tree HEAD` into a fresh `mktemp`, never `cp .git/index`), landed via `commit-tree` + `git update-ref HEAD <new> <old>` (compare-and-swap). Stage only own paths. See [[private-git-index-is-the-fix-for-shared-staging]].
- Never run `npm run dev` from a subagent (kills :3002). Use the healthy server (:3000 this session).
- Verify in the REAL visible pane (hidden pane pauses rAF; ortho zoom via OrbitControls needs live frames).
- UI copy: sentence case; selects over lowercase values need `optionLabels`.

---

### Task 1: Config — camera.projection + orthoZoom

**Files:** `frontend/app/lib/scene3d/config.ts`; test `frontend/tests/unit/scene3d-config.unit.spec.ts`.

- `SceneCamera` gains `projection: 'perspective' | 'isometric'` and `orthoZoom: number`.
- Default `projection: 'perspective'`, `orthoZoom: 0.15` (a reasonable base; the engine overwrites it when you first switch, framing from the perspective view).
- Sanitiser (parseDoc, camera block ~1583): `projection: raw.camera?.projection === 'isometric' ? 'isometric' : 'perspective'`; `orthoZoom: typeof raw.camera?.orthoZoom === 'number' && raw.camera.orthoZoom > 0 ? raw.camera.orthoZoom : d.camera.orthoZoom`.
- Test: default is perspective + orthoZoom>0; `{version:1, camera:{projection:'isometric', orthoZoom:0.3}}` round-trips; a garbage projection → perspective.

- [ ] Write failing test → implement → pass → commit.

### Task 2: resolutionGate — orthographic overscan (pure)

**Files:** `frontend/app/lib/scene3d/resolutionGate.ts`; test `frontend/tests/unit/scene3d-resolution-gate.unit.spec.ts` (create or extend).

Add:
```ts
/** Ortho viewport overscan factor (≥1): how much larger the viewport ortho frustum is than the
 *  export frame so the output (at outputAspect) fits inside the pane with a `fill` margin. */
export function orthoOverscanScale(paneAspect: number, outputAspect: number, fill = 0.9): number {
  const pa = Number.isFinite(paneAspect) && paneAspect > 0 ? paneAspect : 1
  return Math.max(1 / fill, outputAspect / (fill * pa))
}
/** Output frame as centered fractions of the pane, orthographic (linear — no fov). */
export function orthoGateRect(paneAspect: number, outputAspect: number, fill = 0.9): { wFrac: number; hFrac: number } {
  const s = orthoOverscanScale(paneAspect, outputAspect, fill)
  const pa = Number.isFinite(paneAspect) && paneAspect > 0 ? paneAspect : 1
  return { wFrac: Math.min(1, outputAspect / (s * pa)), hFrac: Math.min(1, 1 / s) }
}
```
Test: square output in a wide pane → hFrac 1, wFrac<1; portrait output → wFrac<1; scale ≥ 1/fill always.

- [ ] Write failing test → implement → pass → commit.

### Task 3: Engine — orthographic camera + projection-aware render/gate/export helpers

**Files:** `frontend/app/lib/scene3d/engine.ts`.

- Fields: keep `readonly camera: THREE.PerspectiveCamera` (unchanged, avoids breaking persp-specific reads). Add:
  ```ts
  readonly orthoCam: THREE.OrthographicCamera
  private _projection: 'perspective' | 'isometric' = 'perspective'
  private _orthoBaseZoom = 0.15  // export-true zoom (pre-gate); orthoCam.zoom carries the overscanned viewport zoom
  get projection() { return this._projection }
  get activeCamera(): THREE.Camera { return this._projection === 'isometric' ? this.orthoCam : this.camera }
  ```
- Ctor: build `orthoCam = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 1000)`; `orthoCam.position.copy(this.camera.position)`; add to scene? (cameras need not be in scene). Set `orthoCam.zoom` later.
- `setSize`: also set orthoCam left/right/top/bottom from the new aspect (top=1, bottom=-1, left=-aspect, right=aspect) and re-apply gate.
- `applyCameraFromDoc(doc)`: set `_projection = doc.camera.projection`; persp path as today; if isometric, `orthoCam.position.copy(persp target-relative)`… actually: set `orthoCam.position.set(...doc.camera.position); orthoCam.lookAt(...doc.camera.target); this._orthoBaseZoom = doc.camera.orthoZoom; applyViewportGate()`.
- Generalize gate application. Rename `applyViewportFov` internals into `applyViewportGate()`:
  - Perspective branch: unchanged (fov overscan).
  - Isometric branch: `const s = this._gateAspect ? orthoOverscanScale(this.orthoCam.right/this.orthoCam.top /*paneAspect*/, this._gateAspect) : 1; this.orthoCam.zoom = this._orthoBaseZoom / s; this.orthoCam.updateProjectionMatrix()`. (paneAspect = orthoCam.right/orthoCam.top since top=1.)
- `render()` (loop) and pathtracer begin/frame/rebuild: use `this.activeCamera` instead of `this.camera`.
- `setProjection(p, framingFromCurrentView)`: switch `_projection`; on entering isometric, frame from the perspective view — `const dist = this.camera.position.distanceTo(target); this._orthoBaseZoom = 1 / (dist * Math.tan(fovRad/2)); orthoCam.position.copy(this.camera.position); orthoCam.lookAt(target)`. On leaving, copy orthoCam.position → perspCam. Return so the surface can retarget OrbitControls.
- `snapToIsometricAngle(target)`: place the active camera at the iso angle about target (azimuth 45°, elev 35.264°) at the current distance; leave zoom/projection alone.

Covered by live Task 7 (GL). Add a small pure unit for `isoAnglePosition(target, dist)` if extracted.

- [ ] Implement → typecheck (only new camera errors) → commit.

### Task 4: Export uses the active camera

**Files:** `frontend/app/lib/scene3d/passes.ts` (renderPasses ~line 147 clones `engine.camera`; the single-object sibling too if it renders the scene camera).

Replace the clone block:
```ts
let camera: THREE.Camera
if (engine.projection === 'isometric') {
  const oc = engine.orthoCam.clone() as THREE.OrthographicCamera
  // Export frame at the OUTPUT aspect, at the TRUE (pre-gate) ortho zoom.
  oc.top = 1; oc.bottom = -1; oc.left = -(width / height); oc.right = (width / height)
  oc.zoom = engine.orthoBaseZoom       // expose a getter for _orthoBaseZoom
  oc.updateProjectionMatrix()
  camera = oc
} else {
  const pc = engine.camera.clone() as THREE.PerspectiveCamera
  pc.aspect = width / height; pc.fov = engine.baseFov; pc.updateProjectionMatrix()
  camera = pc
}
```
Add `get orthoBaseZoom() { return this._orthoBaseZoom }` to the engine.

- [ ] Implement → typecheck → commit.

### Task 5: Interaction — retarget OrbitControls to the active camera

**Files:** `frontend/app/lib/scene3d/interaction.ts`.

Add a method:
```ts
/** Point the orbit + gizmo at the engine's current active camera (called after a projection
 *  switch). OrbitControls reads `.object` each update; ortho zoom uses object.zoom natively. */
retargetCamera(): void {
  this.orbit.object = this.engine.activeCamera as any
  this.orbit.update()
}
```
(The gizmo's TransformControls camera can stay the perspective one for screen-space sizing, or also retarget — retarget it too if a getter exists.)

- [ ] Implement → typecheck → commit.

### Task 6: Vue surface — projection control, snap button, output fields, wiring

**Files:** `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, `frontend/app/lib/scene3d/controls.ts`, `frontend/app/lib/scene3d/panelPresentation.ts`.

- **controls.ts** (Camera group, near `camera.fov`):
  ```ts
  select('camera.projection', 'Projection', ['perspective', 'isometric'], D.camera.projection, 'Camera',
    'Perspective converges to a vanishing point; isometric keeps parallel lines parallel',
    { optionLabels: ['Perspective', 'Isometric'] }),
  ```
  Gate the existing `camera.fov` control with `when: (doc) => doc.camera.projection !== 'isometric'`.
- **panelPresentation.ts**: add `'camera.projection'` to the Camera group (line 605) before `ui.camera.output`; add a value read for `camera.projection` in readSceneControl.
- **Scene3DStudioSurface.vue**:
  - `setControl`: `if (key === 'camera.projection') { doc.camera.projection = String(value) as any; return }`.
  - On projection change (watch `doc.camera.projection`): call `engine.setProjection(doc.camera.projection); interaction.retargetCamera(); engine.setResolutionGate(doc.output.width/doc.output.height)`, and after switching to iso persist `doc.camera.orthoZoom = engine.orthoBaseZoom`.
  - Persist ortho zoom on camera change (the existing `onCameraChange`/save-camera path at ~4403): also write `doc.camera.projection` and, in iso, `doc.camera.orthoZoom = engine.orthoCam.zoom`-derived base. (Save the pre-gate base: expose `engine.orthoBaseZoom`; OrbitControls writes `orthoCam.zoom` = overscanned, so recompute base = zoom * overscanScale, or simpler: have the engine recompute `_orthoBaseZoom` from `orthoCam.zoom` on orbit change via a method `captureOrthoZoom()`.)
  - **Snap button**: replace the `#control-camera.projection` row or add a small button under it — an `#actions`-style inline control. Simplest: a bespoke control template `#control-camera.snapIso` OR a button in the Camera card shown when isometric. On click: `engine.snapToIsometricAngle([...doc.camera.target]); saveCameraFromEngine()`.
  - **Output fields**: replace `OUTPUT_OPTIONS`/`outputChoice` (lines 872–875) and the `#control-ui.camera.output` template (5696) with two number inputs bound to `doc.output.width`/`height`, clamped 256–4096 on input, integer. Keep the resolution-gate watch (2052) as-is.
  - The gate overlay `gateRect(...)` at ~2049: branch on projection — use `orthoGateRect(va, oa)` when isometric, else the current `gateRect(doc.camera.fov, va, oa, 0.9)`.

- [ ] Implement → typecheck → commit.

### Task 7: Live verification

- [ ] Healthy server check; open 3D Studio in the visible pane; add a box.
- [ ] Projection = Isometric: parallel edges stay parallel (no convergence), camera didn't jump; FOV row hidden; scroll-zoom scales the view (ortho zoom); orbit still works.
- [ ] Snap to isometric angle: camera lands at the 3/4 iso view.
- [ ] Back to Perspective: convergence returns, no jump; FOV row back.
- [ ] Output: set 512×1536 → the resolution-gate rectangle updates to portrait in both projections; `__scene3dBeauty` PNG is 512×1536 and the framing matches the gate.
- [ ] Cinematic in isometric: path trace renders orthographically without errors.
- [ ] Console clean; run the unit specs; screenshot proof.

---

## Self-review
- Coverage: projection data (T1), ortho gate math (T2), ortho camera + render/gate/pathtracer + snap (T3), export camera (T4), orbit retarget (T5), UI + wiring + output fields (T6), live (T7). ✓
- Risk: ortho zoom base vs overscanned zoom bookkeeping — the engine owns `_orthoBaseZoom` (export-true) and derives `orthoCam.zoom` for the gated viewport; the surface persists the base. Keep that the single source of truth.
- Placeholders: none — tricky math and camera framing spelled out; UI edits name exact lines.
