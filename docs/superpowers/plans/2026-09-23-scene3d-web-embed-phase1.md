# 3D Studio on the web — Phase 1 (pre-rendered) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export an animated 3D Studio scene as one self-contained HTML file that plays anywhere, and make an animated wired layer inside an exported Frame play instead of freezing.

**Architecture:** A shared export renderer loads a scene into an engine, waits for every asset (reporting failures by name), hides editor helpers and renders any moment synchronously. The pre-rendered route bakes the loop into WebP frames that a new generic `frames` embed player draws back with `drawImage`. Frame exports gain a `clip` wired entry, baked from the wired slot's live frame source.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, three.js 0.171, vitest (`cd frontend && npx vitest run <file>`), Playwright (`cd frontend && npx playwright test <file>`), the existing embed pipeline (`frontend/app/lib/embed/`).

**Spec:** `docs/superpowers/specs/2026-09-23-scene3d-web-embed-design.md` (Parts 1–4; Part 5 and the picker are Phase 2 — a separate plan).

## Global Constraints

- Work in the main checkout: no worktree, no branch. Never `git stash`, `git add -A`, `git checkout --`, `git restore`, `git reset --hard`. Stage only your own paths.
- Commit with a PRIVATE index in ONE shell call: `GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD; git add -- <paths>; git commit -q -m '<msg>'; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE; git reset -q -- <same paths>`, then `git show --stat HEAD`. The message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never start, stop or restart a dev server. The main checkout's server is `http://127.0.0.1:3002` (use 127.0.0.1, not localhost). If it is not 200, STOP and report.
- UI copy: sentence case, no identifiers; Studio controls only (`StudioSlider`, `StudioSelect`, `StudioSegmentedRow`, `StudioSwitch`, `StudioButton` in `frontend/app/components/vue-canvas/studio/`).
- SFC safety: a `.vue` file that fails to compile for one save kills the dev server's worker permanently. Make each `.vue` change in one valid edit; after it run `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -c <File>` and compare with the count before your edit (baselines today: `CompositorModal.vue` 6, `useCompositorLayers.ts` 3; measure `Scene3DStudioSurface.vue` and `Scene3DStudioNode.vue` before editing).
- Read vitest's "Test Files" line as well as "Tests" — a spec with a syntax error runs zero tests.
- Nothing about the editor changes except what a task states: tracking a load's promise must not change when or how the editor draws.
- An embed export makes no network request: every asset is a `data:` URI; every new bundle is registered in `scripts/build-embed.mjs` and given a size ceiling in `tests/unit/embed-build-output.unit.spec.ts` (`ceilingFor` throws on unknown names).
- Pre-rendered defaults (from the spec): size = the scene's Output size (`doc.output`), option **2× Sharp**; frame rate 30, option 24; one WebP quality (0.82).

## Where this plan departs from the spec (found by reading the code)

