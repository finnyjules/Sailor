// frontend/app/lib/scene3d/interaction.ts
// Viewport interaction: orbit camera, click-to-select raycasting, and a
// Spline-style COMBINED gizmo — move, rotate, and scale live on one gizmo with
// no mode switching. Three's TransformControls is single-mode, so we mount
// three pruned instances on the same object:
//   - translate: axis arrows only (planes + centre handle hidden)
//   - rotate:    the three axis arcs only (outer ring + view sphere hidden)
//   - scale:     the three axis cubes only (per-axis; the centre XYZ cube is
//                removed because three's centre-scale divides by the pointer's
//                start distance from the origin — Shift makes a drag uniform)
// Each instance raycasts only its own visible picker handles (TransformControls
// skips invisible pickers), so they never fight over a drag.
// Emits document-shaped mutations (TransformSnapshot) so the surface owns all
// SceneDoc writes — a future undo/redo hooks in there.
//
// MULTI-SELECTION: TransformControls attaches to exactly one Object3D, so a
// selection of 2+ objects drives a transient PIVOT instead (see `selectMany`).
// The pivot exists for as long as the multi-selection does, but it only OWNS
// the selected roots for the duration of a drag — see `holdRoots` for why that
// window is deliberately as narrow as it is.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { Vec3 } from './config'
import type { SceneEngine } from './engine'
import { SURFACE_HIDDEN_LAYER } from '~/lib/scene3d/treatmentShells'

export interface TransformSnapshot { position: Vec3; rotation: Vec3; scale: Vec3 }

/** One-shot click-to-place result: a raycast hit against `engine.objectRoots`,
 *  reported in the TARGET object's own local space (the target being whichever
 *  scene object the click landed on — a primitive root IS the mesh, so no
 *  extra conversion is needed for `localNormal`). */
export interface PlacementHit { targetId: string; localPoint: Vec3; localNormal: Vec3 }

type GizmoMode = 'translate' | 'rotate' | 'scale'

/** Orbit is enabled only when NO concern holds a lock. Pure so it's
 *  unit-testable independent of a live OrbitControls.
 *
 *  Three concerns now: camera motion playback, a gizmo drag, and a live sculpt
 *  stroke/hover. Each owns a private field on SceneInteraction and NOTHING
 *  writes `orbit.enabled` directly — a per-frame writer that did so silently
 *  stomped another concern's lock once already. Go through `updateOrbitEnabled`.
 *
 *  `sculpting` here is deliberately narrower than "sculpt mode is active": it
 *  is true only while a brush stroke is live or the cursor is hovering the
 *  sculpted mesh, so the camera stays free to orbit/pan/zoom over empty space
 *  for the whole rest of the session (see SceneInteraction's `setSculpting`
 *  vs `setSculptMode`). */
export function orbitShouldBeEnabled(
  cameraLocked: boolean,
  gizmoDragging: boolean,
  sculpting: boolean,
  decalDragging = false,
): boolean {
  return !cameraLocked && !gizmoDragging && !sculpting && !decalDragging
}

/** REMOVE every handle (visual AND picker) whose name isn't in `keep`.
 *  Setting `visible = false` is not enough: TransformControlsGizmo re-derives
 *  handle visibility every frame in its update loop, resurrecting hidden
 *  handles. Removing the children takes them out of both rendering and the
 *  picker raycast for good (geometry/materials disposed on the way out). */
// Scratch instances for the per-pointermove decompose in `emitTransform`.
// Module-scope and reused: emitTransform runs once per selected object per
// pointermove, and a drag is the one place in this file where per-frame
// allocation would actually be paid for.
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _e = new THREE.Euler()

function pruneGizmo(tc: TransformControls, mode: GizmoMode, keep: Set<string>): void {
  const inner = (tc as unknown as {
    _gizmo: { gizmo: Record<string, THREE.Object3D>; picker: Record<string, THREE.Object3D> }
  })._gizmo
  for (const kind of ['gizmo', 'picker'] as const) {
    const group = inner[kind][mode]
    if (!group) continue
    for (const child of [...group.children]) {
      if (keep.has(child.name)) continue
      group.remove(child)
      child.traverse((c) => {
        const mesh = c as THREE.Mesh
        if (mesh.isMesh || (c as THREE.Line).type === 'Line') {
          mesh.geometry?.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((mm) => mm?.dispose())
        }
      })
    }
  }
}

