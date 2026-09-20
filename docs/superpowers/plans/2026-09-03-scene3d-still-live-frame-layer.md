# 3D Studio still scenes as live Frame layers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a *still* (non-animated) 3D Studio scene a first-class live Frame layer — rendered client-side at any size, WYSIWYG, with no paid Render/Run — the way a still Gradient, Shape, or Vector Type layer already is.

**Architecture:** 3D Studio already registers a `StudioFrameSource` and the Frame (`ArtifactFrameNode.vue`) already consumes any registered source generically by upstream node id. The single gap: `Scene3DStudioNode.vue`'s `syncRegistration()` registers a frame source **only when `sceneHasMotion(doc)` is true**, so a still scene wired into a Frame falls back to the baked `beauty_image` URL — which is empty until the user hits Render, and stale after every edit. The fix registers the source for any renderable scene (has objects), reports `duration: 0` for stills so the Frame treats them as stills (one pull, no rAF), and replaces the `registered`-keyed engine disposal with an idle-release so an idle 3D node still holds no WebGL context.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Three.js (SceneEngine), Vitest for unit tests, the in-app Browser pane for live verification.

## Global Constraints

- Nothing under `app/lib/scene3d/motion/` may assume a WebGL context or a Vue component — the pure helpers stay unit-testable headless (existing convention, see `motion/frameSource.ts` and `motion/targets.ts` docs).
- The pre-existing guarantee **"an idle 3D node — wired or not — opens no WebGL context"** must survive this change (currently stated verbatim in `Scene3DStudioNode.vue:87-89`). Registering a source must not, by itself, create a context; a context may exist only while a scene is animated (rAF pulls keep it warm) or briefly while a still is being rendered/pulled.
- Still scenes MUST report `duration: 0` from the frame source. A still whose `doc.motion.duration` is a leftover non-zero value (default is 4) must not make the Frame run a pointless rAF over identical frames — mirror the `vtIsAnimated`/`hasTracks||hasFlow` gating the other studios' clocks use.
- Do not change behavior for animated 3D scenes. Their frame source, warm engine, and per-frame pull path stay exactly as today.
- Frontend work happens in `frontend/`. Run the dev server against `127.0.0.1`, never `localhost` (a stray `localhost` binds 426 on this machine — see memory `sailor-dev-server-localhost-426`).

---

### Task 1: `sceneFrameClock(doc)` — the still-aware clock helper

A pure function that returns the frame source's clock, reporting `duration: 0` for a still scene and the real motion duration for an animated one. Extracted so the still-vs-animated rule is unit-tested once and reused by the node component in Task 2 (rather than inlined in a `.vue` setup where it cannot be tested).

**Files:**
- Modify: `frontend/app/lib/scene3d/motion/render.ts` (add `SceneFrameClock` type + `sceneFrameClock`; `sceneHasMotion` already lives here at line 5)
- Test: `frontend/tests/unit/scene3d-motion.unit.spec.ts` (add a `describe` block; file already imports `defaultDoc`, `createPrimitive` from `~/lib/scene3d/config`)

**Interfaces:**
- Consumes: `sceneHasMotion(doc: SceneDoc): boolean` (already exported from `render.ts`); `SceneDoc` from `~/lib/scene3d/config` with `doc.motion.{duration,fps}` and `doc.output.{width,height}`.
- Produces: `interface SceneFrameClock { duration: number; fps: number; width: number; height: number }` and `export function sceneFrameClock(doc: SceneDoc): SceneFrameClock` — used by `Scene3DStudioNode.vue`'s `makeScene3DFrameSource({ getClock })` in Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/scene3d-motion.unit.spec.ts`:

```ts
import { sceneFrameClock, sceneHasMotion } from '~/lib/scene3d/motion/render'

describe('sceneFrameClock', () => {
  it('reports duration 0 for a still scene (no motion), keeping fps and output size', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    doc.motion = { duration: 4, fps: 30, loop: true } // leftover non-zero duration
    expect(sceneHasMotion(doc)).toBe(false)
    expect(sceneFrameClock(doc)).toEqual({ duration: 0, fps: 30, width: doc.output.width, height: doc.output.height })
  })

  it('reports the real motion duration for an object-animated scene', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    obj.motion = { loop: { kind: 'spin', speed: 2, amount: 1 } }
    doc.objects.push(obj)
    doc.motion = { duration: 5, fps: 24, loop: true }
    expect(sceneHasMotion(doc)).toBe(true)
    expect(sceneFrameClock(doc)).toEqual({ duration: 5, fps: 24, width: doc.output.width, height: doc.output.height })
  })

  it('reports the real motion duration for a camera-only-animated scene', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    doc.camera.motion = { preset: 'orbit', speed: 1, amount: 1 }
    doc.motion = { duration: 6, fps: 30, loop: true }
    expect(sceneHasMotion(doc)).toBe(true)
    expect(sceneFrameClock(doc).duration).toBe(6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-motion.unit.spec.ts -t sceneFrameClock`