1. **Restyle.** 3D Studio's video export renders on the editor's own engine, which already has restyle textures loaded — so video export shows restyle. Only the background engines (the Frame's 3D source, card thumbnails) and a fresh export engine lack them. Task 3 loads restyle into the export engine and the Frame's 3D source; video export only gets the grid fix.
2. **Frame exports keep wired layers wired.** The gatherer does not turn a wired layer into an image layer; it supplies the layer's picture by slot (`snap.wired[slot] = { kind: 'still', dataUrl }`, `lib/embed/frame/gather.ts:192-196`). Task 7 adds a `{ kind: 'clip' }` wired entry instead of a synthetic `ImageClip`.
3. **No cloner Phase for wired layers.** A cloned wired layer shows the same frame on every copy in the editor (one picture per slot per moment); the export matches that. The spec's "including cloner Phase" is dropped.
4. **Every animated wired studio plays, not only 3D.** The clip is baked from the wired slot's live frame source (`StudioFrameSource.getFrame`), which exists for Shader, Gradient, Space Type and 3D alike; restricting it to 3D would cost extra code and keep the others frozen. Frame stage 2 can still upgrade these to live players later.
5. **`sceneLoop` lives in `motion/render.ts`** beside `sceneHasMotion`, not in `exportRender.ts`, so the node, the surface and the export all read one clock without a new import cycle.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/scene3d/motion/render.ts` (modify) | `sceneHasMotion` counts tracks; new `sceneLoop` |
| `frontend/app/lib/scene3d/assetTracker.ts` (create) | Pure: observe load promises, settle until empty, collect named failures |
| `frontend/app/lib/scene3d/engine.ts` (modify) | Observe each async load; `settleAllAssets()` |
| `frontend/app/lib/scene3d/materials.ts` (modify) | A module-level tracker for texture loads |
| `frontend/app/lib/scene3d/exportRender.ts` (create) | `prepareExportEngine`, `renderExportFrame`, `hideEditorHelpers`, `appExportIO` |
| `frontend/app/lib/scene3d/bakeFrames.ts` (create) | `bakeFrameSequence` (pure loop) + `bakeSceneFrames` |
| `frontend/app/lib/embed/surfaces/frames.ts` + `entry-frames.ts` (create) | The generic `frames` embed player |
| `frontend/app/components/vue-canvas/Scene3DWebExportSheet.vue` (create) | The 3D export sheet |
| `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (modify) | Footer "Export embed…", the sheet, the export action; video export on `renderExportFrame` |
| `frontend/app/components/vue-canvas/Scene3DStudioNode.vue` (modify) | Frame 3D source on the export path |
| `frontend/app/lib/embed/frame/{types,plan,gather,appIO}.ts`, `lib/embed/surfaces/frame.ts`, `CompositorModal.vue` (modify) | Wired clips in Frame exports |

---

### Task 1: A tracks-only scene counts as animated, and one loop clock

**Files:**
- Modify: `frontend/app/lib/scene3d/motion/render.ts:13-36`
- Test: `frontend/tests/unit/scene3d-motion.unit.spec.ts` (append)

**Interfaces:**
- Produces: `sceneLoop(doc: SceneDoc): { animated: boolean; duration: number; fps: number }` exported from `~/lib/scene3d/motion/render`. `sceneHasMotion` now also returns true when any `doc.motion.tracks` entry has `from !== to`.

- [ ] **Step 1: Write the failing tests** (append to `scene3d-motion.unit.spec.ts`; read its top for the doc-building helper it already uses — build docs with `defaultDoc()` from `~/lib/scene3d/config` if there is none):

```ts
import { sceneHasMotion, sceneFrameClock, sceneLoop } from '~/lib/scene3d/motion/render'
import { defaultDoc } from '~/lib/scene3d/config'

describe('a scene animated only by keyframe tracks', () => {
  const track = (from: number, to: number) => ({ path: 'camera.fov', from, to, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })
  it('counts as motion when a track moves', () => {
    const doc = defaultDoc()
    doc.motion = { ...doc.motion, tracks: [track(30, 60) as any] }
    expect(sceneHasMotion(doc)).toBe(true)
    expect(sceneFrameClock(doc).duration).toBe(doc.motion.duration)
  })
  it('a track that goes nowhere is not motion', () => {
    const doc = defaultDoc()
    doc.motion = { ...doc.motion, tracks: [track(40, 40) as any] }
    expect(sceneHasMotion(doc)).toBe(false)
  })
})

describe('sceneLoop', () => {
  it('an animated scene loops for its motion duration at its fps', () => {
    const doc = defaultDoc()
    doc.motion = { ...doc.motion, duration: 3, fps: 24, tracks: [{ path: 'camera.fov', from: 30, to: 60, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 } as any] }
    expect(sceneLoop(doc)).toEqual({ animated: true, duration: 3, fps: 24 })
  })
  it('a still scene reports animated false and duration 0', () => {
    expect(sceneLoop(defaultDoc())).toMatchObject({ animated: false, duration: 0 })
  })
})
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run tests/unit/scene3d-motion.unit.spec.ts` — FAIL (`sceneLoop` not exported; first case false).

- [ ] **Step 3: Implement** in `render.ts`:

```ts
export function sceneHasMotion(doc: SceneDoc): boolean {
  for (const o of doc.objects) {
    if (o.kind === 'light' || o.kind === 'decal') continue
    const m = o.motion
    if (m && ((m.loop && m.loop.kind !== 'none') || m.in || m.out)) return true
  }
  // Keyframe tracks animate too: a scene moved only by tracks used to export as a still.
  if ((doc.motion.tracks ?? []).some(t => t.from !== t.to)) return true
  return !!(doc.camera.motion && doc.camera.motion.preset !== 'none')
}

/** The one answer to "how long is this scene's loop" — the export, the node's frame source and
 *  the surface all read it. A still scene is `{ animated: false, duration: 0 }`. */
export function sceneLoop(doc: SceneDoc): { animated: boolean; duration: number; fps: number } {
  const animated = sceneHasMotion(doc)
  return { animated, duration: animated ? doc.motion.duration : 0, fps: doc.motion.fps }
}
```

Leave `sceneFrameClock` as it is (it already calls `sceneHasMotion`).

- [ ] **Step 4: Run** the spec, then `npm run test:unit -- scene3d` — all green, "Test Files" read.
- [ ] **Step 5: Commit** `fix(scene3d): a scene moved only by keyframe tracks is animated, not a still; sceneLoop is the one loop clock`

---

### Task 2: Wait for every asset, and name the ones that fail

**Files:**
- Create: `frontend/app/lib/scene3d/assetTracker.ts`
- Modify: `frontend/app/lib/scene3d/engine.ts` (load sites at ~829 HDRI, ~1221 text font, ~1252 mesh, ~1438 model, ~1655 decals; `settleAsyncAssets` ~1685), `frontend/app/lib/scene3d/materials.ts` (texture loads at ~178, ~249, ~526, ~1161)
- Test: `frontend/tests/unit/scene3d-asset-tracker.unit.spec.ts` (create)

**Interfaces:**
- Produces:
  - `type AssetKind = 'model' | 'font' | 'mesh' | 'hdri' | 'texture' | 'decal' | 'restyle'`
  - `interface AssetFailure { kind: AssetKind; name: string; reason: string }`
  - `class AssetTracker { observe(kind, name, p: Promise<unknown>): void; fail(kind, name, err: unknown): void; settle(maxRounds?: number): Promise<AssetFailure[]>; get pending(): number; clearFailures(): void }`
  - `textureLoads: AssetTracker` exported from `~/lib/scene3d/materials`
  - `SceneEngine.settleAllAssets(): Promise<AssetFailure[]>` — awaits the engine's tracker, `textureLoads` and `pendingDecals` until all are empty, returns the failures seen since the engine was created.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/scene3d-asset-tracker.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { AssetTracker } from '~/lib/scene3d/assetTracker'

const later = <T>(v: T, ms = 5) => new Promise<T>(r => setTimeout(() => r(v), ms))
const failLater = (msg: string, ms = 5) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))