export class SceneInteraction {
  readonly orbit: OrbitControls
  private gizmos: TransformControls[] = []
  private raycaster = new THREE.Raycaster()
  // The ORDERED selection, mirroring the surface's `selectedIds`. Last entry is
  // the primary — the one a single-selection gizmo attaches to and the one
  // `emitTransform` reports when there is no pivot. Single source of truth in
  // here: nothing in this class keeps a separate scalar "selected id".
  private selectedIds: string[] = []
  /** Transient parent used to drive a MULTI-selection with a single gizmo.
   *  TransformControls attaches to exactly one Object3D, so the gizmos attach
   *  to this instead and the selected roots ride along under it. Object3D.attach
   *  preserves the world transform on the way IN and on the way OUT, which is
   *  why the pivot needs no delta maths of its own. Never added to doc.objects,
   *  and tagged isGizmoHelper so the bake/export passes skip it. */
  private pivot: THREE.Object3D | null = null
  /** True only between drag start and drag end — the window in which the roots
   *  are actually parented to the pivot, and therefore the window in which
   *  their local transforms are pivot-relative garbage as far as the doc is
   *  concerned. Read by the surface through `pivotDragActive`. */
  private pivotHolding = false
  private downAt: [number, number] | null = null
  // Latched from 'dragging-changed': a gizmo's own pointerup listener runs
  // before ours (registered earlier on the same element) and resets its
  // dragging flag, so onUp must consult this latch instead. Set on drag
  // start, consumed (read + cleared) inside onUp — a deferred clear wouldn't
  // survive the microtask checkpoint browsers run between listeners on
  // trusted events.
  private gizmoDragged = false
  // Shift while dragging a scale dot = uniform scale: the dragged axis's ratio
  // (vs the scale recorded at drag start) is applied to all three axes.
  private shiftDown = false
  private scaleDragStart: THREE.Vector3 | null = null
  // Single authority over `orbit.enabled`. Two independent concerns want to
  // disable orbit — camera motion playing back (surface calls setCameraLocked)
  // and a gizmo being dragged (the dragging-changed listener below) — so each
  // gets its own field and `orbit.enabled` is always the AND-negation of both,
  // recomputed through updateOrbitEnabled. Neither side may write
  // `orbit.enabled` directly: a per-frame writer that did so would silently
  // stomp the other's lock (this exact bug shipped once already — see
  // Scene3DStudioSurface's call sites for the full story).
  private cameraLocked = false
  private gizmoDragging = false
  // Third orbit concern (see orbitShouldBeEnabled): held only while a sculpt
  // stroke is LIVE or the cursor is currently hovering the sculpted mesh —
  // NOT for the whole sculpt-mode session (that would refreeze the very
  // orbit this concern exists to unfreeze; see `sculptModeActive` below for
  // the session-long flag). Same rule as the two above — nothing may write
  // `orbit.enabled` directly; go through `updateOrbitEnabled` via `setSculpting`.
  private sculpting = false
  // Separate concern from `sculpting` above: true for the WHOLE sculpt-mode
  // session (entry to exit), independent of hover/stroke state. Drives gizmo
  // hide+disable only, via `setSculptMode` — never routed through
  // `setSculpting`, because conflating the two would either re-lock orbit for
  // the entire session (the exact bug this task fixes) or pop the gizmo back
  // on screen the instant the cursor leaves the mesh (the Geometry panel
  // stays swapped for the sculpt panel the whole session regardless of
  // hover, so a live gizmo underneath it would be meaningless either way).
  private sculptModeActive = false
  // Single authority over every gizmo's `enabled`, for the same reason as
  // `orbit.enabled` above: two concerns want to write it — mutual exclusion
  // between the three pruned instances (`dragOwner`) and the surface's
  // playback lock (`playbackLocked`) — and the surface re-asserts its lock
  // every frame. Nothing may write `tc.enabled` directly; go through
  // `updateGizmosEnabled`, which ANDs both and never touches a gizmo that is
  // mid-drag (see there for the pointer-capture leak that would cause).
  private playbackLocked = false
  private dragOwner: TransformControls | null = null
  // One-shot click-to-place: armed by `beginPlacement`, consumed by the next
  // qualifying click in `onUp` (or left armed indefinitely on a miss — only
  // `cancelPlacement` clears it otherwise). `valid` lets the caller reject a
  // hit (e.g. a decal or light sitting on top of the intended surface) without
  // dropping out of placement mode; `cb` fires once, with the hit already
  // resolved into the target's local space.
  private placement: { valid: (id: string) => boolean; cb: (hit: PlacementHit) => void } | null = null
  // Grab-to-move a decal: armed in `onDown` when the pointer goes down over a draggable
  // decal (see callbacks.decalTargetFor), consumed by `onMove` (re-projects the sticker onto
  // `targetRoot` under the cursor) and cleared in `onUp`. `decalDragging` is the orbit lock —
  // like `sculpting`/`gizmoDragging`, it disables OrbitControls for the gesture so a grab
  // slides the sticker instead of orbiting. `moved` gates the >4px click/drag split: a grab
  // that never crosses it is a plain select, not a reposition.
  private decalDrag: { decalId: string; targetRoot: THREE.Object3D } | null = null
  private decalDragging = false
  private decalDragMoved = false

