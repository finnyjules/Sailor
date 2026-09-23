# Browser Video Export — Plan 2 of 3: the Frame, and the embed bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Frame's two video exports (the Frame editor's "Generate as video" and the Frame card's download) record in the browser like the studios, with Cancel and a visible fallback; and any embed surface can be recorded to video through a small bridge.

**Architecture:** Plan 1's `exportStudioVideo` (`app/lib/studio/studioVideoExport.ts`) is reused unchanged. The Frame's per-frame painting is pulled out of `bakeMotionFrames` into a painter both the old PNG route and the recorder call, so they draw identically. The Frame card already has `renderCompositeAtTime(t)` (awaitable; the Frame web-export plan promises not to change it). The bridge mounts an `EmbedSurface` in a detached container and copies its canvas after each synchronous `setTime`.

**Tech Stack:** Vue 3 + TS (Nuxt 4), mediabunny 1.59 (via plan 1's recorder), Vitest, Playwright (`--project=chromium`), PyAV (`frontend/tests/tools/compare_videos.py`).

**Spec:** `docs/superpowers/specs/2026-09-21-browser-video-export-design.md` (stage 3). Plan 1: `docs/superpowers/plans/2026-09-22-browser-video-export-studios.md` — its studio tasks are the finished pattern.

## Plain-language summary

- **What changes:** in the Frame editor, "Generate as video" records in the browser, shows "Rendering n/N", and gets a Cancel button. On the Frame card, the download button records in the browser too, shows its progress next to the button, and turns into a stop button while it runs. Both keep the old server route as a visible fallback (local mode) and show a plain error in hosted mode.
- **One behaviour change you should know about:** today "Generate as video" in the Frame editor also re-bakes the Frame node's own frame sequence (the frames the node hands to the rest of a workflow when the graph runs). The browser route makes the video only. So after this plan, a Frame node used inside a running workflow keeps its last baked frames until something re-bakes them. Nothing else in the app triggers that re-bake today; if you rely on it, say so and plan 2b adds a separate "Bake for workflow" action.
- **The embed bridge:** any piece that can be embedded on a web page (Shader, Gradient and Space Type today; the Frame once the web-export session lands it) can also be recorded to a video through one small function. Nothing uses it in the app yet; it is proven by a browser test on the three existing embeds.
- **Not in this plan:** the timeline (plan 3).

## Global Constraints

- Work directly in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch. Never `git stash`. Never touch files you did not write.
- **Subagents do not commit.** The controller commits with the private-index recipe (plan 1). **`CompositorModal.vue` is shared with the parallel Frame web-export session (its Task 9 edits the footer and adds glue near `generateVideo`).** The controller commits only this plan's hunks in that file: if `git diff` shows other changes in it, build the private index with `git diff -- <file> > p.diff`, keep only this plan's hunks, and `git apply --cached` them — never `git add` the whole file.
- Never run `npm run dev` or start/stop servers. Dev server `http://127.0.0.1:3002`, ComfyUI `http://127.0.0.1:8188`.
- **Do not move, rename or change `renderCompositeAtTime(t)`** in `ArtifactFrameNode.vue`, and do not edit anything under `frontend/app/lib/embed/` (both belong to the web-export session). The bridge lives in `frontend/app/lib/engine/`.
- Reuse plan 1's modules as they are: `recordVideo`, `isAbortError`, `throwIfAborted` (`app/lib/engine/videoRecorder.ts`), `exportStudioVideo`, `resultBlob`, `videoErrorText`, `StudioVideoResult` (`app/lib/studio/studioVideoExport.ts`), `prefersServerVideoExport` (`app/lib/engine/videoExportSupport.ts`), `hostedModeEnabled` (`app/lib/hostedMode.ts`).
- A quiet fallback is forbidden: every fallback shows a notice the user can see.
- Frame timestamps from the index only. BT.709 on every file (the recorder does it).
- UI copy: sentence case, plain words, no internal identifiers.
- Unit tests: `npx vitest run tests/unit/<file>`; browser: `npx playwright test tests/<file> --project=chromium` (from `frontend/`). Typecheck: baseline grep before, same grep after; only new lines count.
- After every commit the controller updates `docs/STATE.md` and the build dashboard.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/motion/bake.ts` | Split: `prepareMotionFramePainter()` (ensure fonts/images/shaders once, snapshot the stack) + `bakeMotionFrames()` rebuilt on it. |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | `generateVideo` → `exportStudioVideo`; footer Cancel + status. |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` | `downloadVideo` → `exportStudioVideo`; card status + stop button; abort on unmount. |
| `frontend/app/lib/engine/recordEmbed.ts` (new) | Record any `EmbedSurface` to a video. |
| `frontend/tests/unit/motion-frame-painter.unit.spec.ts` (new) | The painter's frame count, times and snapshot. |
| `frontend/tests/unit/record-embed.unit.spec.ts` (new) | Bridge orchestration with fakes. |
| `frontend/tests/embed-video.spec.ts` (new) | Bridge on the three real embeds. |

---

### Task 1: One painter for the Frame's motion frames

**Files:**
- Modify: `frontend/app/lib/motion/bake.ts` (`bakeMotionFrames`, lines ~46–98)
- Test: `frontend/tests/unit/motion-frame-painter.unit.spec.ts`

**Interfaces:**
- Produces: `interface MotionFramePainter { total: number; time(i: number): number; paint(i: number, ctx: CanvasRenderingContext2D): Promise<void> }` and `prepareMotionFramePainter(buildItems, localLayers, W, H, motion, prepareFrame?, deps?): Promise<MotionFramePainter>` where `deps?: { paint?: typeof paintLayerStack; ensure?: () => Promise<void> }` exists only so tests can replace the heavy painter.

- [ ] **Step 1: Read the current `bakeMotionFrames`** (the whole function) and `bakeAndUpload` in `frontend/app/lib/motion/bake.ts`. Everything before the frame loop (fonts, images, reveal shaders, the one-time `buildItems()`/`[...localLayers]` snapshot, `total`) becomes the painter's preparation; the body of the loop (prepareFrame(t), reset transform, clearRect, `paintLayerStack(..., true)`) becomes `paint(i, ctx)`.

- [ ] **Step 2: Write the failing test** — `frontend/tests/unit/motion-frame-painter.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { prepareMotionFramePainter } from '../../app/lib/motion/bake'

const motion = { fps: 25, duration: 0.2 } as any   // 5 frames

function fakeCtx(w: number, h: number) {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      canvas: { width: w, height: h },
      setTransform: () => calls.push('reset'),
      clearRect: () => calls.push('clear'),
    } as any,
  }
}

describe('prepareMotionFramePainter', () => {
  it('counts frames from duration × fps and times them i / fps', async () => {
    const p = await prepareMotionFramePainter(() => [], [], 100, 50, motion, undefined, { paint: vi.fn(), ensure: async () => {} })
    expect(p.total).toBe(5)
    expect([0, 1, 4].map(i => p.time(i))).toEqual([0, 0.04, 0.16])
  })

  it('paints each frame at its own time, after the caller-supplied pull, on a cleared canvas', async () => {
    const order: string[] = []
    const paint = vi.fn((_ctx, w, h, _items, _layers, _a, t, _m, _b, _c, _d, _e, bake) => order.push(`paint ${t} ${w}x${h} bake=${bake}`))
    const p = await prepareMotionFramePainter(() => [], [], 100, 50, motion, async t => { order.push(`pull ${t}`) }, { paint, ensure: async () => {} })
    const { ctx, calls } = fakeCtx(100, 50)
    await p.paint(2, ctx)
    expect(order).toEqual(['pull 0.08', 'paint 0.08 100x50 bake=true'])
    expect(calls).toEqual(['reset', 'clear'])
  })

  it('snapshots the stack ONCE: later edits do not leak into later frames', async () => {
    let n = 0
    const build = vi.fn(() => [{ id: `item-${++n}` }] as any)
    const seen: string[] = []
    const paint = vi.fn((_ctx, _w, _h, items) => seen.push(items[0].id))
    const p = await prepareMotionFramePainter(build, [], 10, 10, motion, undefined, { paint, ensure: async () => {} })
    const { ctx } = fakeCtx(10, 10)
    await p.paint(0, ctx); await p.paint(1, ctx)
    expect(build).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['item-1', 'item-1'])
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** (`prepareMotionFramePainter` is not exported).

- [ ] **Step 4: Implement.** In `bake.ts`, add above `bakeMotionFrames`:

```ts
/** What a motion export needs per frame, prepared once: fonts, images and any
 *  reveal shaders loaded, the layer stack snapshotted (later edits must not leak
 *  into later frames). `paint(i, ctx)` pulls wired sources to frame i's time
 *  (via `prepareFrame`) and paints the stack onto `ctx` — used by both the PNG
 *  bake below and the browser video recorder, so the two draw identically. */
export interface MotionFramePainter {
  total: number
  time(i: number): number
  paint(i: number, ctx: CanvasRenderingContext2D): Promise<void>
}

export async function prepareMotionFramePainter(
  buildItems: () => StackItem[],
  localLayers: LocalLayer[],
  W: number,
  H: number,
  motion: FrameMotion,
  prepareFrame?: (t: number) => Promise<void>,
  deps: { paint?: typeof paintLayerStack; ensure?: () => Promise<void> } = {},
): Promise<MotionFramePainter> {
  if (deps.ensure) {
    await deps.ensure()
  } else {
    for (const l of localLayers) if (l.kind === 'text') useLibraryFonts().ensure((l as TextLayer).fontFamily)
    await ensureLayerFonts(localLayers, W)
    await ensureLayerImages(localLayers)
    // (keep the existing comment block about reveal shaders here, verbatim)
    if (motionUsesShaderStyle(motion.behaviours)) await ensureRevealShadersReady(motion.behaviours)
  }
  const paint = deps.paint ?? paintLayerStack
  // (keep the existing "Snapshot the stack and layer list ONCE" comment here, verbatim)
  const items = buildItems()
  const frozenLayers = [...localLayers]
  const total = Math.max(1, Math.round(motion.duration * motion.fps))
  const time = (i: number) => i / motion.fps
  return {
    total,
    time,
    async paint(i, ctx) {
      const t = time(i)
      if (prepareFrame) await prepareFrame(t)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)   // transparent background
      // bake=true (Task 10): this IS the final motion export — shader-fill fields must
      // render unclamped (full res) and stay live past LIVE_FIELD_CEILING.
      paint(ctx, ctx.canvas.width, ctx.canvas.height, items, frozenLayers, undefined, t, motion,
        undefined, undefined, undefined, undefined, true)
    },
  }
}
```

Then rewrite `bakeMotionFrames` to use it (same signature, same result):

```ts
export async function bakeMotionFrames(
  buildItems: () => StackItem[], localLayers: LocalLayer[], W: number, H: number, motion: FrameMotion,
  onProgress?: (done: number, total: number) => void,
  prepareFrame?: (t: number) => Promise<void>,
): Promise<Blob[]> {
  const painter = await prepareMotionFramePainter(buildItems, localLayers, W, H, motion, prepareFrame)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(W))
  canvas.height = Math.max(1, Math.round(H))
  const ctx = canvas.getContext('2d')!
  const blobs: Blob[] = []
  for (let i = 0; i < painter.total; i++) {
    await painter.paint(i, ctx)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error(`motion bake: frame ${i} produced no blob`)
    blobs.push(blob)
    onProgress?.(i + 1, painter.total)
  }
  return blobs
}
```

Keep `prepareFrame`'s doc comment on `bakeMotionFrames`. If `paintLayerStack`'s real signature differs from the call above, copy the call exactly from the current loop body — the test's fake only checks positions 1, 2, 3, 6 and 12 (w, h, items, t, bake).

- [ ] **Step 5: Run** `npx vitest run tests/unit/motion-frame-painter.unit.spec.ts tests/unit/motion-bake-key.unit.spec.ts` — PASS. Typecheck grep `lib/motion/bake\.ts` — no new lines.

- [ ] **Step 6: Commit (controller)** — `refactor(frame): one motion-frame painter for the PNG bake and the browser recorder`

---

### Task 2: The Frame editor's "Generate as video" records in the browser

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — imports; refs near `const renderError = ref('')` (~4380); `generateVideo` (~4434); footer (~11201, the button reading `baking ? … : encoding ? 'Encoding…' : 'Generate as video'`); the `onBeforeUnmount` that calls `stopLive` (~3608)

**Interfaces:**
- Consumes: `prepareMotionFramePainter` (Task 1); plan 1 modules listed in Global Constraints; existing locals `compositor`, `bakeSize()`, `effectiveMotion`, `buildStackItems`, `localLayers`, `layers`, `pullLiveFrameModal`, `slotPhase01`, `wiredContentForSlot`, `_registerWiredContent`, `pause`, `stopLive`, `startLive`, `bakeMotion`, `storedMotionParams`, `background`, `hasPaint`, `hasMotion`, `rendering`, `baking`, `bakeProgress`, `bakeError`, `encoding`, `renderError`, `recordAsset`, `activeTab`, `emit`.

- [ ] **Step 1: Typecheck baseline** for `vue-canvas/CompositorModal\.vue`.

- [ ] **Step 2: Imports** — add (merge into existing import lines where the module is already imported):

```ts
import { exportStudioVideo, videoErrorText } from '~/lib/studio/studioVideoExport'
import { prefersServerVideoExport } from '~/lib/engine/videoExportSupport'
import { isAbortError, throwIfAborted } from '~/lib/engine/videoRecorder'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { prepareMotionFramePainter } from '~/lib/motion/bake'
```

- [ ] **Step 3: State** — directly after `const encoding = ref(false)` add:

```ts
// The running video export, so Cancel can stop it; and the footer line saying
// how it is going or how the last video was made (a fallback must be seen).
let videoAbort: AbortController | null = null
const exportingVideo = ref(false)
const videoStatus = ref('')
function cancelVideoExport() { videoAbort?.abort() }
```

- [ ] **Step 4: Replace `generateVideo`** (keep any comment above it that still applies):

```ts
async function generateVideo() {
  const node = compositor.value
  if (!node || rendering.value || baking.value || encoding.value || exportingVideo.value || !hasMotion.value) return
  renderError.value = ''
  videoStatus.value = ''
  const { W, H } = bakeSize()
  const motion = effectiveMotion.value
  const alpha = !hasPaint(background.value)
  videoAbort = new AbortController()
  exportingVideo.value = true
  pause()      // don't fight the rAF preview loop for the layer state
  stopLive()   // don't let the live studio RAF race the per-frame pulls
  // The export is async (one awaited frame at a time), so a scoped
  // withWiredContent span can't hold across it — register globally for its
  // duration, exactly as bakeMotion does, and clear it in finally.
  _registerWiredContent(wiredContentForSlot)
  try {
    const pull = async (t: number) => {
      const animated = layers.value.filter(l => l.live && l.live.duration > 0)
      await Promise.all(animated.map(l => pullLiveFrameModal(l, slotPhase01(t, l.live!.duration))))
    }
    const painter = await prepareMotionFramePainter(() => buildStackItems(), localLayers.value as LocalLayer[], W, H, motion, pull)
    const made = await exportStudioVideo({
      prefix: 'frame', publish: true,
      width: W, height: H, fps: motion.fps, frameCount: painter.total, alpha,
      signal: videoAbort.signal,
      drawFrame: async (i, ctx) => {
        videoStatus.value = `Rendering ${i + 1}/${painter.total}`
        await painter.paint(i, ctx)
      },
      onStatus: t => { videoStatus.value = t },
      serverFallback: async (signal) => {
        _registerWiredContent(null)   // bakeMotion registers and clears its own
        await bakeMotion()
        throwIfAborted(signal)
        if (bakeError.value) throw new Error(bakeError.value)
        videoStatus.value = 'Encoding…'
        return await encodeFrames({
          frames: storedMotionParams.value!.rendered, fps: motion.fps, width: W, height: H, alpha,
        })
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
    if (!made?.filename) { videoStatus.value = ''; return }
    await recordAsset(activeTab.value?.projectUuid, 'video', made.filename)
    window.dispatchEvent(new CustomEvent('sailor:compositorOutput', {
      detail: { sourceNodeId: node.id, nodeType: 'Video', widgetOverrides: { file: made.filename } },
    }))
    videoStatus.value = made.notice ?? ''
    // A fallback notice must be seen: keep the editor open when there is one.
    if (!made.notice) emit('close')
  } catch (err) {
    if (isAbortError(err)) { videoStatus.value = 'Export cancelled.'; return }
    console.error('[frame] video export failed', err)
    videoStatus.value = ''
    renderError.value = videoErrorText(err)
  } finally {
    _registerWiredContent(null)
    exportingVideo.value = false
    videoAbort = null
    startLive()
  }
}
```

Notes for the implementer: `bakeMotion` checks `if (baking.value) return` and manages `baking`, `bakeProgress`, `bakeError`, `pause`, `stopLive`, `startLive` itself — calling it from the fallback is safe. Import `LocalLayer` as a type if the file does not already.

- [ ] **Step 5: Footer.** In the footer block, replace the "Generate as video" `<button>`'s label expression with:

```
{{ exportingVideo ? (videoStatus || 'Rendering…') : baking ? `Baking ${Math.round((bakeProgress ?? 0) * 100)}%` : encoding ? 'Encoding…' : 'Generate as video' }}
```
and add `|| exportingVideo` to that button's `:disabled` expression. Directly BEFORE that button (and after the `renderError` span), add:

```html
<span v-if="videoStatus && !exportingVideo" class="text-xs text-white/55 truncate max-w-[280px]" :title="videoStatus">{{ videoStatus }}</span>
<button v-if="exportingVideo" type="button" class="px-3 py-1.5 text-xs rounded-md text-white/70 hover:text-white hover:bg-white/10" @click="cancelVideoExport">Cancel</button>
```
Match the surrounding buttons' classes if the footer uses a different style. Do NOT touch any "Web export" button or `webExport`/`buildWebExport` code if present — that belongs to the web-export session.

- [ ] **Step 6: Abort on close** — in the existing `onBeforeUnmount` that calls `stopLive()`, add `videoAbort?.abort()` as its first line.

- [ ] **Step 7: Tests and typecheck.** `npx vitest run tests/unit/motion-frame-painter.unit.spec.ts tests/unit/studio-video-export.unit.spec.ts` PASS; typecheck grep no new lines; run any existing Playwright spec that opens the Frame editor's footer (`grep -l "Generate as video" frontend/tests/*.spec.ts`) with `--project=chromium`.

- [ ] **Step 8: Prove it both ways (controller).** Use a Frame with motion (a text layer with an in-animation, 2 s at 30 fps) opened in the Frame editor on the canvas at `http://127.0.0.1:3002`. "Generate as video" with the default route → a Video node appears, `input/frame_<ts>.mp4` exists; with `localStorage['Sailor.VideoExport']='server'` → the notice "Made on the server (browser recording is switched off)." and the editor stays open, `input/spacetype_<ts>.mp4` exists. `compare_videos.py` on the pair: same frame count, BT.709, `mae_rgb` ≤ 3.0. Then Cancel mid-export → "Export cancelled.", no new file. Repeat once with an empty (no fill) background: both files `vp9`, alpha 0–255. Delete every file the checks created.

- [ ] **Step 9: Commit (controller, own hunks only)** — `feat(frame): the Frame editor's videos are recorded in the browser, with Cancel; server route kept as a visible fallback`

---

### Task 3: The Frame card's download records in the browser

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` — `downloadVideo` (~939–971), `downloadImage` (~973), the header row's download `<button>` (~1149), `onBeforeUnmount` (~905), imports

**Interfaces:**
- Consumes: `renderCompositeAtTime(t)` (unchanged), `exportCompositeCanvas`, `masterClock`, `stopAnim`, `applyGate`, `editor.background`, `hasPaint`, `hasAnimatedSlot`, `recordAsset`, `activeTab`, plan 1 modules.

- [ ] **Step 1: Typecheck baseline** for `vue-canvas/ArtifactFrameNode\.vue`. Read `downloadVideo`, `downloadImage`, the header row template and `onBeforeUnmount`.

- [ ] **Step 2: Imports** (merge with existing):

```ts
import { exportStudioVideo, resultBlob, videoErrorText } from '~/lib/studio/studioVideoExport'
import { prefersServerVideoExport } from '~/lib/engine/videoExportSupport'
import { isAbortError, throwIfAborted } from '~/lib/engine/videoRecorder'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'
```

- [ ] **Step 3: State** — next to the other refs used by the download:

```ts
// The running video download, so the button can stop it; and a short line
// beside the button saying how it is going or how it was made.
let videoAbort: AbortController | null = null
const exportingVideo = ref(false)
const videoStatus = ref('')
```

- [ ] **Step 4: Replace `downloadVideo`:**

```ts
// Export an animated Frame as a video: recorded in the browser (the same
// renderCompositeAtTime the old route baked PNGs from), or — local mode only,
// with a visible notice — through the server route. Records to Assets and
// downloads. The live preview loop is paused so it can't interleave pulls.
async function downloadVideo() {
  const mc = masterClock.value
  if (!mc || mc.duration <= 0 || exportingVideo.value) return
  stopAnim()
  videoAbort = new AbortController()
  exportingVideo.value = true
  videoStatus.value = ''
  try {
    const first = await renderCompositeAtTime(0)
    if (!first) return
    const W = first.width, H = first.height
    const total = Math.max(1, Math.round(mc.fps * mc.duration))
    const alpha = !hasPaint(editor.background.value)
    const made = await exportStudioVideo({
      prefix: 'frame', publish: true,
      width: W, height: H, fps: mc.fps, frameCount: total, alpha,
      signal: videoAbort.signal,
      drawFrame: async (i, ctx) => {
        videoStatus.value = `${i + 1}/${total}`
        const cv = await renderCompositeAtTime(i / mc.fps)
        if (!cv) throw new Error('no composite')
        ctx.drawImage(cv, 0, 0, W, H)   // a fresh 2D canvas: no WebGL buffer to lose
      },
      onStatus: t => { videoStatus.value = t },
      serverFallback: async (signal) => {
        const { ensureSpaceTypeBake } = await import('~/lib/spacetype/bake')
        const bakeCfg = { fps: mc.fps, loopDuration: mc.duration, W, H, seed: 'frame', sig: JSON.stringify({ id: props.id, n: total, w: W, h: H }) }
        const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
          renderFrame: async (i) => {
            throwIfAborted(signal)
            videoStatus.value = `${i + 1}/${total}`
            const cv = await renderCompositeAtTime(i / mc.fps)
            return await new Promise<Blob>((res, rej) => cv ? cv.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png') : rej(new Error('no composite')))
          },
        })
        throwIfAborted(signal)
        return encodeFrames({ frames: bake.frames, fps: mc.fps, width: W, height: H, alpha })
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
    if (!made?.filename) { videoStatus.value = ''; return }
    await recordAsset(activeTab.value?.projectUuid, 'video', made.filename)
    downloadBlobAsFile(await resultBlob(made), `frame-${props.id}.${made.ext}`)
    videoStatus.value = made.notice ?? ''
  } catch (err) {
    if (isAbortError(err)) { videoStatus.value = 'Cancelled'; return }
    console.error('[Frame] video export failed', err)
    videoStatus.value = videoErrorText(err)
  } finally {
    exportingVideo.value = false
    videoAbort = null
    applyGate()
  }
}
```

Keep the existing download filename if it differs from `frame-${props.id}.${ext}` (use whatever the current code names it, only the extension comes from `made.ext`). Keep any existing `recordAsset` error handling.

- [ ] **Step 5: The button and the status.** Replace the header row's download button with:

```html
<span v-if="videoStatus" class="shrink min-w-0 truncate text-[10px] text-white/45 tabular-nums" :title="videoStatus">{{ videoStatus }}</span>
<button v-if="exportingVideo" class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] cursor-pointer" title="Stop" @click.stop="videoAbort?.abort()"><X class="size-3" /></button>
<button v-else class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/40 hover:text-white/85 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40" :disabled="!hasAnyLayer && !compositeUrl" title="Download" @click.stop="downloadImage"><Download class="size-3" /></button>
```

(Import `X` from `lucide-vue-next` next to `Download` if it is not already imported.) `videoAbort` is a plain `let`; if the template cannot see it, add `function stopVideoExport() { videoAbort?.abort() }` and call that. Clear `videoStatus` when the user starts an image download (first line of `downloadImage`: `videoStatus.value = ''`).

- [ ] **Step 6: Abort on unmount** — first line of the existing `onBeforeUnmount`: `videoAbort?.abort()`.

- [ ] **Step 7: Tests and typecheck** — the unit specs from Task 2 pass; typecheck grep no new lines; run `grep -l "frame-card\|ArtifactFrameNode" frontend/tests/*.spec.ts` specs that touch the card header with `--project=chromium`.

- [ ] **Step 8: Prove it both ways (controller)** — a Frame card with an animated wired studio (e.g. a Gradient Studio wired in) on the canvas: press the card's download → progress "n/N" beside the button, a file downloads, `input/frame_<ts>.mp4`; forced server → the notice beside the button; compare the two with `compare_videos.py` (same frames, BT.709, `mae_rgb` ≤ 3.0); press Stop mid-way → "Cancelled", nothing downloads. Delete the files the checks created.

- [ ] **Step 9: Commit (controller)** — `feat(frame): the Frame card's video download is recorded in the browser, with a stop button`

---

### Task 4: The embed bridge

**Files:**
- Create: `frontend/app/lib/engine/recordEmbed.ts`
- Test: `frontend/tests/unit/record-embed.unit.spec.ts`, `frontend/tests/embed-video.spec.ts`

**Interfaces:**
- Consumes: `EmbedSurface`, `EmbedHandle` from `~/lib/embed/contract` (read only); `recordVideo`, `RecordResult`, `RecorderDeps` from `./videoRecorder`.
- Produces: `interface EmbedRecordOptions { width: number; height: number; fps: number; duration: number; alpha?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }` and `recordEmbed(surface: EmbedSurface, config: unknown, o: EmbedRecordOptions, deps?: { record?: typeof recordVideo; container?: () => HTMLElement }): Promise<RecordResult>`.

- [ ] **Step 1: Failing unit test** — `frontend/tests/unit/record-embed.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { recordEmbed } from '../../app/lib/engine/recordEmbed'

function fakeSurface(alpha = false) {
  const log: string[] = []
  const canvas = { tagName: 'CANVAS' } as any
  const container: any = { querySelector: (s: string) => (s === 'canvas' ? canvas : null) }
  const surface = {
    kind: 'fake', caps: { alpha },
    async mount(el: any, cfg: any) {
      log.push(`mount ${cfg.id}`); expect(el).toBe(container)
      return { setTime: (t: number) => log.push(`t ${t}`), setSize: (w: number, h: number) => log.push(`size ${w}x${h}`), destroy: () => log.push('destroy') }
    },
  }
  return { surface, container, canvas, log }
}

describe('recordEmbed', () => {
  it('mounts once, sizes, sets each frame time (normalized) and copies the canvas right after, then destroys', async () => {
    const { surface, container, canvas, log } = fakeSurface()
    const drawn: any[] = []
    const record = vi.fn(async (req: any) => {
      for (let i = 0; i < req.frameCount; i++) {
        await req.drawFrame(i, { drawImage: (c: any, x: number, y: number, w: number, h: number) => { drawn.push([c, w, h]); log.push(`copy ${i}`) } })
      }
      return { blob: new Blob(['v']), ext: 'mp4', contentType: 'video/mp4', width: req.width, height: req.height } as any
    })
    const r = await recordEmbed(surface as any, { id: 'c' }, { width: 64, height: 32, fps: 4, duration: 1 }, { record, container: () => container })
    expect(r.ext).toBe('mp4')
    expect(record.mock.calls[0]![0]).toMatchObject({ width: 64, height: 32, fps: 4, frameCount: 4, alpha: false })
    expect(log).toEqual(['mount c', 'size 64x32', 't 0', 'copy 0', 't 0.25', 'copy 1', 't 0.5', 'copy 2', 't 0.75', 'copy 3', 'destroy'])
    expect(drawn.every(([c, w, h]) => c === canvas && w === 64 && h === 32)).toBe(true)
  })

  it('transparency only when both asked for and the surface really has it', async () => {
    const record = vi.fn(async () => ({ blob: new Blob([]), ext: 'webm' }) as any)
    const a = fakeSurface(true)
    await recordEmbed(a.surface as any, { id: 'a' }, { width: 2, height: 2, fps: 1, duration: 1, alpha: true }, { record, container: () => a.container })
    const b = fakeSurface(false)
    await recordEmbed(b.surface as any, { id: 'b' }, { width: 2, height: 2, fps: 1, duration: 1, alpha: true }, { record, container: () => b.container })
    expect(record.mock.calls.map((c: any) => c[0].alpha)).toEqual([true, false])
  })

  it('destroys the surface even when recording fails', async () => {
    const { surface, container, log } = fakeSurface()
    const err = await recordEmbed(surface as any, { id: 'x' }, { width: 2, height: 2, fps: 1, duration: 1 }, {
      record: async () => { throw new Error('boom') }, container: () => container,
    }).then(() => null, e => e)
    expect(err?.message).toBe('boom')
    expect(log.at(-1)).toBe('destroy')
  })

  it('a surface that mounts no canvas is an error', async () => {
    const { surface } = fakeSurface()
    const empty: any = { querySelector: () => null }
    const record = vi.fn(async (req: any) => { await req.drawFrame(0, { drawImage: () => {} }); return {} as any })
    await expect(recordEmbed(surface as any, { id: 'e' }, { width: 2, height: 2, fps: 1, duration: 1 }, { record, container: () => empty }))
      .rejects.toThrow('embed surface drew no canvas')
  })
})
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement** `frontend/app/lib/engine/recordEmbed.ts`:

```ts
import type { EmbedSurface } from '~/lib/embed/contract'
import { recordVideo, type RecordResult } from './videoRecorder'

// Record any embed surface (the pieces that can be put on a web page) to a
// video. The surface mounts into a detached container, exactly as it would on
// a page; for each frame we set its time — synchronous by the embed contract —
// and copy its canvas in the same turn, so a WebGL buffer can't be cleared in
// between. The contract is read, never changed: it belongs to the embed work.

export interface EmbedRecordOptions {
  width: number
  height: number
  fps: number
  /** Loop length in seconds. */
  duration: number
  alpha?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export async function recordEmbed(
  surface: EmbedSurface,
  config: unknown,
  o: EmbedRecordOptions,
  deps: { record?: typeof recordVideo; container?: () => HTMLElement } = {},
): Promise<RecordResult> {
  const record = deps.record ?? recordVideo
  const container = (deps.container ?? (() => document.createElement('div')))()
  const handle = await surface.mount(container, config)
  try {
    handle.setSize(o.width, o.height)
    const frameCount = Math.max(1, Math.round(o.duration * o.fps))
    return await record({
      width: o.width, height: o.height, fps: o.fps, frameCount,
      alpha: !!o.alpha && surface.caps.alpha,
      signal: o.signal, onProgress: o.onProgress,
      drawFrame: (i, ctx) => {
        handle.setTime(i / frameCount)
        const canvas = container.querySelector('canvas')
        if (!canvas) throw new Error('embed surface drew no canvas')
        ctx.drawImage(canvas, 0, 0, o.width, o.height)
      },
    })
  } finally {
    handle.destroy()
  }
}
```

Note: `setTime` takes a normalized loop position (contract.ts) — `i / frameCount` makes the last frame land just before the loop point, like the studios.

- [ ] **Step 4: Run — PASS.** Typecheck grep `engine/recordEmbed` — nothing.

- [ ] **Step 5: Browser test on the three real embeds** — `frontend/tests/embed-video.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

// The embed bridge on the three shipped embed surfaces. The harness page
// (app/pages/dev/embed-harness.vue) already builds a config for each; the
// bridge records it and mediabunny reads the file back.
test.describe('embed → video bridge', () => {
  test.setTimeout(180_000)
  for (const [kind, key] of [['shader', '__embedHarness'], ['gradient', '__embedHarnessGradient'], ['spacetype', '__embedHarnessSpaceType']] as const) {
    test(`${kind}: records every frame at the asked size, BT.709`, async ({ page }) => {
      await page.goto('/dev/embed-harness')
      await page.waitForFunction(k => !!(window as any)[k + 'Ready'], key, { timeout: 60_000 })
      const r = await page.evaluate(async ([k, kindName]) => {
        const { loadEmbedSurface } = await import('/_nuxt/lib/embed/surfaces.ts')
        const { recordEmbed } = await import('/_nuxt/lib/engine/recordEmbed.ts')
        const mb = await import('/_nuxt/node_modules/mediabunny/dist/modules/src/index.js').catch(() => import('mediabunny' as any))
        const h = (window as any)[k]
        const surface = await loadEmbedSurface(kindName)
        const rec = await recordEmbed(surface, h.config, { width: 320, height: 180, fps: 15, duration: 1 })
        const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS })
        const track = await input.getPrimaryVideoTrack()
        let frames = 0, lumaSpread = 0
        let first: number | null = null
        for await (const wc of new mb.CanvasSink(track).canvases()) {
          const c = wc.canvas as HTMLCanvasElement
          const px = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
          const y = px[0]! + px[1]! + px[2]!
          if (first === null) first = y
          lumaSpread = Math.max(lumaSpread, Math.abs(y - first))
          frames++
        }
        return { frames, ext: rec.ext, w: await track.getDisplayWidth(), h: await track.getDisplayHeight(), cs: await track.getColorSpace(), lumaSpread }
      }, [key, kind] as const)
      expect(r.frames).toBe(15)
      expect([r.w, r.h]).toEqual([320, 180])
      expect(r.cs.primaries).toBe('bt709')
    })
  }
})
```

If `import('/_nuxt/lib/embed/surfaces.ts')` or the mediabunny import path does not resolve in the dev server, find the working path the way plan 1's controller did (`await import('/_nuxt/lib/engine/audio/mixdown.ts?t=…')` worked; for mediabunny, import it through a tiny helper added to `frontend/app/pages/dev/video-export-harness.vue` — e.g. expose `window.__videoHarness.readBack(blob)` — rather than hard-coding a node_modules path). Record which you used. If an embed's harness config has no motion, `lumaSpread` may be 0 — that is fine; the assertion is on frame count, size and colour.

- [ ] **Step 6: Run** `npx playwright test tests/embed-video.spec.ts --project=chromium` — 3 passed.

- [ ] **Step 7: Commit (controller)** — `feat(export): an embed bridge — any embeddable piece can be recorded to video`

---

## After this plan

- Point the Frame web-export session's handoff note at `prepareMotionFramePainter` and `recordEmbed` (controller, one line under "Landed notes").
- Plan 3 (the timeline) follows.