describe('AssetTracker', () => {
  it('settle waits for every observed load', async () => {
    const t = new AssetTracker()
    let done = 0
    t.observe('model', 'a.glb', later(1).then(() => { done++ }))
    t.observe('hdri', 'studio', later(2, 15).then(() => { done++ }))
    expect(t.pending).toBe(2)
    expect(await t.settle()).toEqual([])
    expect(done).toBe(2)
    expect(t.pending).toBe(0)
  })
  it('a load started while settling is waited for too (a model starts its textures)', async () => {
    const t = new AssetTracker()
    let nested = false
    t.observe('model', 'a.glb', later(0).then(() => {
      t.observe('texture', 'wood.jpg', later(0, 10).then(() => { nested = true }))
    }))
    await t.settle()
    expect(nested).toBe(true)
  })
  it('a failed load is reported by kind and name with its reason', async () => {
    const t = new AssetTracker()
    t.observe('model', 'Sneaker', failLater('HTTP 403'))
    const failures = await t.settle()
    expect(failures).toEqual([{ kind: 'model', name: 'Sneaker', reason: 'HTTP 403' }])
  })
  it('fail() records a failure a site swallowed', async () => {
    const t = new AssetTracker()
    t.fail('font', 'google:Inter@700', new Error('offline'))
    expect(await t.settle()).toEqual([{ kind: 'font', name: 'google:Inter@700', reason: 'offline' }])
  })
  it('observing never raises an unhandled rejection of its own', async () => {
    const t = new AssetTracker()
    const p = failLater('x')
    p.catch(() => {})             // the site handles its own promise
    t.observe('mesh', 'm1', p)
    await t.settle()              // no throw
  })
  it('settle gives up after maxRounds rather than hanging on a load that keeps re-arming', async () => {
    const t = new AssetTracker()
    const arm = (): void => { t.observe('texture', 'loop', later(0).then(arm)) }
    arm()
    await t.settle(3)
    expect(t.pending).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run tests/unit/scene3d-asset-tracker.unit.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** `assetTracker.ts`:

```ts
// Asset settling for export (spec Part 1). The engine starts every asset load without waiting and
// draws a placeholder meanwhile; an export must instead wait for all of them, and must say which
// one failed rather than bake a placeholder. Pure — no three.js — so it is unit-tested alone.

export type AssetKind = 'model' | 'font' | 'mesh' | 'hdri' | 'texture' | 'decal' | 'restyle'
export interface AssetFailure { kind: AssetKind; name: string; reason: string }

const reasonOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'failed to load'

export class AssetTracker {
  private readonly inFlight = new Set<Promise<void>>()
  private failures: AssetFailure[] = []

  /** Watch a load. Never changes the caller's promise; records a failure if it rejects. */
  observe(kind: AssetKind, name: string, p: Promise<unknown>): void {
    const settled: Promise<void> = p.then(
      () => undefined,
      (err) => { this.failures.push({ kind, name, reason: reasonOf(err) }) },
    )
    this.inFlight.add(settled)
    void settled.finally(() => this.inFlight.delete(settled))
  }

  /** Record a failure a site handled (and swallowed) itself. */
  fail(kind: AssetKind, name: string, err: unknown): void {
    this.failures.push({ kind, name, reason: reasonOf(err) })
  }

  /** Wait until nothing is in flight (loads may start more loads), up to `maxRounds` rounds. */
  async settle(maxRounds = 20): Promise<AssetFailure[]> {
    for (let r = 0; r < maxRounds && this.inFlight.size; r++) await Promise.all([...this.inFlight])
    return [...this.failures]
  }

  get pending(): number { return this.inFlight.size }
  clearFailures(): void { this.failures = [] }
}
```

- [ ] **Step 4: Run** the spec — green.

- [ ] **Step 5: Wire the engine.** In `engine.ts` add `readonly assets = new AssetTracker()` on `SceneEngine`. At each load site, observe the promise that **completes after the site's own handling has run** (so settle waits until the model is actually in the scene, not merely downloaded), and if the site catches and swallows an error, call `this.assets.fail(kind, name, err)` inside that catch. Read each site first; the pattern is:

```ts
// before:  loadGlb(obj.url).then((g) => { …attach… })
// after:
this.assets.observe('model', displayNameFor(obj), loadGlb(obj.url).then((g) => { …attach… }))
```

  Names are what a person recognises: a model's object name (fall back to the URL's last path segment), a font's token, an HDRI's slug, a mesh's object name, a decal's object name. Sites: HDRI (`loadHdriEquirect(slug).then` ~829), text font (`loadFont(url).then` ~1221), mesh (`loadMesh(encoded, key).then` ~1252), model (`loadGlb(obj.url).then` ~1438). Decals already have `pendingDecals`; leave them, and record a decal failure through `this.assets.fail('decal', …)` where the decal build's rejection is handled.

  In `materials.ts` add `export const textureLoads = new AssetTracker()` and, at each image-texture load (`new THREE.TextureLoader().load(url, onLoad, undefined, onError)` ~178, ~526, ~1161, and the relief `new Image()` ~249), observe a promise that resolves in `onLoad` and rejects in `onError`, named by the filename. The existing `onTextureError` broadcast stays as it is.

  Add to `SceneEngine`:

```ts
/** Export only: wait for every asset this engine (and the shared texture cache) is loading,
 *  including decals, until nothing is left in flight. Returns every failure seen. */
async settleAllAssets(): Promise<AssetFailure[]> {
  for (let round = 0; round < 20; round++) {
    const busy = this.assets.pending + textureLoads.pending + this.pendingDecals.size
    if (!busy) break
    await Promise.all([this.assets.settle(1), textureLoads.settle(1), this.settleAsyncAssets()])
  }
  const texFailures = await textureLoads.settle(0)
  const own = await this.assets.settle(0)
  return [...own, ...texFailures]
}
```

- [ ] **Step 6: Prove the editor is unchanged and the wiring works.** Run `npm run test:unit -- scene3d` (all green, count "Test Files"). Then on `http://127.0.0.1:3002` (never start a server), open a 3D Studio scene with a model, an HDRI and an image texture in the built-in browser pane (`mcp__Claude_Browser__*`; `resize_window` 1440×900 first), and in the page run `const e = /* the modal engine: find the dev hook the surface exposes, e.g. window.__scene3dEngine, or read Scene3DStudioSurface.vue for one */; await e.settleAllAssets()` and report the result (expect `[]`), and that the scene looks the same as before your change (screenshot before/after).
- [ ] **Step 7: Commit** `feat(scene3d): the engine can wait for every asset it is loading and name any that failed`

---

### Task 3: The shared export renderer; video export and the Frame's 3D source use it

**Files:**
- Create: `frontend/app/lib/scene3d/exportRender.ts`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (`bakeSceneVideo` ~553-620: `renderMotionFrame` → `renderExportFrame`), `frontend/app/components/vue-canvas/Scene3DStudioNode.vue` (`renderAt` ~135-146)
- Test: `frontend/tests/unit/scene3d-export-render.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `SceneEngine.settleAllAssets()`, `AssetFailure` (Task 2); `sceneLoop` (Task 1); `collectEditorHelpers(scene)` from `~/lib/scene3d/passes`; `SceneEngine.setRestyleTextures(Map<string, THREE.Texture>)`.
- Produces:
  - `interface ExportIO { loadRestyle(resultRef: string): Promise<THREE.Texture> }`
  - `appExportIO: ExportIO` — loads `restyleViewUrl(name)` with `THREE.TextureLoader`, sets `colorSpace = THREE.NoColorSpace` (the editor's own rule, `Scene3DStudioSurface.vue` ~2269-2278; find `restyleViewUrl` there or in `lib/scene3d/` and import it rather than re-deriving the URL)
  - `restyleRefs(doc: SceneDoc): string[]` — every non-empty `resultRef` of an `aiRestyle` treatment on any object
  - `prepareExportEngine(doc, opts: { width: number; height: number; io: ExportIO }): Promise<{ engine: SceneEngine; failures: AssetFailure[] }>`
  - `hideEditorHelpers(engine: SceneEngine): void` — `engine.grid.visible = false` and every `collectEditorHelpers(engine.scene)` entry hidden
  - `renderExportFrame(engine: SceneEngine, doc: SceneDoc, t01: number): HTMLCanvasElement`

- [ ] **Step 1: Failing tests** for the pure part:

```ts
// frontend/tests/unit/scene3d-export-render.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { restyleRefs } from '~/lib/scene3d/exportRender'
import { defaultDoc } from '~/lib/scene3d/config'

describe('restyleRefs', () => {
  it('lists every restyle result the scene points at, once each, skipping empty ones', () => {
    const doc = defaultDoc()
    const o = doc.objects[0] as any
    o.treatments = [
      { id: 't1', kind: 'aiRestyle', resultRef: 'restyle_a.png' },
      { id: 't2', kind: 'aiRestyle', resultRef: '' },
      { id: 't3', kind: 'blur' },
    ]
    const o2 = { ...o, id: 'o2', treatments: [{ id: 't4', kind: 'aiRestyle', resultRef: 'restyle_a.png' }] }
    doc.objects.push(o2)
    expect(restyleRefs(doc)).toEqual(['restyle_a.png'])
  })
  it('no restyle → empty', () => { expect(restyleRefs(defaultDoc())).toEqual([]) })
})
```

  Adjust the treatment literal to the real `aiRestyle` treatment shape in `lib/scene3d/treatments.ts` (read it) — the assertion stays.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `exportRender.ts`:

```ts
// The shared export renderer (spec Part 1). Everything that turns a saved scene into export
// pixels goes through here: the pre-rendered bake, the Frame's 3D source and 3D Studio's video
// export — so a fix to "what an exported frame looks like" lands everywhere at once.
import * as THREE from 'three'
import { SceneEngine } from '~/lib/scene3d/engine'
import type { SceneDoc } from '~/lib/scene3d/config'
import { collectEditorHelpers } from '~/lib/scene3d/passes'
import { applyMotionToDoc } from '~/lib/scene3d/motion/apply'
import { renderMotionFrame, sceneLoop } from '~/lib/scene3d/motion/render'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'

export interface ExportIO { loadRestyle(resultRef: string): Promise<THREE.Texture> }

export function restyleRefs(doc: SceneDoc): string[] {
  const out = new Set<string>()
  for (const o of doc.objects) for (const t of (o as { treatments?: Array<{ kind: string; resultRef?: string }> }).treatments ?? []) {
    if (t.kind === 'aiRestyle' && t.resultRef) out.add(t.resultRef)
  }
  return [...out]
}

export function hideEditorHelpers(engine: SceneEngine): void {
  engine.grid.visible = false
  for (const h of collectEditorHelpers(engine.scene)) h.visible = false
}

export async function prepareExportEngine(
  doc: SceneDoc, opts: { width: number; height: number; io: ExportIO },
): Promise<{ engine: SceneEngine; failures: AssetFailure[] }> {
  const canvas = document.createElement('canvas')
  const engine = new SceneEngine(canvas, opts.width, opts.height)
  engine.renderer.setPixelRatio(1)              // export pixels are device pixels (spec)
  engine.setSize(opts.width, opts.height)
  const { doc: sampled } = applyMotionToDoc(doc, 0)
  engine.syncFromDoc(sampled)
  const restyles = new Map<string, THREE.Texture>()
  const restyleFailures: AssetFailure[] = []
  await Promise.all(restyleRefs(doc).map(async (ref) => {
    try { restyles.set(ref, await opts.io.loadRestyle(ref)) }
    catch (err) { restyleFailures.push({ kind: 'restyle', name: ref, reason: err instanceof Error ? err.message : 'failed to load' }) }
  }))
  engine.setRestyleTextures(restyles)
  const failures = [...(await engine.settleAllAssets()), ...restyleFailures]
  return { engine, failures }
}

/** The exact frame at `t01`, drawn synchronously, editor helpers hidden, film grain moving. */
export function renderExportFrame(engine: SceneEngine, doc: SceneDoc, t01: number): HTMLCanvasElement {
  // renderMotionFrame syncs (which re-shows the grid for shadow/reflection floors), so hide the
  // helpers after its sync and before its render: render once through it, then re-render.
  // Cheaper alternative the implementer should prefer if it is clean: give renderMotionFrame an
  // optional `beforeRender(engine)` hook and an `elapsedSec` so the frame is drawn once.
  return renderMotionFrame(engine, doc, t01, {
    beforeRender: hideEditorHelpers,
    elapsedSec: t01 * Math.max(0, sceneLoop(doc).duration),
  })
}
```

  and extend `renderMotionFrame` in `motion/render.ts` with an optional third-and-a-half argument — `opts?: { beforeRender?: (e: SceneEngine) => void; elapsedSec?: number }` — calling `opts?.beforeRender?.(engine)` just before `engine.render(opts?.elapsedSec ?? 0)`. Existing callers pass nothing and are byte-identical.

  `appExportIO` goes in the same file:

```ts
export const appExportIO: ExportIO = {
  loadRestyle: (name) => new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(restyleViewUrl(name), (tex) => {
      tex.colorSpace = THREE.NoColorSpace   // sampled raw — see Scene3DStudioSurface's restyle load
      resolve(tex)
    }, undefined, reject)
  }),
}
```

- [ ] **Step 4: Migrate the two callers.**
  - `bakeSceneVideo` (both `drawFrame` and the `serverFallback` `renderFrame`): `renderMotionFrame(engine!, doc, …)` → `renderExportFrame(engine!, doc, …)`. Its `finally` already re-syncs the doc, which re-shows the grid for the editor.
  - `Scene3DStudioNode.vue` `renderAt`: after `ensureHeadless(w, h)`, on first use per engine load the restyle textures through `appExportIO` into `eng.setRestyleTextures(...)` (cache per engine; reload when `restyleRefs(doc)` changes), then `await eng.settleAllAssets()` and `return renderExportFrame(eng, sceneDoc.value, t01)` instead of `renderMotionFrameSettled`. Keep `inFlight` / `scheduleEngineRelease` exactly as they are.

- [ ] **Step 5: Run** the spec, `npm run test:unit -- scene3d`, and the vue-tsc counts for both SFCs (no new errors).

- [ ] **Step 6: Confirm by eye** (the spec's two unverified claims), on `http://127.0.0.1:3002`: a 3D scene with the default `shadow` floor — (a) before/after: a video export frame (use the surface's export path or call `renderExportFrame` in-page on the modal engine) no longer shows the floor grid; (b) a Frame with this scene wired in, where an object has a restyle treatment — the Frame's preview now shows the restyle. Report both with screenshots or pixel reads; if (a) shows the grid was *not* present before, say so plainly.

- [ ] **Step 7: Commit** `feat(scene3d): one export renderer — waits for every asset, hides editor helpers, loads restyle; video export and the Frame's 3D source use it`

---

### Task 4: Bake a scene's loop into WebP frames

**Files:**
- Create: `frontend/app/lib/scene3d/bakeFrames.ts`
- Test: `frontend/tests/unit/scene3d-bake-frames.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `prepareExportEngine`, `renderExportFrame`, `appExportIO`, `ExportIO` (Task 3); `sceneLoop` (Task 1); `AssetFailure` (Task 2).
- Produces:
  - `bakeFrameSequence(opts: { count: number; renderAt(t01: number): HTMLCanvasElement | Promise<HTMLCanvasElement>; encode(c: HTMLCanvasElement): Promise<string>; onProgress?(done: number, total: number): void; signal?: AbortSignal }): Promise<string[]>` — pure frame loop: `t01 = i / count` for `i` in `0..count-1`.
  - `frameCountFor(loop: { animated: boolean; duration: number }, fps: number): number` — `animated ? max(1, round(duration × fps)) : 1`.
  - `interface SceneBakeResult { frames: string[]; fps: number; duration: number; width: number; height: number; failures: AssetFailure[] }`
  - `bakeSceneFrames(doc, opts: { width: number; height: number; fps: 24 | 30; transparent: boolean; cinematic?: { samples: number }; io?: ExportIO; onProgress?; signal? }): Promise<SceneBakeResult>` — returns early with `frames: []` and the failures when any asset failed.

- [ ] **Step 1: Failing tests**

```ts
// frontend/tests/unit/scene3d-bake-frames.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { bakeFrameSequence, frameCountFor } from '~/lib/scene3d/bakeFrames'

const fakeCanvas = (tag: string) => ({ tag }) as unknown as HTMLCanvasElement

describe('frameCountFor', () => {
  it('an animated loop is duration × fps frames', () => { expect(frameCountFor({ animated: true, duration: 4 }, 30)).toBe(120) })
  it('rounds, and never goes below one', () => { expect(frameCountFor({ animated: true, duration: 0.01 }, 30)).toBe(1) })
  it('a still scene is one frame', () => { expect(frameCountFor({ animated: false, duration: 0 }, 30)).toBe(1) })
})

describe('bakeFrameSequence', () => {
  it('renders t = i / count for each frame, in order, and encodes each', async () => {
    const seen: number[] = []
    const frames = await bakeFrameSequence({
      count: 4,
      renderAt: (t) => { seen.push(t); return fakeCanvas(String(t)) },
      encode: async (c) => `data:image/webp;base64,${(c as any).tag}`,
    })
    expect(seen).toEqual([0, 0.25, 0.5, 0.75])
    expect(frames).toEqual(['data:image/webp;base64,0', 'data:image/webp;base64,0.25', 'data:image/webp;base64,0.5', 'data:image/webp;base64,0.75'])
  })
  it('reports progress after each frame', async () => {
    const progress: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: () => fakeCanvas('x'), encode: async () => 'd', onProgress: (d, t) => progress.push(`${d}/${t}`) })
    expect(progress).toEqual(['1/2', '2/2'])
  })
  it('stops between frames when aborted', async () => {
    const ac = new AbortController()
    let rendered = 0
    const p = bakeFrameSequence({ count: 10, renderAt: () => { rendered++; if (rendered === 2) ac.abort(); return fakeCanvas('x') }, encode: async () => 'd', signal: ac.signal })
    await expect(p).rejects.toThrow(/abort/i)
    expect(rendered).toBe(2)
  })
  it('encodes each frame before rendering the next (the canvas is reused)', async () => {
    const order: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: (t) => { order.push(`r${t}`); return fakeCanvas('x') }, encode: async () => { order.push('e'); return 'd' } })
    expect(order).toEqual(['r0', 'e', 'r0.5', 'e'])
  })
})
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `bakeFrames.ts`:

```ts
// The pre-rendered route's bake (spec Part 2): render the scene's loop through the shared export
// renderer and keep each frame as a WebP data URI. The loop itself is pure (renderAt/encode are
// injected) so its ordering, progress and cancelling are unit-tested without a GPU.
import type { SceneDoc } from '~/lib/scene3d/config'
import { sceneLoop } from '~/lib/scene3d/motion/render'
import { prepareExportEngine, renderExportFrame, appExportIO, type ExportIO } from '~/lib/scene3d/exportRender'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'

export const WEBP_QUALITY = 0.82

export function frameCountFor(loop: { animated: boolean; duration: number }, fps: number): number {
  return loop.animated ? Math.max(1, Math.round(loop.duration * fps)) : 1
}

export async function bakeFrameSequence(opts: {
  count: number
  renderAt(t01: number): HTMLCanvasElement | Promise<HTMLCanvasElement>
  encode(c: HTMLCanvasElement): Promise<string>
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < opts.count; i++) {
    if (opts.signal?.aborted) throw new DOMException('Bake aborted', 'AbortError')
    const canvas = await opts.renderAt(i / opts.count)
    out.push(await opts.encode(canvas))            // before the next render reuses the canvas
    opts.onProgress?.(i + 1, opts.count)
  }
  return out
}

export function encodeWebp(canvas: HTMLCanvasElement, quality = WEBP_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not encode a frame'))
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error ?? new Error('Could not read a frame'))
      r.readAsDataURL(blob)
    }, 'image/webp', quality)
  })
}

export interface SceneBakeResult { frames: string[]; fps: number; duration: number; width: number; height: number; failures: AssetFailure[] }

export async function bakeSceneFrames(doc: SceneDoc, opts: {
  width: number; height: number; fps: 24 | 30; transparent: boolean
  cinematic?: { samples: number }
  io?: ExportIO
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}): Promise<SceneBakeResult> {
  const loop = sceneLoop(doc)
  const bakeDoc = opts.transparent ? { ...doc, background: 'transparent' as const } : doc
  const { engine, failures } = await prepareExportEngine(bakeDoc, { width: opts.width, height: opts.height, io: opts.io ?? appExportIO })
  try {
    const base = { fps: opts.fps, duration: loop.duration, width: opts.width, height: opts.height }
    if (failures.length) return { ...base, frames: [], failures }
    if (opts.cinematic) await engine.setCinematic(true)
    const frames = await bakeFrameSequence({
      count: frameCountFor(loop, opts.fps),
      renderAt: (t01) => {
        if (!opts.cinematic) return renderExportFrame(engine, bakeDoc, t01)
        // Path-traced: sync the frame's pose, restart accumulation, then add samples.
        renderExportFrame(engine, bakeDoc, t01)      // poses the scene (one sample)
        engine.cinematicReset()
        for (let s = 0; s < opts.cinematic.samples; s++) engine.render()
        return engine.renderer.domElement as HTMLCanvasElement
      },
      encode: c => encodeWebp(c),
      onProgress: opts.onProgress,
      signal: opts.signal,
    })
    return { ...base, frames, failures: [] }
  } finally {
    engine.dispose()
  }
}
```

  Read `SceneEngine.setCinematic` / `cinematicReset` / `cinematicStatus` (`engine.ts` ~1019-1081) before relying on the cinematic branch: `setCinematic` is async (it compiles), and each `render()` adds one sample. If the path tracer needs a pose change to be pushed with `cinematicRefresh` rather than a reset, use what the engine does for a camera move. Measure one cinematic frame's time at 64 samples and report it.