  constructor(
    private engine: SceneEngine,
    private domElement: HTMLElement,
    private callbacks: {
      onSelect: (id: string | null, additive: boolean) => void
      onTransform: (id: string, t: TransformSnapshot) => void
      /** Fired INSTEAD of onTransform while a multi-selection drag is live.
       *  Each entry carries the object's new WORLD transform — under the pivot
       *  a root's local TRS is meaningless to the doc, so the surface rebases
       *  each entry into its own parent's frame before writing. */
      onTransformMany?: (entries: { id: string; t: TransformSnapshot }[]) => void
      /** Fired once when a multi-selection drag ends, after the roots have been
       *  handed back to the scene. The surface suppresses engine.syncFromDoc
       *  for the duration of such a drag (see `pivotDragActive`), so this is its
       *  cue to run the sync that re-parents the roots to their doc parents. */
      onPivotDragEnd?: () => void
      /** Fired at the start (true) and end (false) of EVERY gizmo drag — single
       *  or multi. The surface uses it to defer geometry for the whole transform
       *  when a boolean dependency exists in the scene (moving one object churns
       *  a booleaning sibling's geometry per frame), catching up once on release.
       *  Fires before onPivotDragEnd so the deferral is already lowered when the
       *  pivot's own catch-up sync runs. */
      onGizmoDragChange?: (dragging: boolean) => void
      /** Fired when the INTERACTION layer drops an armed placement on its own
       *  (a right-click in the viewport) rather than the surface calling
       *  `cancelPlacement`. The surface's own `placingDecal` state — crosshair
       *  cursor, hint banner, the panel's "Click a surface…" label — would
       *  otherwise stay armed with nothing left to consume it. */
      onPlacementCancelled?: () => void
      onCameraChange?: () => void
      /** Given a scene id, return the target surface id if it's a DRAGGABLE decal, else
       *  null. The surface answers from the doc (`kind === 'decal' → targetId`). Its
       *  presence is what enables grab-to-move: `onDown` consults it, and a non-null answer
       *  arms a live reposition (camera locked) instead of an orbit/select. */
      decalTargetFor?: (id: string) => string | null
      /** Fired on each move of a decal grab-drag with the new surface hit (target-local),
       *  same shape `beginPlacement` resolves — the surface writes position/rotation the
       *  same way `onDecalPlaced` does. The target never changes mid-drag (the ray tests the
       *  original surface only), so a drag slides the sticker across its own solid. */
      onDecalReposition?: (decalId: string, hit: PlacementHit) => void
    },
  ) {
    // A surface hidden by a wireframe treatment moves to this layer (treatmentShells.ts):
    // invisible, but still the thing you click to select the object.
    this.raycaster.layers.enable(SURFACE_HIDDEN_LAYER)
    this.orbit = new OrbitControls(engine.camera, domElement)
    this.orbit.enableDamping = true
    // Pan along the screen plane (not the ground) so a two-finger drag tracks the cursor.
    this.orbit.screenSpacePanning = true
    this.orbit.addEventListener('change', () => callbacks.onCameraChange?.())

    // The combined gizmo: three pruned single-mode instances, spatially LAYERED
    // by size so their handles/pickers don't occupy the same span (all of
    // three's handles sit at ±0.5·size with pickers spanning 0→0.6·size — at
    // equal sizes the first instance swallows every axis grab):
    //   scale cubes innermost (0.55) · rotate arcs middle (0.9) · translate
    //   arrows outermost (1.3) — the Spline layering (dots → arcs → arrows).
    // ORDER = pointerdown priority for the remaining overlapping inner-shaft region
    // (mutual exclusion below disables later instances once one starts a drag).
    // No centre XYZ scale handle — three's centre-scale divides by the
    // pointer's start distance from the origin, which explodes near the centre.
    const parts: { mode: GizmoMode; keep: Set<string>; size: number }[] = [
      { mode: 'scale', keep: new Set(['X', 'Y', 'Z']), size: 0.55 },
      { mode: 'translate', keep: new Set(['X', 'Y', 'Z']), size: 1.3 },
      { mode: 'rotate', keep: new Set(['X', 'Y', 'Z']), size: 0.9 },
    ]
    for (const { mode, keep, size } of parts) {
      const tc = new TransformControls(engine.camera, domElement)
      tc.setMode(mode)
      tc.size = size
      pruneGizmo(tc, mode, keep)
      // TransformControls extends Controls (not Object3D — see note below), so
      // it has no userData; tag it via a cast so `select` can identify which
      // pruned instance is the scale one without a parallel lookup structure.
      ;(tc as unknown as { userData: Record<string, unknown> }).userData = { mode }
      tc.addEventListener('dragging-changed', (e) => {
        // three types EVERY entry in TransformControlsEventMap as `{ value: unknown }`,
        // this one included, so the boolean has to be recovered here. Coerced, not
        // cast — a cast would assert a shape three does not promise, and this flag
        // gates orbit; a truthy non-boolean silently wedging orbit off is exactly
        // the failure an `as boolean` would hide.
        this.gizmoDragging = !!e.value
        this.updateOrbitEnabled()
        if (e.value) {
          this.gizmoDragged = true
          // Defer geometry for the whole transform when a boolean dependency
          // exists (a no-op otherwise) — moving one object churns a booleaning
          // sibling's geometry per frame. Fired for single AND multi drags.
          this.callbacks.onGizmoDragChange?.(true)
          // The multi-selection roots join the pivot HERE, at the grab, and
          // never mid-drag: three captured the pivot's own start transform in
          // its pointerdown handler (which runs BEFORE this listener) and
          // attaching CHILDREN never touches the parent's transform, so this is
          // invisible. Attaching one move later instead would hand the objects a
          // gizmo that has already consumed deltas they never saw — the
          // first-frame pop.
          this.holdRoots()
          // Uniform-scale support: remember where the scale started.
          if (mode === 'scale') this.scaleDragStart = tc.object?.scale.clone() ?? null
          // Mutual exclusion: several instances can raycast-hit overlapping
          // pickers in the same pointerdown (each would then process the whole
          // drag → simultaneous translate+scale). The first to start dragging
          // (listener registration order = `parts` order) disables the rest;
          // their enabled-guard makes their later pointerdown listeners bail.
          this.dragOwner = tc
          this.updateGizmosEnabled()
        } else {
          if (mode === 'scale') this.scaleDragStart = null
          // Give the roots back to the scene the instant the drag ends. The doc
          // already holds their rebased locals (the last objectChange wrote
          // them), so `reseatPivot` below can measure the fresh centre and the
          // surface's sync can re-parent them for real.
          const wasPivotDrag = this.pivotHolding
          this.releaseRoots()
          this.reseatPivot()
          this.dragOwner = null
          this.updateGizmosEnabled()
          // Lower the boolean deferral (and run its catch-up sync) now the roots
          // are back in the scene — BEFORE onPivotDragEnd, so its own sync sees
          // deferGeometry already down and rebuilds the churned geometry once.
          this.callbacks.onGizmoDragChange?.(false)
          if (wasPivotDrag) this.callbacks.onPivotDragEnd?.()
        }
      })
      tc.addEventListener('objectChange', () => {
        // Shift + scale-dot drag → uniform: three has just set ONE axis to
        // start·ratio (it recomputes from the drag start every pointermove, so
        // overwriting here never corrupts the next move). Spread that ratio.
        if (mode === 'scale' && this.shiftDown && this.scaleDragStart && tc.object) {
          const s = tc.object.scale
          const start = this.scaleDragStart
          let ratio = 1
          let best = 0
          for (const axis of ['x', 'y', 'z'] as const) {
            const r = start[axis] !== 0 ? s[axis] / start[axis] : 1
            if (Math.abs(r - 1) > best) { best = Math.abs(r - 1); ratio = r }
          }
          s.set(start.x * ratio, start.y * ratio, start.z * ratio)
        }
        this.emitTransform()
      })
      // three 0.171 TransformControls extends Controls (not Object3D); its
      // visual representation is the helper root returned by getHelper().
      // Tag it so the bake (renderPasses) can hide it — the gizmo shares
      // engine.scene, so an attached gizmo would otherwise bleed into every
      // baked pass (visible handles in beauty, false geometry in depth/normal).
      const helper = tc.getHelper()
      helper.userData.isGizmoHelper = true
      this.engine.scene.add(helper)
      this.gizmos.push(tc)
    }

    domElement.addEventListener('pointerdown', this.onDown)
    domElement.addEventListener('pointermove', this.onMove)
    domElement.addEventListener('pointerup', this.onUp)
    domElement.addEventListener('contextmenu', this.onContextMenu)
    // Capture phase + non-passive so this runs BEFORE OrbitControls' own wheel
    // listener and can preventDefault: a trackpad two-finger drag arrives as a
    // wheel event, which OrbitControls would dolly (zoom). We pan on that and let
    // OrbitControls keep the zoom for pinch (ctrlKey) and a real mouse wheel.
    domElement.addEventListener('wheel', this.onWheel, { passive: false, capture: true })
  }