Expected: FAIL — `sceneFrameClock is not a function` (or an import error) on all three.

- [ ] **Step 3: Implement `sceneFrameClock`**

In `frontend/app/lib/scene3d/motion/render.ts`, directly below the existing `sceneHasMotion` function (after line 13):

```ts
export interface SceneFrameClock { duration: number; fps: number; width: number; height: number }

/** The frame source's clock for a scene. A still scene (no object/camera motion)
 *  reports `duration: 0` so a downstream Frame treats it as a still — one pull, no
 *  rAF — even when `doc.motion.duration` still carries its default non-zero value.
 *  Mirrors `vtIsAnimated` / Gradient's `hasTracks || hasFlow` clock gating. */
export function sceneFrameClock(doc: SceneDoc): SceneFrameClock {
  return {
    duration: sceneHasMotion(doc) ? doc.motion.duration : 0,
    fps: doc.motion.fps,
    width: doc.output.width,
    height: doc.output.height,
  }
}
```

(`SceneDoc` is already imported at the top of `render.ts`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-motion.unit.spec.ts -t sceneFrameClock`
Expected: PASS — 3 passed. (Sanity-check the collected total is 3 and uptime is real — see memory `vitest-counts-lie-under-load`.)

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/motion/render.ts tests/unit/scene3d-motion.unit.spec.ts
git commit -m "feat(scene3d): sceneFrameClock — still scenes report duration 0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Register a still scene's frame source + idle-release the engine

Register the Scene3D frame source for any *renderable* scene (has objects), not only animated ones, using `sceneFrameClock` for the clock. Replace the `registered`-keyed engine disposal — which would now leak, because still scenes become `registered` — with an idle-release timer that disposes the shared headless engine shortly after the last render/pull unless the scene is animated (animated scenes keep pulling and stay warm). Net effect: a still 3D scene wired into a Frame renders live at any size with no Render, and an idle 3D node still holds no WebGL context.

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioNode.vue`
  - import line 13 (add `sceneFrameClock`)
  - `syncRegistration()` at lines 105-129
  - `renderPreview()` finally at line 168
  - `onBeforeUnmount` at lines 243-251
  - add `scheduleEngineRelease()` + `inFlight`/`releaseTimer` state near the engine state (lines 90-92)

**Interfaces:**
- Consumes: `sceneFrameClock` (Task 1); existing `makeScene3DFrameSource`, `registerStudioFrameSource`/`unregisterStudioFrameSource`, `ensureHeadless`, `renderMotionFrameSettled`, `sceneHasMotion`, `sceneDoc`.
- Produces: no new exports. Behavioral contract verified in-browser: a still 3D node wired to a Frame shows its scene live and Run-free; editing the scene updates the Frame; an unwired still 3D node disposes its headless engine when idle.

- [ ] **Step 1: Add `sceneFrameClock` to the render.ts import**

`Scene3DStudioNode.vue` line 13 currently:

```ts
import { sceneHasMotion, renderMotionFrameSettled } from '~/lib/scene3d/motion/render'
```

Change to:

```ts
import { sceneHasMotion, renderMotionFrameSettled, sceneFrameClock } from '~/lib/scene3d/motion/render'
```

- [ ] **Step 2: Add engine-release state + helper**

Directly after the engine state declarations (currently lines 90-92: `let headlessCanvas`, `let headlessEngine`, `let registered`), add:

```ts
// Idle counter + release timer. A render/pull increments `inFlight` around its
// async work; the release timer disposes the shared engine only when nothing is
// in flight AND the scene is not animated. This preserves the "idle node opens no
// WebGL context" guarantee now that STILL scenes also register a frame source
// (and are therefore `registered`, which used to be the disposal gate).
let inFlight = 0
let releaseTimer: ReturnType<typeof setTimeout> | null = null

function scheduleEngineRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    releaseTimer = null
    if (inFlight > 0) { scheduleEngineRelease(); return }   // a render/pull is mid-flight — retry
    if (sceneHasMotion(sceneDoc.value)) return              // animated: rAF pulls keep it warm
    if (!headlessEngine) return
    headlessEngine.dispose(); headlessEngine = null; headlessCanvas = null
  }, 400)
}
```

- [ ] **Step 3: Register for any renderable scene, clock via `sceneFrameClock`, release after a still pull**

Replace the whole `syncRegistration()` function (lines 105-129) with:

```ts
function syncRegistration() {
  const doc = sceneDoc.value
  const renderable = doc.objects.length > 0
  if (renderable && !registered) {
    registerStudioFrameSource(props.id, makeScene3DFrameSource({
      // Still scenes report duration 0 (see sceneFrameClock) so the Frame pulls
      // them once and runs no rAF; animated scenes report their real clock.
      getClock: () => sceneFrameClock(sceneDoc.value),
      // Settled, not plain renderMotionFrame: decal meshes attach on a microtask
      // after syncFromDoc, and a Frame pulls each frame exactly once — a sync
      // render made the sticker pop in a few frames late. getFrame already awaits.
      renderAt: async (t01, w, h) => {
        const eng = ensureHeadless(w, h)
        if (!eng) return null
        inFlight++
        try {
          return await renderMotionFrameSettled(eng, sceneDoc.value, t01)
        } finally {
          inFlight--
          // Release AFTER the consumer copies (pullLiveFrame drawImages once our
          // promise resolves); a synchronous dispose here would blank that canvas.
          scheduleEngineRelease()
        }
      },
    }))
    registered = true
  } else if (!renderable && registered) {
    unregisterStudioFrameSource(props.id)
    registered = false
  }
}
```

- [ ] **Step 4: Replace the `renderPreview` disposal with the idle release**

In `renderPreview()`, the current `finally` block (line ~168) reads:

```ts
    if (gen === previewGen && !registered && headlessEngine === eng) { eng.dispose(); headlessEngine = null; headlessCanvas = null }
```

Replace that `finally` body so the thumbnail render also counts as in-flight and defers disposal to the idle release. The full `try/catch/finally` becomes:

```ts
  inFlight++
  try {
    const url = (await renderMotionFrameSettled(eng, doc, 0)).toDataURL('image/png')
    if (gen === previewGen) livePreviewUrl.value = url
  }
  catch { /* transient WebGL hiccup — keep the previous preview */ }
  finally {
    inFlight--
    // Defer disposal: a still node releases when idle (400 ms), a wired still keeps
    // its engine across the Frame's next pull, an animated scene stays warm.
    scheduleEngineRelease()
  }
```

(Move the existing `inFlight++` to just before the `try`, replacing the old `const eng = ensureHeadless(w, h); if (!eng) return` guard's position is unchanged — `ensureHeadless` still runs above, and `inFlight++` sits between it and the `try`.)

- [ ] **Step 5: Clear the release timer on unmount**

In `onBeforeUnmount` (lines 243-251), add a `clearTimeout` for the release timer alongside the existing `previewTimer` clear. The block becomes:

```ts
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
  if (releaseTimer) clearTimeout(releaseTimer)
  unregisterScene3DRebaker(props.id)
  if (registered) unregisterStudioFrameSource(props.id)
  unsubFieldCatalog()
  headlessEngine?.dispose()
  headlessEngine = null
  headlessCanvas = null
})
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "Scene3DStudioNode\|motion/render" || echo "no new errors in touched files"`
Expected: `no new errors in touched files` (the project may carry a pre-existing typecheck baseline — see memory `typecheck-baseline-anchoring`; only errors naming the two files you touched count).

- [ ] **Step 7: Verify live in the Browser pane**

Start the dev server and drive the real app (never ask the user to check manually):

1. `preview_start` the Sailor frontend (from `.claude/launch.json`, or add an entry running `npm run dev` on its port; bind `127.0.0.1`).
2. Add a **3D** studio node (toolbar → Studios → 3D). In its editor add a single primitive (a box), give it a distinct material color, and **close the editor without hitting Render**.
3. Add a **Frame** node (toolbar → Add → Frame) and wire the 3D node's output into a Frame `input-*` slot.
4. `read_page` / screenshot the Frame: it must show the box **live**, not blank. (Before this change it is blank until Render, because `beauty_image` is empty.)
5. Re-open the 3D editor, change the box color, close: the Frame layer must reflect the new color **without** a Render/Run.
6. `read_console_messages` — no WebGL "invalid texture source" or context-loss errors.
7. Capture a screenshot for the user (Step 9 of the preview verification workflow).

- [ ] **Step 8: Verify the idle-context guarantee**

Confirm an idle still 3D node holds no WebGL context after its thumbnail settles. In the Browser pane with a single **unwired** still 3D node on the canvas, after ~1s run via `javascript_tool`:

```js
// Count live WebGL contexts by probing the browser's context budget indirectly:
// force GC-independent check — the node should have disposed its headless engine.
performance.now()  // placeholder anchor
```

Practical check: watch `read_console_messages` for the app's own dispose logging if present; otherwise assert behaviorally — add a temporary `console.debug('[scene3d] engine disposed')` in `scheduleEngineRelease`'s dispose branch, confirm it fires ~400 ms after the thumbnail for the unwired node, then remove the debug line before committing. For a node **wired** into an actively-previewing Frame the engine must stay (it is being pulled); for an unwired still node it must dispose.

- [ ] **Step 9: Commit**

```bash
cd frontend && git add app/components/vue-canvas/Scene3DStudioNode.vue
git commit -m "feat(scene3d): still scenes are live Frame layers, Run-free

Register the Scene3D frame source for any renderable scene (not only
animated), reporting duration 0 for stills so a wired Frame pulls them
once and renders client-side at any size — no baked beauty_image, no
paid Render. Replace the registered-keyed engine disposal with an idle
release so an idle 3D node still opens no WebGL context.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** The single gap (still 3D scene registers no frame source → blank/stale in a Frame) is covered by Task 2 registering for any renderable scene, with Task 1 supplying the still-aware clock. The idle-context constraint is covered by `scheduleEngineRelease`. Animated behavior is untouched (the animated branch of `scheduleEngineRelease` returns early; the clock returns the real duration).

**Placeholder scan:** No TBD/TODO/"handle edge cases". The Step 8 `javascript_tool` snippet is intentionally a probe-and-observe verification, not code to keep; it names the concrete alternative (temporary debug log) and its removal.

**Type consistency:** `sceneFrameClock(doc: SceneDoc): SceneFrameClock` defined in Task 1 is consumed verbatim as `getClock: () => sceneFrameClock(sceneDoc.value)` in Task 2. `SceneFrameClock`'s `{ duration, fps, width, height }` matches the `StudioFrameSource` getters (`makeScene3DFrameSource` reads `deps.getClock().{duration,fps,width,height}`). `inFlight`, `releaseTimer`, `scheduleEngineRelease` are declared in Task 2 Step 2 and referenced in Steps 3-5.

## Out of scope (the other three joints — each needs a decision first)

This plan closes the Frame joint for 3D. The three remaining joints from the design discussion are deliberately **not** here, because each has one open decision that should be brainstormed before planning:

1. **Timeline / moves-core mount for 3D** (the motion wedge). Scene3D already has a deep, separate motion system: `ObjectMotion` transform-delta presets (spin/bob/rise/pop) that the shared moves core explicitly excludes (transforms are `animatable: false`), plus path tracks. Open decision: does the 3D move gallery expose only path-track dials, or also wrap the `ObjectMotion` presets as `Move` offers with a custom kind + evaluator (the real prize — a Spin/Bob/Rise gallery for 3D)? This is a design fork, not a bolt-on adapter like Vector Type was.

2. **Palette sharing.** 3D has a private harmony palette on the gradient material only. Open decision: is there (or should there be) a *shared project palette store* that every studio binds to, or does palette stay per-studio with 3D reading a seed source (`seed-palette-engine`)? Likely cross-cutting beyond 3D.

3. **Export / embed parity.** Gradient, Shader, and Space Type have `app/lib/embed/surfaces/*` entries; 3D does not. Open decision: what does a headless 3D embed surface bake (beauty only, or the depth/normal passes too), and does export gain a transparent-WebM route? Needs a read of the embed-surface contract before it can be planned exactly.