- [ ] **Step 4: Run** the spec — green. Then in the built-in browser on `http://127.0.0.1:3002`, import `/_nuxt/lib/scene3d/bakeFrames.ts` in-page with a scene doc from an open 3D Studio node, bake 256×256 at 24 fps, and report: frame count = `round(duration × 24)`, each frame a `data:image/webp` URI, the total bytes, and that two frames at different t differ.
- [ ] **Step 5: Commit** `feat(scene3d): bake a scene's loop into WebP frames through the export renderer`

---

### Task 5: The `frames` embed player

**Files:**
- Create: `frontend/app/lib/embed/surfaces/frames.ts`, `frontend/app/lib/embed/entry-frames.ts`
- Modify: `frontend/app/lib/embed/surfaces.ts` (REGISTRY), `frontend/scripts/build-embed.mjs` (`expectedOutputs` and a `runBuild('frames')`), `frontend/vite.embed.config.ts` (read how an entry name maps to `entry-<surface>.ts`; add nothing if it is generic), `frontend/tests/unit/embed-build-output.unit.spec.ts` (a `FRAMES_CEILING_BYTES` and a `ceilingFor` line)
- Test: `frontend/tests/unit/embed-frames-surface.unit.spec.ts` (create); `frontend/tests/embed-frames.spec.ts` (Playwright, create)