  /** Recomputes `orbit.enabled` from the three locks. Called whenever any
   *  changes — never write `orbit.enabled` directly (see field comments). */
  private updateOrbitEnabled(): void {
    this.orbit.enabled = orbitShouldBeEnabled(this.cameraLocked, this.gizmoDragging, this.sculpting, this.decalDragging)
  }

  /** Surface-owned lock: true while camera motion is animating playback.
   *  Safe (and expected) to call every frame — it's a cheap idempotent
   *  recompute, not a raw write, so it can never stomp a concurrent gizmo
   *  drag's lock the way a direct `orbit.enabled = ...` write would. */
  setCameraLocked(locked: boolean): void {
    this.cameraLocked = locked
    this.updateOrbitEnabled()
  }

  /** Held only while a sculpt stroke is LIVE or the cursor is hovering the
   *  sculpted mesh — the orbit lock, not the mode-long flag (see
   *  `setSculptMode` for that). The surface calls this from its
   *  pointerdown/pointermove/pointerup handlers, and ONLY when the boolean
   *  actually changes: a per-move reassertion of an unchanged value is
   *  exactly the per-frame-writer pattern that has already shipped as a bug
   *  once in this file (see the `sculpting` field comment). */
  setSculpting(active: boolean): void {
    this.sculpting = active
    this.updateOrbitEnabled()
  }

  /** Held for the WHOLE sculpt-mode session (entry to exit) — independent of
   *  hover/stroke state. Hides and disables the gizmo, which has no meaning
   *  while any mesh is being sculpted (the Geometry panel is swapped for the
   *  sculpt panel for the session's whole duration, hovered or not).
   *
   *  `updateGizmosEnabled` alone is NOT enough for the hide half: three's own
   *  TransformControls only toggles `enabled` to gate pointer handling
   *  (pointerHover/pointerDown early-return on `!enabled`) — the helper's
   *  visibility (`_root.visible`, what `getHelper()` returns) is set only by
   *  `attach`/`detach`, never read from `enabled`. So the arrows/rings would
   *  otherwise keep rendering, fully disabled but still on screen, for the
   *  whole sculpt session. Force the helper hidden here, and restore it to
   *  whatever attach/detach already says on the way out — `!!tc.object`
   *  covers a selection change that happened while sculpting (guarded against
   *  elsewhere, but this stays correct even if that guard is ever removed).
   *
   *  Deactivating also force-clears the orbit lock (`sculpting` / hover-or-
   *  stroke), belt-and-braces against a caller that exits sculpt mode without
   *  first taking the stroke/hover lock back down to false — the failure mode
   *  is a camera stuck orbit-locked with no session left to explain why. */
  setSculptMode(active: boolean): void {
    this.sculptModeActive = active
    if (!active) this.sculpting = false
    this.updateOrbitEnabled()
    this.updateGizmosEnabled()
    this.updateGizmoVisibility()
  }

  /** Authoritative helper visibility: hidden for the whole sculpt-mode
   *  session, otherwise exactly what attach/detach already says
   *  (`!!tc.object`). Called from `setSculptMode` AND from
   *  `select`/`selectMany` — three's own `attach()` unconditionally sets
   *  `_root.visible = true`, so a selection change that lands while sculpting
   *  is active (nothing in today's surface triggers one, but nothing here
   *  should depend on that) would otherwise pop the gizmo back on screen with
   *  no code path left to hide it again. */
  private updateGizmoVisibility(): void {
    for (const tc of this.gizmos) {
      tc.getHelper().visible = this.sculptModeActive || this.placementActive ? false : !!tc.object
    }
  }

  /** Recomputes every gizmo's `enabled` from the mutual-exclusion/playback locks
   *  plus `sculptModeActive` (the gizmo has no meaning for the whole sculpt-mode
   *  session — its object is being deformed by brush strokes, not transformed)
   *  and `placementActive` (see `beginPlacement`/`endPlacement`: while a decal
   *  placement is armed, the target object is very often the CURRENTLY
   *  SELECTED one, so its gizmo's invisible pickers span a wide area around it
   *  — three raycasts them ahead of `onUp`'s own raycast against
   *  `engine.objectRoots` and, on a hit, sets the drag flag that makes `onUp`
   *  bail at the `wasGizmoDrag` guard before placement ever sees the click).
   *  Never write `tc.enabled` directly (see the field comments).
   *
   *  A gizmo that is MID-DRAG is skipped rather than disabled: three's
   *  `onPointerUp` bails on `!enabled`, so disabling one during its own drag
   *  would leave `dragging` stuck true, the pointer capture never released and
   *  'dragging-changed' never fired — `pivotHolding` would latch on forever and
   *  the surface would stop syncing the doc to the viewport for the rest of the
   *  session. The lock takes effect at the next grab instead. */
  private updateGizmosEnabled(): void {
    for (const tc of this.gizmos) {
      if (tc.dragging) continue
      tc.enabled =
        !this.playbackLocked && !this.sculptModeActive && !this.placementActive &&
        (!this.dragOwner || this.dragOwner === tc)
    }
  }

  /** Surface-owned lock: true while motion playback is running. Safe (and
   *  expected) to call every frame — an idempotent recompute, not a raw write.
   *
   *  Playback re-syncs the engine from a SAMPLED doc every frame, which rips a
   *  multi-selection's roots out of the gizmo pivot; the pivot then keeps
   *  dispatching objectChange, so each root's motion-sampled world transform
   *  gets decomposed and written back as its BASE local. That bakes the
   *  animation's offsets into the objects permanently — data loss, not just a
   *  confused viewport. Refusing the grab in the first place is the fix. */
  setPlaybackLocked(locked: boolean): void {
    this.playbackLocked = locked
    this.updateGizmosEnabled()
  }