**Interfaces:**
- Produces: `interface FramesEmbedConfig { frames: string[]; fps: number; width: number; height: number }`; default export `framesSurface: EmbedSurface` with `kind: 'frames'`, `caps: { alpha: true }`; `frameIndexAt(t01: number, count: number): number` exported for tests.

- [ ] **Step 1: Failing unit tests** (happy-dom; stub `Image` so `onload` fires):

```ts
// @vitest-environment happy-dom
// frontend/tests/unit/embed-frames-surface.unit.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import surface, { frameIndexAt } from '~/lib/embed/surfaces/frames'

describe('frameIndexAt', () => {
  it('maps the loop position onto the frames, never past the last', () => {
    expect(frameIndexAt(0, 4)).toBe(0)
    expect(frameIndexAt(0.24, 4)).toBe(0)
    expect(frameIndexAt(0.25, 4)).toBe(1)
    expect(frameIndexAt(0.999, 4)).toBe(3)
    expect(frameIndexAt(1, 4)).toBe(0)          // the loop wraps
    expect(frameIndexAt(-0.1, 4)).toBe(0)
    expect(frameIndexAt(NaN, 4)).toBe(0)
  })
})

describe('the frames player', () => {
  let drawn: unknown[]
  beforeEach(() => {
    drawn = []
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; naturalWidth = 8; naturalHeight = 8
      set src(v: string) { (this as any)._src = v; queueMicrotask(() => this.onload?.()) } get src() { return (this as any)._src } })
    HTMLCanvasElement.prototype.getContext = function () {
      return { clearRect() {}, drawImage: (img: any) => { drawn.push(img.src) }, setTransform() {} } as any
    } as any
  })
  const cfg = { frames: ['data:image/webp;base64,A', 'data:image/webp;base64,B', 'data:image/webp;base64,C'], fps: 30, width: 8, height: 8 }

  it('leaves a canvas in the container and draws frame 0 on mount', async () => {
    const box = document.createElement('div')
    await surface.mount(box, cfg)
    expect(box.querySelector('canvas')).toBeTruthy()
    expect(drawn.at(-1)).toBe('data:image/webp;base64,A')
  })
  it('setTime draws the right frame synchronously', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.setTime(0.5)
    expect(drawn.at(-1)).toBe('data:image/webp;base64,B')
    h.setTime(0.9)
    expect(drawn.at(-1)).toBe('data:image/webp;base64,C')
  })
  it('setSize resizes the canvas to the device pixels it is given and redraws', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.setTime(0.9); drawn.length = 0
    h.setSize(200, 100)
    const c = box.querySelector('canvas')!
    expect([c.width, c.height]).toEqual([200, 100])
    expect(drawn.at(-1)).toBe('data:image/webp;base64,C')
  })
  it('destroy removes the canvas', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.destroy()
    expect(box.querySelector('canvas')).toBeNull()
  })
  it('refuses an empty or malformed config instead of drawing nothing', async () => {
    await expect(surface.mount(document.createElement('div'), { ...cfg, frames: [] })).rejects.toThrow()
    await expect(surface.mount(document.createElement('div'), { ...cfg, frames: ['https://x/y.webp'] })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `frames.ts`:

```ts
// A generic "play these frames" embed player (spec Part 2). Knows nothing about 3D — any studio
// that can pre-render its loop can use it. Each frame stays a compressed image and the browser
// decodes it when it is drawn (the same pattern Frame clips use), so a long loop never holds
// every decoded frame in memory; drawImage is synchronous, so setTime always draws the exact frame.
import type { EmbedHandle, EmbedSurface } from '../contract'

export interface FramesEmbedConfig { frames: string[]; fps: number; width: number; height: number }

export function frameIndexAt(t01: number, count: number): number {
  if (!(count > 0) || !Number.isFinite(t01)) return 0
  const wrapped = ((t01 % 1) + 1) % 1
  return Math.min(count - 1, Math.floor(wrapped * count))
}

function loadFrame(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('embed: a frame failed to decode'))
    img.src = src
  })
}

function validate(config: unknown): FramesEmbedConfig {
  const c = config as FramesEmbedConfig
  if (!c || !Array.isArray(c.frames) || c.frames.length === 0) throw new Error('embed: no frames to play')
  if (!c.frames.every(f => typeof f === 'string' && f.startsWith('data:'))) throw new Error('embed: every frame must be inlined')
  if (!(c.width > 0) || !(c.height > 0)) throw new Error('embed: frames need a size')
  return c
}

const surface: EmbedSurface = {
  kind: 'frames',
  caps: { alpha: true },
  async mount(container, config): Promise<EmbedHandle> {
    const cfg = validate(config)
    const images = await Promise.all(cfg.frames.map(loadFrame))
    const canvas = document.createElement('canvas')
    canvas.width = cfg.width
    canvas.height = cfg.height
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('embed: no 2D context')
    container.appendChild(canvas)
    let current = 0
    const draw = (i: number) => {
      current = i
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(images[i]!, 0, 0, canvas.width, canvas.height)
    }
    draw(0)
    return {
      setTime(t01) { draw(frameIndexAt(t01, images.length)) },
      setSize(w, h) {
        const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
        if (canvas.width !== W) canvas.width = W
        if (canvas.height !== H) canvas.height = H
        draw(current)
      },
      destroy() { canvas.remove(); images.length = 0 },
    }
  },
}
export default surface
```

  Aspect: the runtime already fits the stage to the snapshot's `width`/`height` (`framing` defaults to contain), so drawing into the whole canvas is correct; confirm by reading `bundle.ts` `fit()` and say so in your report.

  `entry-frames.ts` mirrors `entry-shader.ts` (read it): assign the default export to `globalThis.__SAILOR_SURFACE__`. Add `frames: () => import('./surfaces/frames')` to `REGISTRY`. Add `'frames.js'` to `expectedOutputs` and `runBuild('frames')` beside `runBuild('shader')` in `build-embed.mjs`. Add `const FRAMES_CEILING_BYTES = 20_000` and `if (fileName === 'frames.js') return FRAMES_CEILING_BYTES` — then run `node scripts/build-embed.mjs` **only if the build cache would otherwise be stale for the test** (it runs before `dev`; do NOT run `npm run dev`), measure `public/embed/frames.js`, and set the ceiling to the measurement × 1.15 rounded up to the next 1,000 (the file's own rule, adapted to the small size).

- [ ] **Step 4: Run** the unit spec and `npx vitest run tests/unit/embed-build-output.unit.spec.ts tests/unit/embed-registry.unit.spec.ts` — green.
- [ ] **Step 5: Playwright** `tests/embed-frames.spec.ts`, modelled on `tests/embed-network.spec.ts` and `tests/embed-contract.spec.ts` (read both; reuse their serving and recording helpers): build an export with `exportEmbedHtml({ kind: 'frames', config: { frames: [three distinct solid-colour 16×16 WebP data URIs], fps: 3, width: 16, height: 16 }, duration: 1, width: 16, height: 16 })`, serve it from the fake origin, and assert: no request and no websocket; the canvas pixel at t≈0.1 is colour 1 and at t≈0.7 is colour 3 (drive time with the runtime's freeze hook `__SAILOR_FREEZE_T01__` the existing specs use); `recordEmbed` over it yields three distinct frames. Run `npx playwright test tests/embed-frames.spec.ts`.
- [ ] **Step 6: Commit** `feat(embed): a generic frames player — plays pre-rendered frames, draws the exact frame synchronously`

---

### Task 6: Export a 3D scene as a web embed

**Files:**
- Create: `frontend/app/components/vue-canvas/Scene3DWebExportSheet.vue`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (footer `downloads` ~5923-5929; a new `exportWebEmbed` action; the sheet)
- Test: `frontend/tests/unit/scene3d-web-export-sheet.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `bakeSceneFrames`, `SceneBakeResult` (Task 4); `exportEmbedHtml`, `downloadEmbed` (`lib/embed/export.ts`); `embedSnippet` (`lib/embed/snippet.ts`); `sceneLoop` (Task 1); `cinematicScopeWarning(doc)` (`lib/scene3d/pathtrace/scope`).
- Produces: `Scene3DWebExportSheet` props `{ state: 'idle' | 'working' | 'ready' | 'blocked' | 'error'; progress?: { done: number; total: number }; size: 'output' | 'sharp'; fps: 24 | 30; cinematic: boolean; transparent: boolean; still: boolean; bytes: number; failures: AssetFailure[]; cinematicWarning?: string; outputSize: { width: number; height: number }; errorText?: string; copyStatus?: 'copied' | 'failed' | null; snippet?: string }`, emits `update:size`, `update:fps`, `update:cinematic`, `update:transparent`, `build`, `cancel`, `download`, `copy`, `close`.

**The sheet's content** (sentence case; modelled on `FrameWebExportSheet.vue` — read it and reuse its layout, classes and footer buttons):
- Title "Export embed". A line "One file · plays anywhere · {size}" once built.
- **Size** `StudioSegmentedRow` — "Output · {W}×{H}" and "2× sharp · {2W}×{2H}", with the hint "Sharp looks crisper on high-resolution screens and makes the file about four times bigger."
- **Frame rate** `StudioSegmentedRow` — "30 fps", "24 fps".
- **Cinematic** `StudioSwitch` — hint "Path-traced, like the Cinematic view. Much slower to export." When on and `cinematicWarning` is set, show it under the switch.
- **Transparent background** `StudioSwitch`.
- While working: "Rendering frame {done} of {total}" and a **Cancel** button.
- `failures`: a "Can't export yet" group, one line per failure, written as `{kind label} "{name}" couldn't load — {reason}`. For a model: add "Re-generate or re-upload it."
- A still scene: the line "This scene doesn't move, so it exports as a single picture."
- Buttons: **Copy embed code**, **Download** (both disabled until built), **Close**. Changing an option after a build invalidates it (state back to idle; the next Download/Copy builds again).

- [ ] **Step 1: Failing tests** — mount the sheet with `@vue/test-utils` (see `tests/unit/motionx/settle-ui.unit.spec.ts` for the mount pattern) and assert: the two size options show the output and the doubled dimensions; `failures` render one line each, a model failure with "Re-generate or re-upload it."; the still-scene line shows exactly when `still` is true; Download and Copy embed code are disabled unless `state === 'ready'`; the Cinematic warning shows only when `cinematic` is true and `cinematicWarning` is set; each option emits its `update:*` event.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the sheet in one valid write; vue-tsc count for it = 0.
- [ ] **Step 4: Wire it into the surface** in one valid edit: add `{ label: 'Export embed…', onClick: openWebExport }` to the footer `downloads`; state for the options (defaults: size `output`, fps `30`, cinematic `false`, transparent `doc.background === 'transparent'`); `build()` calls `bakeSceneFrames(doc, { width: W×k, height: H×k, fps, transparent, cinematic: cinematic ? { samples: 64 } : undefined, onProgress, signal })` with `k = size === 'sharp' ? 2 : 1`, then — if no failures — `exportEmbedHtml({ kind: 'frames', config: { frames, fps, width, height }, duration: loop.animated ? loop.duration : 1, width, height, transparent, still: !loop.animated })` and keeps the HTML and its byte length; `download()` → `downloadEmbed('sailor-3d.html', html)`; `copy()` → `navigator.clipboard.writeText(embedSnippet('sailor-3d.html', W, H))` with the same copied/failed handling as the Frame sheet. The export runs with playback paused, like `bakeSceneVideo`. vue-tsc count for the surface unchanged.
- [ ] **Step 5: Live check** on `http://127.0.0.1:3002`: open a 3D scene with motion, **Export embed…**, build at Output/30 fps, then load the downloaded HTML's content in a new tab (or `srcdoc` iframe in the harness) and confirm it plays (two canvas reads at different times differ) with no network request; confirm a scene with a deliberately broken model URL shows a named failure and no Download. Screenshot the sheet.
- [ ] **Step 6: Commit** `feat(scene3d): Export embed — a 3D scene becomes one HTML file that plays anywhere`

---

### Task 7: Animated wired layers play in Frame exports

**Files:**
- Modify: `frontend/app/lib/embed/frame/types.ts:43` (`WiredEntry`), `frontend/app/lib/embed/frame/plan.ts` (~142-223: wired slots, notices, loop length), `frontend/app/lib/embed/frame/gather.ts` (~192-196), `frontend/app/lib/embed/frame/appIO.ts` (a `wiredFrames` IO), `frontend/app/lib/embed/surfaces/frame.ts` (~184, ~205: the wired provider), `frontend/app/components/vue-canvas/CompositorModal.vue` (~5102-5111: pass the live source)
- Test: `frontend/tests/unit/frame-embed-wired-clips.unit.spec.ts` (create); extend `frontend/tests/frame-embed-network.spec.ts` with a wired-clip fixture if its fixtures allow it