  // Shift state rides on the pointer events (works for real keyboards AND
  // synthetic modifier-annotated drags; keydown tracking would miss the
  // latter). During an active gizmo drag, a modifier-less move can never turn
  // Shift OFF — synthetic drags annotate only pointerdown/up, and the drag's
  // starting state should govern. Pressing Shift mid-drag still engages live.
  private onMove = (e: PointerEvent) => {
    if (this.decalDrag) {
      // Hold off until the pointer clears the 4px click threshold, so a plain click on a
      // sticker still selects instead of nudging it by a sub-pixel jitter.
      if (!this.decalDragMoved) {
        const d = this.downAt
        if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) <= 4) return
        this.decalDragMoved = true
      }
      this.dragDecalTo(e)
      return
    }
    const dragging = this.gizmos.some((g) => g.dragging)
    if (!dragging || e.shiftKey) this.shiftDown = e.shiftKey
  }

  /** Right-click cancels an armed decal placement (Escape's twin — placement is
   *  a one-shot mode you arm from the panel and must be able to drop without
   *  touching the keyboard). Tracked down/up rather than acting on the
   *  pointerdown so a right-DRAG, which is OrbitControls' pan, still pans
   *  instead of silently disarming the mode mid-gesture — the same
   *  moved-more-than-4px test `onUp` already uses for left clicks. */
  private rightDownAt: [number, number] | null = null

  /** Swallow the browser menu for the right-click that cancelled placement (and
   *  for any right-click while it is armed — the surface shows no context menu
   *  of its own, and the native one over the canvas is never wanted mid-mode). */
  private onContextMenu = (e: MouseEvent) => {
    if (this.placementActive || this.suppressNextContextMenu) {
      this.suppressNextContextMenu = false
      e.preventDefault()
    }
  }
  private suppressNextContextMenu = false

  /** Trackpad two-finger drag → pan; pinch and a real mouse wheel → zoom.
   *
   *  A two-finger trackpad drag reaches the browser as a `wheel` event, which
   *  OrbitControls treats as dolly (zoom). We intercept it here (capture phase,
   *  before OrbitControls' own wheel listener) and pan instead. Two cases are
   *  left for OrbitControls to zoom: a pinch, which the OS reports as a wheel
   *  with `ctrlKey` set, and a genuine mouse wheel — a line/page-mode delta, or
   *  a coarse vertical-only pixel delta (a wheel notch is ~100px; a trackpad
   *  pan streams small, often horizontal, pixel deltas). */
  private onWheel = (e: WheelEvent): void => {
    if (!this.orbit.enabled) return                 // a gizmo/sculpt/decal drag owns the gesture
    if (e.ctrlKey) return                           // pinch-zoom (or ctrl+wheel) → OrbitControls dollies
    const isMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 100)
    if (isMouseWheel) return                        // real mouse wheel → OrbitControls zooms
    // Trackpad pan: stop OrbitControls' bubble-phase wheel handler from also dollying.
    e.preventDefault()
    e.stopImmediatePropagation()
    this.panByPixels(e.deltaX, e.deltaY)
  }

  /** Pan the camera and its orbit target across the screen plane by a pixel
   *  delta, mirroring OrbitControls' own screen-space pan math so the world
   *  tracks the fingers (grab-and-drag). */
  private panByPixels(dxPixels: number, dyPixels: number): void {
    const cam = this.engine.camera as THREE.PerspectiveCamera
    const el = this.domElement
    const h = el.clientHeight || 1
    // Perspective pan scale: how many world units one screen pixel spans at the
    // target's depth — `2 * distance * tan(fov/2) / viewportHeight`.
    const dist = new THREE.Vector3().copy(cam.position).sub(this.orbit.target).length()
    const worldPerPx = (2 * dist * Math.tan(((cam.fov || 45) / 2) * Math.PI / 180)) / h
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0)  // camera x
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1)     // camera y (screen-space pan)
    // Grab-and-drag: the world follows the fingers. A rightward two-finger drag
    // is a negative deltaX, so move the world +right by −deltaX; a downward drag
    // is a positive deltaY, so move the world −up by +deltaY.
    const move = new THREE.Vector3()
      .addScaledVector(right, -dxPixels * worldPerPx)
      .addScaledVector(up, dyPixels * worldPerPx)
    cam.position.add(move)
    this.orbit.target.add(move)
    this.orbit.update()
  }

  /** Pointer → normalized device coords against the canvas rect. */
  private ndcFrom(e: PointerEvent): THREE.Vector2 {
    const rect = this.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  /** Walk up to the nearest ancestor stamped with a scene id (object roots carry one). */
  private sceneIdAt(obj: THREE.Object3D | null): string | undefined {
    let n: THREE.Object3D | null = obj
    while (n && !n.userData.sceneId) n = n.parent
    return n?.userData.sceneId as string | undefined
  }

  /** If the pointer is over a draggable decal (front-most coplanar cluster — the sticker sits
   *  ON its surface, so surface and sticker hits share a depth), return the grab context.
   *  `decalTargetFor` is what decides drag-ability; a missing callback means the feature is off. */
  private decalGrabUnderPointer(e: PointerEvent): { decalId: string; targetRoot: THREE.Object3D } | null {
    const decalTargetFor = this.callbacks.decalTargetFor
    if (!decalTargetFor) return null
    this.raycaster.setFromCamera(this.ndcFrom(e), this.engine.camera)
    const roots = [...this.engine.objectRoots.values()].filter((r) => r.visible)
    const hits = this.raycaster.intersectObjects(roots, true)
    if (!hits.length) return null
    const frontDist = hits[0]!.distance
    for (const hit of hits) {
      if (hit.distance > frontDist + 0.05) break // only the front-most coplanar cluster
      if (hit.object.userData.isGizmoHelper) continue
      const id = this.sceneIdAt(hit.object)
      if (!id) continue
      const targetId = decalTargetFor(id)
      if (!targetId) continue
      const targetRoot = this.engine.objectRoots.get(targetId)
      if (targetRoot) return { decalId: id, targetRoot }
    }
    return null
  }

  /** Re-project the dragged decal onto its target surface under the cursor and fire the
   *  reposition callback. Raycasts ONLY the original target (not the whole scene), skipping
   *  any decal geometry on it (its own sticker or siblings, coplanar with the surface) so the
   *  ray lands on the solid, never on the sticker being dragged. A miss (dragged off the
   *  surface) leaves the sticker where it was. */
  private dragDecalTo(e: PointerEvent): void {
    const drag = this.decalDrag!
    this.raycaster.setFromCamera(this.ndcFrom(e), this.engine.camera)
    const hits = this.raycaster.intersectObject(drag.targetRoot, true)
    for (const hit of hits) {
      if (!hit.face) continue
      let n: THREE.Object3D | null = hit.object
      let onDecal = false
      while (n && n !== drag.targetRoot) { if (n.userData.decalObj) { onDecal = true; break } n = n.parent }
      if (onDecal) continue
      const lp = drag.targetRoot.worldToLocal(hit.point.clone())
      const targetId = drag.targetRoot.userData.sceneId as string
      this.callbacks.onDecalReposition?.(drag.decalId, {
        targetId,
        localPoint: [lp.x, lp.y, lp.z],
        localNormal: [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z],
      })
      return
    }
  }

  private onDown = (e: PointerEvent) => {
    this.shiftDown = e.shiftKey
    if (e.button === 2 && this.placementActive) { this.rightDownAt = [e.clientX, e.clientY]; return }
    if (e.button !== 0) return
    this.downAt = [e.clientX, e.clientY]
    // Grab-to-move a decal: if the press lands on a draggable sticker (and we're not placing,
    // sculpting, or already grabbing a gizmo handle — its own pointerdown ran first), arm a
    // live reposition and lock the camera for the gesture. A grab that never moves >4px falls
    // through to a plain select in `onUp`.
    if (!this.placement && !this.sculptModeActive && !this.gizmos.some((g) => g.dragging)) {
      const grab = this.decalGrabUnderPointer(e)
      if (grab) {
        this.decalDrag = grab
        this.decalDragMoved = false
        this.decalDragging = true
        this.updateOrbitEnabled()
        try { this.domElement.setPointerCapture(e.pointerId) } catch { /* capture best-effort */ }
        return
      }
    }
    // NOTE: do not reset gizmoDragged here — the gizmos' earlier-registered
    // pointerdown listeners have already latched it for handle grabs, and the
    // element's setPointerCapture guarantees onUp always fires to consume it.
  }

  private onUp = (e: PointerEvent) => {
    // End a decal grab first (it owns the whole gesture): release the camera lock and pointer
    // capture. A grab that never moved is a plain click → select the sticker, matching the
    // normal select path this branch pre-empted in `onDown`.
    if (this.decalDrag) {
      const decalId = this.decalDrag.decalId
      const moved = this.decalDragMoved
      this.decalDrag = null
      this.decalDragging = false
      this.decalDragMoved = false
      this.updateOrbitEnabled()
      try { this.domElement.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      this.downAt = null
      if (!moved) this.callbacks.onSelect(decalId, e.shiftKey || e.metaKey || e.ctrlKey)
      return
    }
    if (e.button === 2) {
      const down = this.rightDownAt
      this.rightDownAt = null
      // A right CLICK (not a pan drag) while placement is armed cancels it.
      if (down && this.placement && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 4) {
        this.endPlacement()
        this.callbacks.onPlacementCancelled?.()
        this.suppressNextContextMenu = true // browsers that fire contextmenu on mouseUP
        e.preventDefault()
      }
      return
    }
    // Only treat as a click if the pointer didn't drag (orbit/gizmo own drags).
    if (e.button !== 0) return
    if (!this.downAt) return
    const [dx, dy] = [e.clientX - this.downAt[0], e.clientY - this.downAt[1]]
    this.downAt = null
    const wasGizmoDrag = this.gizmoDragged
    this.gizmoDragged = false
    if (Math.hypot(dx, dy) > 4 || wasGizmoDrag) return
    const rect = this.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.engine.camera)
    const roots = [...this.engine.objectRoots.values()].filter((r) => r.visible)
    const hits = this.raycaster.intersectObjects(roots, true)
    if (this.placement) {
      const { valid, cb } = this.placement
      for (const hit of hits) {
        if (!hit.face || hit.object.userData.isGizmoHelper) continue
        let node: THREE.Object3D | null = hit.object
        while (node && !node.userData.sceneId) node = node.parent
        const hitId = node?.userData.sceneId as string | undefined
        if (!hitId || !valid(hitId)) continue // a decal/light on top of the surface — fall through to the next hit
        const targetRoot = this.engine.objectRoots.get(hitId)
        if (!targetRoot) continue
        const lp = targetRoot.worldToLocal(hit.point.clone())
        // Consumed — a miss (loop exhausts) keeps placement armed; Escape cancels.
        // Restores the gizmos `beginPlacement` suppressed, same as cancelPlacement.
        this.endPlacement()
        cb({
          targetId: hitId,
          localPoint: [lp.x, lp.y, lp.z],
          localNormal: [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z],
        })
        return
      }
      return // clicked empty space or an invalid object: stay in placement mode
    }
    let id: string | null = null
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object
      while (node && !node.userData.sceneId) node = node.parent
      if (node?.userData.sceneId) { id = node.userData.sceneId; break }
    }
    // Shift/Cmd/Ctrl extends the selection. We do NOT re-attach the gizmo here:
    // the surface owns the selection list and calls back into `selectMany`, so
    // attaching from both ends would be two sources of truth that disagree the
    // moment the surface's toggle rule (promote-on-reselect) differs from a
    // plain replace.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    this.callbacks.onSelect(id, additive)
  }

  private emitTransform(): void {
    if (this.pivotHolding && this.pivot) {
      // The pivot's matrixWorld is STALE at this instant: three writes the new
      // position/quaternion/scale and dispatches objectChange without updating
      // any world matrix (the renderer does that later, at draw time). Refresh
      // the pivot's ancestors AND its subtree first — reading root.matrixWorld
      // without this returns the PREVIOUS pointermove's world transform, so the
      // doc trails the viewport by exactly one delta and every object snaps
      // backwards when the drag ends.
      this.pivot.updateWorldMatrix(true, true)
      const entries: { id: string; t: TransformSnapshot }[] = []
      for (const id of this.selectedIds) {
        const root = this.engine.objectRoots.get(id)
        if (!root) continue
        // Decompose the WORLD matrix rather than reading .position/.rotation:
        // while the pivot holds the root those are pivot-relative and mean
        // nothing to the doc, which stores locals under the object's REAL
        // parent. The surface does the rebase.
        root.matrixWorld.decompose(_p, _q, _s)
        _e.setFromQuaternion(_q, 'XYZ') // matches SceneObjectBase.rotation's documented order
        entries.push({
          id,
          t: { position: [_p.x, _p.y, _p.z], rotation: [_e.x, _e.y, _e.z], scale: [_s.x, _s.y, _s.z] },
        })
      }
      this.callbacks.onTransformMany?.(entries)
      return
    }
    const id = this.selectedIds[this.selectedIds.length - 1]
    if (!id) return
    const root = this.engine.objectRoots.get(id)
    if (!root) return
    this.callbacks.onTransform(id, {
      position: root.position.toArray() as Vec3,
      rotation: [root.rotation.x, root.rotation.y, root.rotation.z],
      scale: root.scale.toArray() as Vec3,
    })
  }

  /** Arm one-shot click-to-place: the next qualifying click in `onUp` resolves
   *  to a `PlacementHit` (in the hit target's local space) and fires `cb`
   *  instead of the normal select flow. `valid` can reject a hit (e.g. a decal
   *  or light sitting on top of the intended surface) — rejecting falls
   *  through to the NEXT raycast hit rather than cancelling placement.
   *
   *  Also disables and hides every gizmo for the duration: the placement
   *  TARGET is very often the object that is CURRENTLY selected (the default
   *  state right after adding a primitive), and TransformControls' invisible
   *  pickers span a wide area around the object — left enabled, a click meant
   *  for placement gets raycast-hit by the gizmo first, which latches the drag
   *  flag and makes `onUp` bail before placement's own raycast ever runs.
   *  `enabled = false` alone stops the interception (three's onPointerDown/Up
   *  bail on `!enabled` — see TransformControls.js), but does NOT hide the
   *  helper (its visibility is driven by attach/detach and per-handle axis
   *  state, never by `enabled`), so the visual hide has to be forced through
   *  `updateGizmoVisibility` same as the sculpt-mode session lock. */
  beginPlacement(valid: (id: string) => boolean, cb: (hit: PlacementHit) => void): void {
    this.placement = { valid, cb }
    this.updateGizmosEnabled()
    this.updateGizmoVisibility()
  }

  /** Drop out of placement mode without resolving a hit and restore the
   *  gizmos to the current selection state. The only other way placement
   *  clears is consuming a valid hit (also routed through `endPlacement`,
   *  from `onUp`) — a miss (click on empty space or an object `valid`
   *  rejects) leaves it armed. */
  cancelPlacement(): void {
    this.endPlacement()
  }

  /** Clear `placement` and restore the gizmos — shared by `cancelPlacement`
   *  and `onUp`'s successful-hit branch, so both exits from placement mode
   *  release the gizmo suppression `beginPlacement` applied. Restoring just
   *  means re-running the same enabled/visibility recompute every other lock
   *  uses: `select`/`selectMany` already left the gizmos attached to (or
   *  detached from) the right objects the whole time — placement only ever
   *  suppressed `enabled`/visibility on top of that, never touched attachment. */
  private endPlacement(): void {
    this.placement = null
    this.updateGizmosEnabled()
    this.updateGizmoVisibility()
  }

  get placementActive(): boolean { return this.placement !== null }

  setSnap(enabled: boolean): void {
    for (const tc of this.gizmos) {
      tc.setTranslationSnap(enabled ? 0.25 : null)
      tc.setRotationSnap(enabled ? Math.PI / 12 : null)
      tc.setScaleSnap(enabled ? 0.1 : null)
    }
  }

  /** True while a multi-selection drag has the selected roots re-parented under
   *  the pivot. The surface MUST skip `engine.syncFromDoc` for as long as this
   *  holds: syncObject re-parents every root to its DOC parent on every sync,
   *  so a sync triggered by the drag's own doc writes would tear the roots out
   *  of the pivot after the first pointermove and leave the rest of the drag
   *  moving an empty pivot. `onPivotDragEnd` fires the sync that was skipped. */
  get pivotDragActive(): boolean { return this.pivotHolding }

  /** Attach the gizmo to `ids`. One id behaves exactly as before. Two or more
   *  build a pivot at the bounds centre of their roots and attach that instead.
   *
   *  `opts.noScale` means ANY selected object is a light, not just the primary:
   *  LightObject's scale is never read by the engine, so scaling a light writes
   *  a number nothing will ever honour. Suppressing the scale gizmo for a mixed
   *  selection costs the user nothing (the meshes in it can still be moved and
   *  rotated) and keeps the multi-select rule identical to the single-select
   *  one — a light that can't be scaled alone but can be scaled next to a cube
   *  reads as a bug either way round. `opts.noGizmo` (a decal anywhere in the
   *  selection) suppresses ALL three gizmos on the pivot the same way. */
  selectMany(ids: string[], opts: { noScale?: boolean; noGizmo?: boolean } = {}): void {
    this.teardownPivot()
    this.selectedIds = [...ids]
    if (ids.length <= 1) { this.select(ids[0] ?? null, opts); return }
    // Fewer than two live roots (an id whose object was removed between the doc
    // edit and this call) can't drive a pivot — fall back to a single selection
    // rather than a pivot that would move one object with the ceremony of many.
    // select() narrows selectedIds to match, so emitTransform reports exactly
    // what the gizmo actually drives.
    const roots = ids.map((id) => this.engine.objectRoots.get(id)).filter((r): r is THREE.Object3D => !!r)
    if (roots.length < 2) {
      // The primary is the LAST entry everywhere else in this feature (it is what
      // the properties panel titles itself after); falling back to ids[0] here
      // would silently put the gizmo on a different object than the panel is
      // describing. Prefer the last id that still HAS a root, since attaching to
      // one that doesn't shows no gizmo at all.
      const live = [...ids].reverse().find((id) => this.engine.objectRoots.has(id))
      this.select(live ?? ids[ids.length - 1] ?? null, opts)
      return
    }
    const pivot = new THREE.Object3D()
    pivot.userData.isGizmoHelper = true // keep it out of every baked/exported pass
    this.engine.scene.add(pivot)
    this.pivot = pivot
    this.reseatPivot()
    for (const tc of this.gizmos) {
      const mode = (tc as unknown as { userData: Record<string, unknown> }).userData.mode
      if (opts.noGizmo) tc.detach()
      else if (opts.noScale && mode === 'scale') tc.detach()
      else tc.attach(pivot)
    }
    this.updateGizmoVisibility()
  }

  /** Park the pivot at the bounds centre of the selected roots' world origins,
   *  with identity rotation and scale.
   *
   *  The POSITION re-seat is what keeps the gizmo on its objects. A translate
   *  drag moves the roots but leaves the pivot wherever the gesture ended
   *  relative to them, so without this the handles drift off the selection and,
   *  worse, the next rotate/scale drag pivots about a centre that is no longer
   *  the selection's — the objects swing away on an arc instead of turning in
   *  place. Same story after any doc edit that moves a selected object.
   *
   *  The IDENTITY re-seat matters because the scale gizmo keeps its three
   *  PER-AXIS handles (only the centre XYZ cube is pruned), so a pivot really
   *  can end a drag non-uniformly scaled. Composed with a rotated child on the
   *  next `holdRoots`, that produces genuine shear — and `Object3D.attach`
   *  decomposes, which drops shear silently, so the child visibly deforms at
   *  the instant of the grab.
   *
   *  Called on selection and again after every drag — never at drag START.
   *  three captures the object's start transform in its own pointerdown, which
   *  runs before our dragging-changed listener, so moving the pivot at the grab
   *  would drag from a position the maths never saw (the gizmo jumps under the
   *  pointer). */
  private reseatPivot(): void {
    const pivot = this.pivot
    if (!pivot) return
    const box = new THREE.Box3()
    for (const id of this.selectedIds) {
      const root = this.engine.objectRoots.get(id)
      if (root) box.expandByPoint(root.getWorldPosition(_p))
    }
    if (box.isEmpty()) return
    pivot.position.copy(box.getCenter(_p))
    pivot.rotation.set(0, 0, 0)
    pivot.scale.set(1, 1, 1)
    pivot.updateMatrixWorld(true)
  }

  /** Take ownership of the selected roots for the duration of one drag —
   *  `attach`, not `add`, so each root keeps its world transform and nothing
   *  moves at the grab. The window is deliberately this narrow: the engine
   *  re-parents every root to its doc parent on each syncFromDoc, so a pivot
   *  still holding roots when a sync ran would lose them mid-gesture (and,
   *  worse, a bake would hide the whole selection along with the tagged pivot). */
  private holdRoots(): void {
    const pivot = this.pivot
    if (!pivot || this.pivotHolding) return
    pivot.updateMatrixWorld(true)
    for (const id of this.selectedIds) {
      const root = this.engine.objectRoots.get(id)
      if (root) pivot.attach(root)
    }
    this.pivotHolding = true
  }

  /** Hand the roots back to the scene. `scene.attach` again, so the release is
   *  invisible; the surface's next sync puts each one under its real parent. */
  private releaseRoots(): void {
    this.pivotHolding = false
    const pivot = this.pivot
    if (!pivot) return
    for (const child of [...pivot.children]) this.engine.scene.attach(child)
  }

  /** Release the roots and drop the pivot. Called before every re-attach and on
   *  dispose — a leaked pivot would keep owning roots the engine believes it
   *  parents itself, and would linger in the scene as an untracked child.
   *
   *  Fires `onPivotDragEnd` if it was actually holding, because this is
   *  reachable MID-DRAG: undo rewrites `selectedIds` (a fresh array every time),
   *  which re-enters `selectMany` → here with the pointer still down. Clearing
   *  the surface's sync gate without paying the sync it owes would drop the
   *  roots into the scene while the doc still says they have parents, leaving
   *  the hierarchy visually flat until some unrelated doc write; and the rest of
   *  the drag would then run against a fresh pivot with `pivotHolding` false, so
   *  `emitTransform` would take the single-selection branch and write the
   *  primary's SCENE-relative local into the doc as if it were parent-relative.
   *  Cannot double-fire: the normal drag-end path calls `releaseRoots` directly
   *  and never routes through here, and by the time it does `pivotHolding` is
   *  already false. */
  private teardownPivot(): void {
    const pivot = this.pivot
    if (!pivot) return
    const wasHolding = this.pivotHolding
    this.releaseRoots()
    pivot.removeFromParent()
    this.pivot = null
    for (const tc of this.gizmos) if (tc.object === pivot) tc.detach()
    if (wasHolding) this.callbacks.onPivotDragEnd?.()
  }

  select(id: string | null, opts: { noScale?: boolean; noGizmo?: boolean } = {}): void {
    // Idempotent in the selectMany path (which tears down first), and the safety
    // net for any caller that drops straight from a multi-selection to a single
    // one — a pivot left behind would still own roots the engine parents itself.
    this.teardownPivot()
    this.selectedIds = id ? [id] : []
    const root = id ? this.engine.objectRoots.get(id) : undefined
    for (const tc of this.gizmos) {
      const mode = (tc as unknown as { userData: Record<string, unknown> }).userData.mode
      if (!root || opts.noGizmo) tc.detach()
      else if (opts.noScale && mode === 'scale') tc.detach()
      else tc.attach(root)
    }
    this.updateGizmoVisibility()
  }

  dispose(): void {
    // Before anything else: the pivot may still be holding roots (disposing
    // mid-drag is reachable — closing the studio with the pointer down), and
    // the engine disposes those roots by walking the scene.
    this.teardownPivot()
    this.domElement.removeEventListener('pointerdown', this.onDown)
    this.domElement.removeEventListener('pointermove', this.onMove)
    this.domElement.removeEventListener('pointerup', this.onUp)
    this.domElement.removeEventListener('contextmenu', this.onContextMenu)
    this.domElement.removeEventListener('wheel', this.onWheel, { capture: true } as EventListenerOptions)
    for (const tc of this.gizmos) {
      tc.detach()
      // dispose() frees child geometry/materials but does not unparent _root.
      this.engine.scene.remove(tc.getHelper())
      tc.dispose()
    }
    this.gizmos = []
    this.orbit.dispose()
  }
}