**Interfaces:**
- Consumes: `encodeWebp` (Task 4, `lib/scene3d/bakeFrames.ts`) — move it to `lib/embed/frame/encode.ts` if importing scene3d from the Frame gatherer pulls unwanted code into the Frame bundle (check with the build-output test); `StudioFrameSource` (`lib/studio/frameSource.ts:20`).
- Produces:
  - `type WiredEntry = { kind: 'still'; dataUrl: string } | { kind: 'clip'; frames: string[]; fps: number; duration: number }`
  - `FramePlan.wiredClips: { slot: number; maxPx: number; fps: number; duration: number; label: string }[]`
  - `WiredSlotInfo` gains `fps?: number; duration?: number` (the modal fills them from the slot's live source)
  - `FrameExportIO.wiredFrames(slot: number, count: number, maxPx: number): Promise<CanvasImageSource[]>`
  - `wiredClipFrameAt(entry: { frames: unknown[]; duration: number }, tSec: number): number` exported from `surfaces/frame.ts` (or a small helper module) for tests.

- [ ] **Step 1: Failing tests** — planner: an animated wired slot (`animated: true, fps: 24, duration: 2`) goes to `wiredClips` with its `maxPx`, **not** to `wiredStills`, and its notice is in the "live" group ("{label} · plays as frames"), not "still"; a still wired slot is unchanged; the Frame's loop length accounts for a wired clip exactly as it does for an image clip (read `loopSeconds` in `plan.ts` and assert the same rule). Gatherer (fake IO): `wiredFrames` is called with `round(duration × fps)` and the plan's `maxPx`, and each returned image is encoded to a `data:image/webp` URI in `snap.wired[slot]` as `{ kind: 'clip', frames, fps, duration }`. `wiredClipFrameAt`: `tSec` wraps on the clip's own duration (`0 → 0`, `duration/2 → count/2`, `duration → 0`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - **Modal:** where it builds `wiredSlots` (~5102), add `fps: live?.fps, duration: live?.duration`; pass `createAppFrameExportIO({ …, wiredFrames: (slot, count, maxPx) => … })` that finds the slot's live `StudioFrameSource` (the same `layers.value.find(x => x.slot === slot + 1)?.live` object — read what `live` is; if it is not the `StudioFrameSource` itself, find the source by the wired node's id with `getStudioFrameSource`), and for `i` in `0..count-1` awaits `getFrame(i / count, w, h)` sized to fit `maxPx` on its longest side at the source's aspect (`live.width/height`), copying each result into a fresh canvas **before** the next call (a source's canvas is only valid until its next render).
  - **Plan:** animated wired slots with a known `fps` and `duration > 0` → `wiredClips`; keep the still path for the rest; notice group `live`, text `${label} · plays as frames`. Remove the old "shown as a still in this version" notice for these slots only.
  - **Gather:** for each `wiredClip`, `io.wiredFrames(...)` → `io.imageToDataUrl(img, maxPx, 'image/webp')` per frame → `wired[slot] = { kind: 'clip', frames, fps, duration }`.
  - **Adapter:** load a clip entry's frames as images at mount (reuse `loadImage`); the provider becomes `(slot) => stills.get(slot) ?? clipFrame(slot, lastT)` where `clipFrame` picks `wiredClipFrameAt(entry, tSec)`. Make sure the provider reads the time of the frame being painted (read how `lastT`/`tSec` flow in the paint call at ~256 and use that value).
- [ ] **Step 4: Run** the new spec, `npm run test:unit -- frame-embed`, `npm run test:unit -- embed`, and the build-output test (the Frame bundle stays under its ceiling). vue-tsc: `CompositorModal.vue` still 6.
- [ ] **Step 5: Live check** on `http://127.0.0.1:3002`: a Frame with an animated 3D scene wired in → Export embed… → the sheet lists it under "Plays live"; the downloaded file's canvas differs at two times inside the 3D layer's box; a Frame with an animated Space Type or Shader wired in plays too (departure 4); no network request.
- [ ] **Step 6: Commit** `feat(embed): an animated wired layer plays in a Frame export as pre-rendered frames instead of freezing`

---

### Task 8: End-to-end check and the record

**Files:**
- Modify: `docs/STATE.md` (the web export entry), `docs/superpowers/specs/2026-09-23-scene3d-web-embed-design.md` (append a short "Phase 1 as built" section listing this plan's departures)

- [ ] **Step 1: Suites.** `npm run test:unit -- scene3d`, `-- embed`, `-- frame-embed`, `-- compositor`; `npx playwright test tests/embed-frames.spec.ts tests/frame-embed-network.spec.ts tests/embed-network.spec.ts`. Report each "Test Files" / "Tests" line.
- [ ] **Step 2: A contact sheet** on `http://127.0.0.1:3002`: four scenes — type with the built-in lighting, a product model with an HDRI, a scene with a treatment, and a tracks-only scene — each exported at Output/30 fps; a grid of their embeds' frames at t = 0, 0.33, 0.66 drawn onto one canvas; upload via `fetch('/upload/image', …)` and copy to `/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/629368c1-fa5f-4981-87c4-f5f70af6e9eb/scratchpad/demo/scene3d-embed-sheet.png`. Report each export's size and frame count.
- [ ] **Step 3: Record.** Append "Phase 1 as built" to the spec (the five departures above, plus anything the tasks found). Update the web-export line in `docs/STATE.md`.
- [ ] **Step 4: Commit** `docs: 3D Studio on the web, Phase 1 — as built`

---

## Self-review (done while writing)

- **Spec coverage.** Part 1 → Tasks 1–3 (tracks, settling with named failures, helpers hidden, restyle, grain, the two callers migrated). Part 2 → Tasks 4–6 (bake with cinematic and alpha, the `frames` player with its bundle and ceiling, the standalone export). Part 3 → Task 7, corrected by departures 2–4. Part 4's Phase-1 sheet → Task 6 (Pre-rendered only; the picker is Phase 2). Testing → each task plus Task 8. Out-of-scope items are untouched.
- **Types.** `AssetFailure`/`AssetKind` (Task 2) are what Tasks 3, 4 and 6 use; `ExportIO`/`appExportIO` (Task 3) feed Task 4; `bakeSceneFrames`'s result feeds Task 6's `exportEmbedHtml` config, which is exactly `FramesEmbedConfig` (Task 5); `WiredEntry`'s `clip` variant (Task 7) is what the adapter's provider reads.
- **Order.** 1 → 2 → 3 → 4 are sequential (each consumes the last). 5 depends on nothing and can run beside 2–4. 6 needs 4 and 5. 7 needs 4 (`encodeWebp`) and 3 (the Frame's 3D source on the export path, for 3D slots). 8 last.
