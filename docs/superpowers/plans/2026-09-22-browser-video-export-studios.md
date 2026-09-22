# Browser Video Export — Plan 1 of 3: the recorder and the four studios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every video export in Shader, Gradient, Space Type and 3D Studio is recorded in the browser (mediabunny) instead of by the server, with a visible fallback, a Cancel button, and a quality gate proving the browser file is at least as good as the server's.

**Architecture:** A recorder (`videoRecorder.ts`) turns "draw frame i onto this 2D canvas" into an MP4 or transparent WebM in memory, frame by frame. A publisher uploads the one finished file where studio videos land today (`input/`). A small orchestrator (`studioVideoExport.ts`) checks the browser can do it, runs the recorder, and — only in local mode — falls back to today's server route with a visible notice. Each studio keeps its own frame drawing and only swaps the last step.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4), `mediabunny` (MPL-2.0, v1.59.x), WebCodecs, Vitest (unit, `tests/unit/**/*.unit.spec.ts`), Playwright (browser, `tests/*.spec.ts`, project `chromium`), Python + PyAV in `.venv` for file checks.

**Spec:** `docs/superpowers/specs/2026-09-21-browser-video-export-design.md` — read its summary, "Components" and "Correctness gates" before starting.

## Plain-language summary

- **What changes for you:** in Shader, Gradient, Space Type and 3D Studio, "Download video" and "As video" make the video in the browser. It should be much faster, it works in hosted mode, and there is a Cancel button while it runs.
- **What stays the same:** the buttons, where files land, the Assets entry, the Video node on the canvas, MP4 by default and transparent WebM for Space Type's transparent option.
- **If the browser can't do it:** in local mode it quietly uses today's server route **and says so** in the footer; in hosted mode it shows a clear message. A switch (`localStorage['Sailor.VideoExport'] = 'server'`) forces the old route in local mode — useful for comparing, and an escape hatch while the new route proves itself.
- **Proof before switching:** a browser test records a known test pattern, reads the file back and checks the frame count, the length, the colour standard (BT.709) and how close the pixels are to the source — against the server's own file of the same frames. Each studio is then exported both ways and the two files compared.
- **Not in this plan:** the Frame/Compositor (plan 2 — waits for the parallel Frame web-export session so the two never edit how a Frame draws at the same time) and the Timeline (plan 3 — needs sound, plain text clips in the preview, and a timing check). Retiring the server's studio encode route happens after plan 3 plus a two-week proving period.

## Global Constraints

- Work directly in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch. Never `git stash`. Never touch files you did not write, even if they look broken — other sessions share this checkout.
- **Subagents do not commit.** They implement, run tests, and report changed paths plus test evidence. The controller commits with the private-index recipe below.
- **Never run `npm run dev`** or start/stop any server. The dev server for this checkout is `http://127.0.0.1:3002`; ComfyUI is `http://127.0.0.1:8188`. Use `127.0.0.1`, not `localhost`.
- Unit tests (from `frontend/`): `npx vitest run tests/unit/<file>`. Browser tests (from `frontend/`): `npx playwright test tests/<file> --project=chromium`.
- Typecheck judged against the baseline: from `frontend/`, `npx vue-tsc --noEmit 2>&1 | grep -E "<the files you touched>"` before and after your edits (allow 10 minutes). Only NEW lines count.
- UI copy is sentence case, plain words, no internal identifiers.
- Do not change `comfy_extras/` in this plan. Do not edit anything under `frontend/app/lib/embed/`.
- Colour tag on every recorded file: `{ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }` (what the server writes today via `_apply_bt709`).
- Frame timestamps come from the frame index only: frame `i` is at `i / fps` seconds, duration `1 / fps`. Never a clock.
- Width and height are rounded UP to even numbers before encoding.
- A quiet fallback is forbidden: every fallback shows a notice the user can see.
- A WebGL canvas must be copied into the recorder's 2D canvas right after the render call, with no `await` between the render and the copy.
- Hosted upload limit: 100 MB (`MAX_UPLOAD_BYTES` in `frontend/server/utils/engineGate.ts`). Uploads use a unique filename and **no** `overwrite` field.
- After every commit the controller updates `docs/STATE.md` and the "Sailor — State of the Build" dashboard artifact (replace, don't append).

**Controller commit recipe** — one Bash call to commit, a SEPARATE Bash call to resync:

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp -u) && export GIT_INDEX_FILE="$IDX" && git read-tree HEAD && git add -- <exact paths> && git diff --cached --name-only && git commit -q -m "<message>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && rm -f "$IDX"
```

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <the same exact paths> && git status --short -- <the same exact paths>
```

`package.json` / lockfile changes in Task 1: commit only the mediabunny lines (check `git diff frontend/package.json` shows nothing else of yours or someone else's; if another session has unrelated edits there, stage with `git add -p` limited to the mediabunny hunk).

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/engine/videoRecorder.ts` (new) | Frames → video file in memory. Knows nothing about studios. Mediabunny is injectable for tests. |
| `frontend/app/lib/engine/publishVideo.ts` (new) | Upload one finished video to `input/`, return its filename. |
| `frontend/app/lib/engine/videoExportSupport.ts` (new) | Can this browser record this video? Has the user forced the server route? |
| `frontend/app/lib/studio/studioVideoExport.ts` (new) | The studios' one entry point: check → record → publish, or visible server fallback. Also `resultBlob`, `videoErrorText`. |
| `frontend/app/pages/dev/video-export-harness.vue` (new) | Dev page the browser test drives: records a test pattern, reads files back, measures them. |
| `frontend/tests/browser-video-export.spec.ts` (new) | The quality gate, kept in the repo. |
| `frontend/tests/tools/compare_videos.py` (new) | Compare two video files: frames, colour tags, alpha, pixel difference. |
| `frontend/app/components/vue-canvas/ShaderStudioSurface.vue` | Task 4: swap the export tail, add Cancel. |
| `frontend/app/lib/gradientfx/renderer.ts`, `GradientStudioSurface.vue` | Task 5. |
| `frontend/app/lib/spacetype/engine.ts`, `SpaceTypeSurface.vue` | Task 6. |
| `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` | Task 7. |

---

### Task 1: The recorder

**Files:**
- Modify: `frontend/package.json` (+ lockfile) — add `mediabunny`
- Create: `frontend/app/lib/engine/videoRecorder.ts`
- Test: `frontend/tests/unit/video-recorder.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface RecordRequest { width: number; height: number; fps: number; frameCount: number; drawFrame: (i: number, ctx: CanvasRenderingContext2D) => Promise<void> | void; alpha?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }`
  - `interface RecordResult { blob: Blob; ext: 'mp4' | 'webm'; contentType: string; width: number; height: number }`
  - `interface RecordingPlan { width: number; height: number; fps: number; frameCount: number; alpha: boolean; codec: 'avc' | 'vp9'; ext: 'mp4' | 'webm'; contentType: string }`
  - `planRecording(req: Pick<RecordRequest, 'width' | 'height' | 'fps' | 'frameCount' | 'alpha'>): RecordingPlan`
  - `recordVideo(req: RecordRequest, deps?: RecorderDeps): Promise<RecordResult>`
  - `interface RecorderDeps { lib?: MediabunnyLike; createCanvas?: (w: number, h: number) => { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D } }`
  - `const BT709`, `const RECORD_QUALITY: 'high' | 'very-high'`, `isAbortError(e: unknown): boolean`, `throwIfAborted(signal?: AbortSignal): void`

- [ ] **Step 1: Add the dependency**

From `frontend/`: `npm install mediabunny@^1.59.0`
Then `git diff package.json` — expected: ONE new line `"mediabunny": "^1.59.0"` in `dependencies`. If npm reformatted or touched anything else, report it.

- [ ] **Step 2: Write the failing test**

Create `frontend/tests/unit/video-recorder.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planRecording, recordVideo, isAbortError, BT709 } from '../../app/lib/engine/videoRecorder'

// A fake mediabunny that records what the recorder asks of it. The real library
// needs WebCodecs; this checks the ORCHESTRATION: order, timestamps, colour tag,
// cleanup, cancel. The real encode is proven by tests/browser-video-export.spec.ts.
function fakeLib() {
  const log: any = { samples: [] as any[], closed: 0, started: false, finalized: false, cancelled: false, track: null, source: null, format: null }
  class BufferTarget { buffer: ArrayBuffer | null = null }
  class Mp4OutputFormat { kind = 'mp4'; constructor(public opts?: any) {} }
  class WebMOutputFormat { kind = 'webm'; constructor(public opts?: any) {} }
  class Quality { constructor(public level: any) {} }
  class VideoSample {
    constructor(public data: any, public init: any) { log.samples.push({ init, snapshot: data.snapshot?.() }) }
    close() { log.closed++ }
  }
  class VideoSampleSource {
    constructor(public config: any) { log.source = config }
    async add(_s: any) {}
  }
  class Output {
    constructor(public opts: any) { log.format = opts.format }
    addVideoTrack(_src: any, meta: any) { log.track = meta }
    async start() { log.started = true }
    async finalize() { log.finalized = true; this.opts.target.buffer = new ArrayBuffer(16) }
    async cancel() { log.cancelled = true }
  }
  return { lib: { BufferTarget, Mp4OutputFormat, WebMOutputFormat, Quality, VideoSample, VideoSampleSource, Output } as any, log }
}

// A fake 2D context that remembers how each frame was prepared.
function fakeCanvas(w: number, h: number) {
  const ops: string[] = []
  const ctx: any = {
    canvas: { width: w, height: h },
    fillStyle: '',
    setTransform: () => {},
    fillRect: (x: number, y: number, fw: number, fh: number) => ops.push(`fill ${ctx.fillStyle} ${x},${y},${fw},${fh}`),
    clearRect: (x: number, y: number, fw: number, fh: number) => ops.push(`clear ${x},${y},${fw},${fh}`),
  }
  const canvas: any = { width: w, height: h, snapshot: () => ops.slice() }
  return { canvas, ctx, ops }
}

describe('planRecording', () => {
  it('opaque → H.264 in MP4', () => {
    expect(planRecording({ width: 1920, height: 1080, fps: 30, frameCount: 90 })).toEqual({
      width: 1920, height: 1080, fps: 30, frameCount: 90, alpha: false, codec: 'avc', ext: 'mp4', contentType: 'video/mp4',
    })
  })

  it('transparent → VP9 in WebM', () => {
    const p = planRecording({ width: 640, height: 360, fps: 24, frameCount: 10, alpha: true })
    expect([p.codec, p.ext, p.contentType, p.alpha]).toEqual(['vp9', 'webm', 'video/webm', true])
  })

  it('rounds odd sizes UP to even and fractional sizes to whole pixels', () => {
    const p = planRecording({ width: 641, height: 360.4, fps: 30, frameCount: 1 })
    expect([p.width, p.height]).toEqual([642, 362])
  })

  it('refuses nonsense', () => {
    expect(() => planRecording({ width: 0, height: 10, fps: 30, frameCount: 1 })).toThrow()
    expect(() => planRecording({ width: 10, height: 10, fps: 0, frameCount: 1 })).toThrow()
    expect(() => planRecording({ width: 10, height: 10, fps: 30, frameCount: 0 })).toThrow()
  })
})

describe('recordVideo', () => {
  it('draws every frame in order on a black ground, stamps i/fps, tags BT.709, closes each sample', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(4, 2)
    const drawn: number[] = []
    const progress: number[] = []
    const res = await recordVideo(
      { width: 4, height: 2, fps: 25, frameCount: 3, drawFrame: i => { drawn.push(i); c.ops.push(`draw ${i}`) }, onProgress: d => progress.push(d) },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    expect(drawn).toEqual([0, 1, 2])
    expect(progress).toEqual([1, 2, 3])
    expect(log.samples.map((s: any) => s.init.timestamp)).toEqual([0, 0.04, 0.08])
    expect(log.samples.every((s: any) => s.init.duration === 0.04)).toBe(true)
    expect(log.samples[0].init.colorSpace).toEqual(BT709)
    // Each frame starts from a black fill, then the surface draws on top.
    expect(log.samples[1].snapshot.slice(-2)).toEqual(['fill #000000 0,0,4,2', 'draw 1'])
    expect(log.closed).toBe(3)
    expect(log.source.codec).toBe('avc')
    expect(log.source.alpha).toBe('discard')
    expect(log.track.frameRate).toBe(25)
    expect(log.format.kind).toBe('mp4')
    expect(log.finalized).toBe(true)
    expect(res.ext).toBe('mp4')
    expect(res.blob.type).toBe('video/mp4')
    expect(res.blob.size).toBe(16)
  })

  it('transparent: clears instead of filling, and keeps alpha', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 1, alpha: true, drawFrame: () => { c.ops.push('draw') } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    expect(log.samples[0].snapshot.slice(-2)).toEqual(['clear 0,0,2,2', 'draw'])
    expect(log.source.codec).toBe('vp9')
    expect(log.source.alpha).toBe('keep')
    expect(log.format.kind).toBe('webm')
  })

  it('cancel: stops with an AbortError, cancels the output, never finalizes', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const ac = new AbortController()
    const run = recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 10, signal: ac.signal, drawFrame: i => { if (i === 3) ac.abort() } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    const err = await run.then(() => null, e => e)
    expect(isAbortError(err)).toBe(true)
    expect(log.cancelled).toBe(true)
    expect(log.finalized).toBe(false)
    expect(log.samples.length).toBeLessThanOrEqual(4)
  })

  it('a failing frame cancels the output and passes the error on', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const err = await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 5, drawFrame: i => { if (i === 2) throw new Error('boom') } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    ).then(() => null, e => e)
    expect(err?.message).toBe('boom')
    expect(isAbortError(err)).toBe(false)
    expect(log.cancelled).toBe(true)
    expect(log.finalized).toBe(false)
  })
})
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/unit/video-recorder.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/engine/videoRecorder`.

- [ ] **Step 4: Write the recorder**

Create `frontend/app/lib/engine/videoRecorder.ts`:

```ts
import type * as Mediabunny from 'mediabunny'

// Frames → a video file, in the browser. The caller says how big, how fast, how
// many frames, and how to draw frame i onto a 2D canvas; this asks for the
// frames one at a time and encodes each as it arrives, so memory stays flat
// however long the video is. It knows nothing about studios, Frames or the
// timeline. Spec: docs/superpowers/specs/2026-09-21-browser-video-export-design.md

export interface RecordRequest {
  width: number
  height: number
  fps: number
  frameCount: number
  /** Draw frame i onto `ctx` (already cleared, or filled black when opaque).
   *  May await (a video decode, a font). A WebGL source must be copied onto
   *  `ctx` right after its render call, with no await in between. */
  drawFrame: (i: number, ctx: CanvasRenderingContext2D) => Promise<void> | void
  /** True → VP9 in WebM with an alpha plane. Otherwise H.264 in MP4. */
  alpha?: boolean
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface RecordResult {
  blob: Blob
  ext: 'mp4' | 'webm'
  contentType: string
  width: number
  height: number
}

export interface RecordingPlan {
  width: number
  height: number
  fps: number
  frameCount: number
  alpha: boolean
  codec: 'avc' | 'vp9'
  ext: 'mp4' | 'webm'
  contentType: string
}

/** The colour standard the server tags today (nodes_timeline.py _apply_bt709). */
export const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const

/** Encoder quality. Set by the browser quality gate (Task 3): 'high' unless the
 *  gate showed it falls short of the server's files. */
export const RECORD_QUALITY: 'high' | 'very-high' = 'high'

export type MediabunnyLike = Pick<typeof Mediabunny,
  'Output' | 'BufferTarget' | 'Mp4OutputFormat' | 'WebMOutputFormat' | 'VideoSampleSource' | 'VideoSample' | 'Quality'>

export interface RecorderDeps {
  lib?: MediabunnyLike
  createCanvas?: (w: number, h: number) => { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D }
}

// Round up to a whole pixel, then up to even.
const even = (n: number) => { const r = Math.ceil(n); return r + (r % 2) }

export function planRecording(req: Pick<RecordRequest, 'width' | 'height' | 'fps' | 'frameCount' | 'alpha'>): RecordingPlan {
  if (!(req.width >= 1) || !(req.height >= 1)) throw new Error(`video recorder: bad size ${req.width}×${req.height}`)
  if (!(req.fps > 0)) throw new Error(`video recorder: bad frame rate ${req.fps}`)
  if (!(req.frameCount >= 1)) throw new Error(`video recorder: bad frame count ${req.frameCount}`)
  const alpha = !!req.alpha
  return {
    width: even(req.width),
    height: even(req.height),
    fps: req.fps,
    frameCount: Math.round(req.frameCount),
    alpha,
    codec: alpha ? 'vp9' : 'avc',
    ext: alpha ? 'webm' : 'mp4',
    contentType: alpha ? 'video/webm' : 'video/mp4',
  }
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

function defaultCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) throw new Error('video recorder: no 2D canvas')
  return { canvas, ctx }
}

export async function recordVideo(req: RecordRequest, deps: RecorderDeps = {}): Promise<RecordResult> {
  const plan = planRecording(req)
  throwIfAborted(req.signal)
  const mb: MediabunnyLike = deps.lib ?? await import('mediabunny')
  const { canvas, ctx } = (deps.createCanvas ?? defaultCanvas)(plan.width, plan.height)

  const target = new mb.BufferTarget()
  const format = plan.ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat()
  const output = new mb.Output({ format, target })
  const source = new mb.VideoSampleSource({
    codec: plan.codec,
    quality: new mb.Quality(RECORD_QUALITY),
    alpha: plan.alpha ? 'keep' : 'discard',
  })
  output.addVideoTrack(source, { frameRate: plan.fps })
  await output.start()

  const dt = 1 / plan.fps
  try {
    for (let i = 0; i < plan.frameCount; i++) {
      throwIfAborted(req.signal)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (plan.alpha) {
        ctx.clearRect(0, 0, plan.width, plan.height)
      } else {
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, plan.width, plan.height)
      }
      await req.drawFrame(i, ctx)
      throwIfAborted(req.signal)
      const sample = new mb.VideoSample(canvas, { timestamp: i * dt, duration: dt, colorSpace: BT709 })
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
      req.onProgress?.(i + 1, plan.frameCount)
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  }

  const buffer = target.buffer
  if (!buffer) throw new Error('video recorder: the encoder produced no file')
  return {
    blob: new Blob([buffer], { type: plan.contentType }),
    ext: plan.ext,
    contentType: plan.contentType,
    width: plan.width,
    height: plan.height,
  }
}
```

Note on the test's timestamps: `i * dt` with `dt = 1/25` gives exactly `0, 0.04, 0.08` in floating point. If a runtime ever produced `0.08000000000000002`, change the test's third expected value — never the formula.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/video-recorder.unit.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck**

`npx vue-tsc --noEmit 2>&1 | grep -E "engine/videoRecorder\.ts|unit/video-recorder"` — expected: nothing. If `VideoSampleSource`'s config rejects `alpha`, check `VideoEncodingConfig` in `node_modules/mediabunny/dist/mediabunny.d.ts` (it ends `& VideoEncodingAdditionalOptions`, which carries `alpha`) and report rather than cast it away.

- [ ] **Step 7: Commit (controller)**

Paths: `frontend/package.json`, the lockfile the repo uses (check which of `frontend/package-lock.json` / `frontend/pnpm-lock.yaml` changed), `frontend/app/lib/engine/videoRecorder.ts`, `frontend/tests/unit/video-recorder.unit.spec.ts`
Message: `feat(export): browser video recorder — frames to MP4 / transparent WebM with mediabunny, BT.709, cancel`

---

### Task 2: Publish, support check, and the studios' one entry point

**Files:**
- Create: `frontend/app/lib/engine/publishVideo.ts`
- Create: `frontend/app/lib/engine/videoExportSupport.ts`
- Create: `frontend/app/lib/studio/studioVideoExport.ts`
- Test: `frontend/tests/unit/studio-video-export.unit.spec.ts`

**Interfaces:**
- Consumes (Task 1): `recordVideo`, `RecordRequest`, `RecordResult`, `planRecording`, `isAbortError`.
- Produces:
  - `publishVideo(blob: Blob, ext: 'mp4' | 'webm', prefix: string, fetchImpl?: FetchLike): Promise<string>`; `HOSTED_UPLOAD_LIMIT = 100 * 1024 * 1024`
  - `canRecordInBrowser(o: { width: number; height: number; fps: number; alpha?: boolean }): Promise<boolean>`; `prefersServerVideoExport(): boolean`; `VIDEO_EXPORT_PREF_KEY = 'Sailor.VideoExport'`
  - `interface StudioVideoRequest extends RecordRequest { prefix: string; publish: boolean; serverFallback: () => Promise<{ filename: string; ext: 'mp4' | 'webm' } | null> }`
  - `interface StudioVideoResult { ext: 'mp4' | 'webm'; blob: Blob | null; filename: string | null; via: 'browser' | 'server'; notice: string | null }`
  - `interface StudioVideoDeps { hosted: boolean; forceServer?: boolean; canRecord?: typeof canRecordInBrowser; record?: typeof recordVideo; publish?: typeof publishVideo }`
  - `exportStudioVideo(req: StudioVideoRequest, deps: StudioVideoDeps): Promise<StudioVideoResult | null>`
  - `resultBlob(r: StudioVideoResult, fetchImpl?: typeof fetch): Promise<Blob>`
  - `videoErrorText(e: unknown): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/studio-video-export.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { exportStudioVideo, resultBlob, videoErrorText } from '../../app/lib/studio/studioVideoExport'
import { publishVideo } from '../../app/lib/engine/publishVideo'

const recorded = { blob: new Blob(['x'], { type: 'video/mp4' }), ext: 'mp4' as const, contentType: 'video/mp4', width: 4, height: 2 }
const base = {
  prefix: 'shader', width: 4, height: 2, fps: 30, frameCount: 3,
  drawFrame: () => {},
}
const server = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))

describe('exportStudioVideo', () => {
  it('records in the browser and publishes when asked', async () => {
    const publish = vi.fn(async () => 'shader_9.mp4')
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r).toEqual({ ext: 'mp4', blob: recorded.blob, filename: 'shader_9.mp4', via: 'browser', notice: null })
    expect(publish).toHaveBeenCalledWith(recorded.blob, 'mp4', 'shader')
  })

  it('a download-only export never uploads', async () => {
    const publish = vi.fn()
    const r = await exportStudioVideo({ ...base, publish: false, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r?.filename).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })

  it('local: a browser that cannot record falls back to the server, and says so', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => false, record: async () => { throw new Error('not called') } })
    expect(r?.via).toBe('server')
    expect(r?.filename).toBe('spacetype_1.mp4')
    expect(r?.blob).toBeNull()
    expect(r?.notice).toBe("Made on the server, because this browser can't record video.")
  })

  it('local: a recording that fails falls back to the server, and says why', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => { throw new Error('encoder crashed') } })
    expect(r?.via).toBe('server')
    expect(r?.notice).toBe('Made on the server, because the browser could not record it (encoder crashed).')
  })

  it('hosted: no server fallback — a clear error instead', async () => {
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: true, canRecord: async () => false }).then(() => null, e => e)
    expect(err?.message).toBe("Video export failed: this browser can't record video.")
  })

  it('cancel is never turned into a fallback', async () => {
    const abort = new DOMException('Export cancelled', 'AbortError')
    const fallback = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: fallback },
      { hosted: false, canRecord: async () => true, record: async () => { throw abort } }).then(() => null, e => e)
    expect(err).toBe(abort)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('an upload failure after a good recording is an error, not a fallback', async () => {
    const fallback = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: fallback },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish: async () => { throw new Error('video upload failed (500)') } })
      .then(() => null, e => e)
    expect(err?.message).toBe('video upload failed (500)')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('the server switch skips the browser in local mode, and says so; hosted ignores it', async () => {
    const record = vi.fn(async () => recorded)
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, forceServer: true, canRecord: async () => true, record })
    expect(r?.via).toBe('server')
    expect(r?.notice).toBe('Made on the server (browser recording is switched off).')
    expect(record).not.toHaveBeenCalled()
    const h = await exportStudioVideo({ ...base, publish: false, serverFallback: server },
      { hosted: true, forceServer: true, canRecord: async () => true, record })
    expect(h?.via).toBe('browser')
  })

  it('a fallback that makes nothing returns null', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: async () => null },
      { hosted: false, canRecord: async () => false })
    expect(r).toBeNull()
  })
})

describe('resultBlob', () => {
  it('uses the browser blob, or fetches the server file', async () => {
    const b = new Blob(['y'])
    expect(await resultBlob({ ext: 'mp4', blob: b, filename: null, via: 'browser', notice: null })).toBe(b)
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => b })) as any
    expect(await resultBlob({ ext: 'mp4', blob: null, filename: 'a b.mp4', via: 'server', notice: null }, fetchImpl)).toBe(b)
    expect(fetchImpl).toHaveBeenCalledWith('/view?filename=a+b.mp4&type=input')
  })
})

describe('videoErrorText', () => {
  it('passes our own plain messages through and hides internals', () => {
    expect(videoErrorText(new Error("Video export failed: this browser can't record video."))).toBe("Video export failed: this browser can't record video.")
    expect(videoErrorText(new Error('This video is larger than 100 MB, the upload limit.'))).toBe('This video is larger than 100 MB, the upload limit.')
    expect(videoErrorText(new Error('TypeError: x is undefined'))).toBe('Video export failed — see console.')
  })
})

describe('publishVideo', () => {
  it('uploads one file under a unique name, without overwrite', async () => {
    let sent: FormData | null = null
    const fetchImpl = vi.fn(async (_u: string, init: any) => { sent = init.body; return { ok: true, status: 200, json: async () => ({ name: 'shader_1.mp4', subfolder: '' }) } }) as any
    const name = await publishVideo(new Blob(['v'], { type: 'video/mp4' }), 'mp4', 'shader', fetchImpl)
    expect(name).toBe('shader_1.mp4')
    expect(fetchImpl.mock.calls[0][0]).toBe('/upload/image')
    const file = sent!.get('image') as File
    expect(file.name).toMatch(/^shader_\d+\.mp4$/)
    expect(file.type).toBe('video/mp4')
    expect(sent!.has('overwrite')).toBe(false)
  })

  it('keeps a subfolder, and explains the 100 MB limit', async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: 'v.webm', subfolder: 'sub' }) })) as any
    expect(await publishVideo(new Blob(['v']), 'webm', 'x', ok)).toBe('sub/v.webm')
    const big = vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) })) as any
    await expect(publishVideo(new Blob(['v']), 'mp4', 'x', big)).rejects.toThrow('This video is larger than 100 MB, the upload limit.')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/studio-video-export.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/studio/studioVideoExport`.

- [ ] **Step 3: Write the three modules**

Create `frontend/app/lib/engine/publishVideo.ts`:

```ts
// Put one finished video where studio videos land today (input/), so the
// download link, Assets and the canvas Video node work unchanged. One upload of
// one file — the old route uploaded every frame as a PNG.

/** The hosted proxy's upload cap (server/utils/engineGate.ts MAX_UPLOAD_BYTES). */
export const HOSTED_UPLOAD_LIMIT = 100 * 1024 * 1024

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>

export async function publishVideo(
  blob: Blob, ext: 'mp4' | 'webm', prefix: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const name = `${prefix}_${Date.now()}.${ext}`
  const fd = new FormData()
  fd.append('image', new File([blob], name, { type: blob.type || (ext === 'webm' ? 'video/webm' : 'video/mp4') }))
  // No `overwrite`: the name is unique, and hosted mode refuses an overwrite of
  // a file this user does not own.
  const res = await fetchImpl('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) {
    throw new Error(res.status === 413 ? 'This video is larger than 100 MB, the upload limit.' : `video upload failed (${res.status})`)
  }
  const data = await res.json().catch(() => ({}) as any)
  return data?.subfolder ? `${data.subfolder}/${data.name}` : (data?.name || name)
}
```

Create `frontend/app/lib/engine/videoExportSupport.ts`:

```ts
import { planRecording } from './videoRecorder'

/** localStorage switch: 'server' forces today's server route in local mode —
 *  for comparing the two routes, and as an escape hatch while the browser
 *  route proves itself. Hosted mode ignores it (it has no server route). */
export const VIDEO_EXPORT_PREF_KEY = 'Sailor.VideoExport'

export function prefersServerVideoExport(): boolean {
  try {
    return globalThis.localStorage?.getItem(VIDEO_EXPORT_PREF_KEY) === 'server'
  } catch {
    return false
  }
}

/** Can this browser encode this video? False when WebCodecs is missing, the
 *  codec or size is unsupported, or the check itself fails. */
export async function canRecordInBrowser(o: { width: number; height: number; fps: number; alpha?: boolean }): Promise<boolean> {
  if (typeof globalThis.VideoEncoder === 'undefined') return false
  try {
    const plan = planRecording({ ...o, frameCount: 1 })
    const { canEncodeVideo } = await import('mediabunny')
    return await canEncodeVideo(plan.codec, {
      width: plan.width, height: plan.height, frameRate: plan.fps,
      alpha: plan.alpha ? 'keep' : 'discard',
    })
  } catch {
    return false
  }
}
```

Create `frontend/app/lib/studio/studioVideoExport.ts`:

```ts
import { recordVideo, isAbortError, type RecordRequest } from '~/lib/engine/videoRecorder'
import { publishVideo } from '~/lib/engine/publishVideo'
import { canRecordInBrowser } from '~/lib/engine/videoExportSupport'

// The studios' one way to make a video. Record in the browser; when that is
// impossible or fails, fall back to the server route — in local mode only, and
// never quietly: the result carries a notice the studio must show.

export interface StudioVideoRequest extends RecordRequest {
  /** Filename prefix for the published file, e.g. 'shader'. */
  prefix: string
  /** True → upload the file to input/ (for Assets / a canvas Video node). */
  publish: boolean
  /** Today's route: bake PNGs, upload, server-encode. Returns null when it
   *  already reported its own failure to the user. */
  serverFallback: () => Promise<{ filename: string; ext: 'mp4' | 'webm' } | null>
}

export interface StudioVideoResult {
  ext: 'mp4' | 'webm'
  /** The file, when the browser made it. */
  blob: Blob | null
  /** input/ filename, when published or made by the server. */
  filename: string | null
  via: 'browser' | 'server'
  /** Shown to the user when set (a fallback happened). */
  notice: string | null
}

export interface StudioVideoDeps {
  hosted: boolean
  forceServer?: boolean
  canRecord?: typeof canRecordInBrowser
  record?: typeof recordVideo
  publish?: typeof publishVideo
}

export async function exportStudioVideo(req: StudioVideoRequest, deps: StudioVideoDeps): Promise<StudioVideoResult | null> {
  const canRecord = deps.canRecord ?? canRecordInBrowser
  const record = deps.record ?? recordVideo
  const publish = deps.publish ?? publishVideo

  let reason = ''   // stays empty only when the server route was chosen on purpose
  if (deps.forceServer && !deps.hosted) {
    // Local escape hatch: go straight to the server route.
  } else if (!(await canRecord({ width: req.width, height: req.height, fps: req.fps, alpha: req.alpha }))) {
    reason = "this browser can't record video"
  } else {
    let rec: Awaited<ReturnType<typeof recordVideo>> | null = null
    try {
      rec = await record(req)
    } catch (err) {
      if (isAbortError(err)) throw err
      console.warn('[video export] browser recording failed', err)
      reason = `the browser could not record it (${err instanceof Error ? err.message : String(err)})`
    }
    if (rec) {
      // An upload failure is NOT a reason to re-make the video on the server:
      // that route uploads far more, and would fail the same way.
      const filename = req.publish ? await publish(rec.blob, rec.ext, req.prefix) : null
      return { ext: rec.ext, blob: rec.blob, filename, via: 'browser', notice: null }
    }
  }

  if (deps.hosted) throw new Error(`Video export failed: ${reason}.`)
  const made = await req.serverFallback()
  if (!made) return null
  return {
    ext: made.ext,
    blob: null,
    filename: made.filename,
    via: 'server',
    notice: reason ? `Made on the server, because ${reason}.` : 'Made on the server (browser recording is switched off).',
  }
}

/** The finished file as a Blob, wherever it was made. */
export async function resultBlob(r: StudioVideoResult, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  if (r.blob) return r.blob
  if (!r.filename) throw new Error('video export: nothing to download')
  const res = await fetchImpl(`/view?${new URLSearchParams({ filename: r.filename, type: 'input' })}`)
  if (!res.ok) throw new Error(`/view returned ${res.status}`)
  return res.blob()
}

/** What a studio shows when an export fails: our own plain messages as they
 *  are, anything else (a bug) as a pointer to the console. */
export function videoErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (msg.startsWith('Video export failed') || msg.startsWith('This video is larger')) return msg
  return 'Video export failed — see console.'
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/studio-video-export.unit.spec.ts tests/unit/video-recorder.unit.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck**

`npx vue-tsc --noEmit 2>&1 | grep -E "engine/(publishVideo|videoExportSupport)\.ts|studio/studioVideoExport\.ts|unit/studio-video-export"` — expected: nothing new.

- [ ] **Step 6: Commit (controller)**

Paths: the three new modules + the spec.
Message: `feat(export): studios' video entry point — record in the browser, publish one file, visible server fallback in local mode`

---

### Task 3: The browser quality gate

This proves the recorder on real hardware encoders BEFORE any studio switches, and settles `RECORD_QUALITY`.

**Files:**
- Create: `frontend/app/pages/dev/video-export-harness.vue`
- Create: `frontend/tests/browser-video-export.spec.ts`
- Create: `frontend/tests/tools/compare_videos.py`
- Possibly modify: `frontend/app/lib/engine/videoRecorder.ts` (only `RECORD_QUALITY`, see Step 5)

**Interfaces:**
- Consumes: `recordVideo` (Task 1); `uploadFrameBatch` (`~/lib/studio/frameUpload`); `encodeFrames` (`~/lib/engine/encodeVideo`).
- Produces: `window.__videoHarness = { run(o), runServer(o), runCancel(o) }` where `o = { width, height, fps, frames, alpha }` and each returns `Metrics = { frames: number; duration: number; width: number; height: number; colorSpace: { primaries?: string; transfer?: string; matrix?: string; fullRange?: boolean }; mae: number; alphaMin: number; alphaMax: number; bytes: number; ms: number }`; `runCancel` returns `{ name: string }`.

- [ ] **Step 1: The harness page**

Create `frontend/app/pages/dev/video-export-harness.vue` (dev pages here are plain pages; mirror `app/pages/dev/shaderfx-harness.vue` — if it has a `definePageMeta`, copy it):

```vue
<template>
  <div style="padding: 8px; font: 12px monospace">video export harness ready</div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { recordVideo } from '~/lib/engine/videoRecorder'
import { uploadFrameBatch } from '~/lib/studio/frameUpload'
import { encodeFrames } from '~/lib/engine/encodeVideo'

interface Opts { width: number; height: number; fps: number; frames: number; alpha: boolean }

// A test pattern with flat colours, a smooth ramp and a moving block: colour
// errors show on the bars, banding on the ramp, frame mix-ups on the block.
// The recorder has already filled black (opaque) or cleared (transparent).
function paintTestFrame(ctx: CanvasRenderingContext2D, i: number, w: number, h: number, alpha: boolean) {
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#101010']
  const bw = w / bars.length
  bars.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(Math.round(k * bw), 0, Math.ceil(bw), Math.round(h * 0.6)) })
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, '#000000'); g.addColorStop(1, '#ffffff')
  ctx.fillStyle = g; ctx.fillRect(0, Math.round(h * 0.6), w, Math.round(h * 0.2))
  ctx.fillStyle = '#ffffff'; ctx.fillRect((i * 8) % Math.max(1, w - 40), Math.round(h * 0.82), 40, Math.round(h * 0.16))
  if (alpha) ctx.clearRect(0, 0, Math.round(w / 4), h)   // a fully transparent band
}

function referenceCanvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! }
}

async function readBack(blob: Blob, o: Opts, ms: number) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('no video track')
  const colorSpace = await track.getColorSpace()
  const duration = await input.computeDuration()
  const width = await track.getDisplayWidth()
  const height = await track.getDisplayHeight()
  const sink = new CanvasSink(track, { alpha: o.alpha })
  const ref = referenceCanvas(o.width, o.height)
  const got = referenceCanvas(o.width, o.height)
  let frames = 0, errSum = 0, alphaMin = 255, alphaMax = 0
  for await (const wc of sink.canvases()) {
    ref.ctx.clearRect(0, 0, o.width, o.height)
    if (!o.alpha) { ref.ctx.fillStyle = '#000000'; ref.ctx.fillRect(0, 0, o.width, o.height) }
    paintTestFrame(ref.ctx, frames, o.width, o.height, o.alpha)
    got.ctx.clearRect(0, 0, o.width, o.height)
    got.ctx.drawImage(wc.canvas as CanvasImageSource, 0, 0, o.width, o.height, 0, 0, o.width, o.height)
    const a = ref.ctx.getImageData(0, 0, o.width, o.height).data
    const b = got.ctx.getImageData(0, 0, o.width, o.height).data
    let s = 0, n = 0
    for (let p = 0; p < a.length; p += 4) {
      alphaMin = Math.min(alphaMin, b[p + 3]!); alphaMax = Math.max(alphaMax, b[p + 3]!)
      if (a[p + 3] !== 255) continue   // colour of a transparent pixel means nothing
      s += Math.abs(a[p]! - b[p]!) + Math.abs(a[p + 1]! - b[p + 1]!) + Math.abs(a[p + 2]! - b[p + 2]!); n += 3
    }
    errSum += n ? s / n : 0
    frames++
  }
  return { frames, duration, width, height, colorSpace, mae: errSum / Math.max(1, frames), alphaMin, alphaMax, bytes: blob.size, ms }
}

async function run(o: Opts) {
  const t0 = performance.now()
  const rec = await recordVideo({
    width: o.width, height: o.height, fps: o.fps, frameCount: o.frames, alpha: o.alpha,
    drawFrame: (i, ctx) => paintTestFrame(ctx, i, o.width, o.height, o.alpha),
  })
  return readBack(rec.blob, o, performance.now() - t0)
}

async function runServer(o: Opts) {
  const t0 = performance.now()
  const { c, ctx } = referenceCanvas(o.width, o.height)
  const blobs: Blob[] = []
  for (let i = 0; i < o.frames; i++) {
    ctx.clearRect(0, 0, o.width, o.height)
    if (!o.alpha) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, o.width, o.height) }
    paintTestFrame(ctx, i, o.width, o.height, o.alpha)
    blobs.push(await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png')))
  }
  const frames = await uploadFrameBatch(blobs, 'vtest')
  const enc = await encodeFrames({ frames, fps: o.fps, width: o.width, height: o.height, alpha: o.alpha })
  const res = await fetch(`/view?${new URLSearchParams({ filename: enc.filename, type: 'input' })}`)
  if (!res.ok) throw new Error(`/view ${res.status}`)
  return readBack(await res.blob(), o, performance.now() - t0)
}

async function runCancel(o: Opts) {
  const ac = new AbortController()
  try {
    await recordVideo({
      width: o.width, height: o.height, fps: o.fps, frameCount: o.frames, alpha: o.alpha, signal: ac.signal,
      drawFrame: (i, ctx) => { if (i === 5) ac.abort(); paintTestFrame(ctx, i, o.width, o.height, o.alpha) },
    })
    return { name: 'finished' }
  } catch (e) {
    return { name: (e as Error).name }
  }
}

onMounted(() => { (window as any).__videoHarness = { run, runServer, runCancel } })
</script>
```

- [ ] **Step 2: The browser test**

Create `frontend/tests/browser-video-export.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test'

// Quality gate for the browser video recorder (spec: docs/superpowers/specs/
// 2026-09-21-browser-video-export-design.md, "Correctness gates"). A known
// test pattern is recorded, read back and measured; where ComfyUI is running,
// the SAME frames go through the server encoder too, and the browser file must
// be at least as close to the source as the server's.

// Browser must be within 10 % or half a level (0–255 scale) of the server.
const passMark = (serverMae: number) => Math.max(serverMae * 1.1, serverMae + 0.5)
// Without ComfyUI there is nothing to compare to; hold an absolute ceiling.
const ABSOLUTE_MAE_CEILING = 3.0

async function harness(page: Page) {
  await page.goto('/dev/video-export-harness')
  await page.waitForFunction(() => !!(window as any).__videoHarness, null, { timeout: 30_000 })
}
const call = (page: Page, fn: string, o: object) => page.evaluate(([f, a]) => (window as any).__videoHarness[f as string](a), [fn, o] as const)

test.describe('browser video export — quality gate', () => {
  test.setTimeout(180_000)

  test('MP4: every frame, the right length, BT.709, and at least as close to the source as the server', async ({ page }) => {
    await harness(page)
    const o = { width: 640, height: 360, fps: 30, frames: 60, alpha: false }
    const b: any = await call(page, 'run', o)
    test.info().annotations.push({ type: 'browser', description: JSON.stringify(b) })
    expect(b.frames).toBe(60)
    expect(Math.abs(b.duration - 2)).toBeLessThanOrEqual(1 / 30 + 1e-6)
    expect([b.width, b.height]).toEqual([640, 360])
    expect(b.colorSpace.primaries).toBe('bt709')
    expect(b.colorSpace.transfer).toBe('bt709')
    expect(b.colorSpace.matrix).toBe('bt709')

    const serverUp = await page.evaluate(() => fetch('/system_stats').then(r => r.ok).catch(() => false))
    if (serverUp) {
      const s: any = await call(page, 'runServer', o)
      test.info().annotations.push({ type: 'server', description: JSON.stringify(s) })
      expect(s.frames).toBe(60)
      expect(b.mae).toBeLessThanOrEqual(passMark(s.mae))
    } else {
      test.info().annotations.push({ type: 'server', description: 'ComfyUI not running — absolute ceiling used' })
      expect(b.mae).toBeLessThanOrEqual(ABSOLUTE_MAE_CEILING)
    }
  })

  test('odd sizes come out rounded up to even', async ({ page }) => {
    await harness(page)
    const b: any = await call(page, 'run', { width: 641, height: 361, fps: 30, frames: 10, alpha: false })
    expect([b.width, b.height]).toEqual([642, 362])
    expect(b.frames).toBe(10)
  })

  test('WebM keeps transparency', async ({ page }) => {
    await harness(page)
    const b: any = await call(page, 'run', { width: 320, height: 180, fps: 30, frames: 30, alpha: true })
    test.info().annotations.push({ type: 'browser', description: JSON.stringify(b) })
    expect(b.frames).toBe(30)
    expect(b.alphaMin).toBe(0)
    expect(b.alphaMax).toBe(255)
    expect(b.mae).toBeLessThanOrEqual(ABSOLUTE_MAE_CEILING)
  })

  test('cancel stops the export with an AbortError', async ({ page }) => {
    await harness(page)
    const r: any = await call(page, 'runCancel', { width: 320, height: 180, fps: 30, frames: 60, alpha: false })
    expect(r.name).toBe('AbortError')
  })
})
```

- [ ] **Step 3: The file-comparison tool**

Create `frontend/tests/tools/compare_videos.py`:

```python
"""Compare two video files frame by frame.

    .venv/bin/python frontend/tests/tools/compare_videos.py A.mp4 B.mp4

Prints JSON: per file — codec, frame count, frame rate, colour tags, alpha
range; and the mean absolute RGB difference between the two (0–255 scale),
over the frames both have. VP9 is decoded with libvpx-vp9: ffmpeg's native
vp9 decoder silently drops a WebM's alpha plane and would report it opaque.
"""
import json
import sys

import av
import numpy as np


def load(path):
    container = av.open(path)
    stream = container.streams.video[0]
    codec = stream.codec_context.name
    frames = []
    if codec == "vp9":
        dec = av.codec.CodecContext.create("libvpx-vp9", "r")
        for packet in container.demux(stream):
            for f in dec.decode(packet):
                frames.append(f)
        for f in dec.decode(None):
            frames.append(f)
    else:
        frames = list(container.decode(stream))
    first = frames[0]
    tags = {
        "primaries": str(first.color_primaries),
        "trc": str(first.color_trc),
        "space": str(first.colorspace),
        "range": str(first.color_range),
    }
    rgba = np.stack([f.to_ndarray(format="rgba") for f in frames]).astype(np.int16)
    info = {
        "codec": codec,
        "frames": len(frames),
        "fps": float(stream.average_rate or 0),
        "tags": tags,
        "alpha_min": int(rgba[..., 3].min()),
        "alpha_max": int(rgba[..., 3].max()),
        "size": [int(rgba.shape[2]), int(rgba.shape[1])],
    }
    return info, rgba


def main():
    a_info, a = load(sys.argv[1])
    b_info, b = load(sys.argv[2])
    n = min(len(a), len(b))
    h = min(a.shape[1], b.shape[1])
    w = min(a.shape[2], b.shape[2])
    mae = float(np.abs(a[:n, :h, :w, :3] - b[:n, :h, :w, :3]).mean()) if n else None
    print(json.dumps({"a": a_info, "b": b_info, "mae_rgb": mae}, indent=2))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the gate**

From `frontend/`: `npx playwright test tests/browser-video-export.spec.ts --project=chromium --reporter=list`
Expected: 4 passed. Copy the `browser` and `server` annotations (they print in the list reporter's output; if not, re-run with `--reporter=json` and read `annotations`) into the report: frames, duration, colour tags, MAE, bytes and milliseconds for both routes.

- [ ] **Step 5: Settle `RECORD_QUALITY` — decision rule, no improvising**

- MP4 test passes with `'high'` → leave it.
- It fails ONLY on the MAE comparison → set `RECORD_QUALITY` to `'very-high'` in `videoRecorder.ts`, re-run Step 4. Passes → keep `'very-high'`, record both MAE readings in the report.
- Still fails on MAE at `'very-high'`, or fails on the colour tags or the frame count/length → STOP. Report BLOCKED with the measured numbers. Do not change the colour tag, the pass mark, or the test.

- [ ] **Step 6: Prove the comparison tool, then clean up (controller)**

Run the tool on one server-made test video against itself — it must read it and report no difference:

```bash
cd /Users/julien/Documents/GitHub/Sailor && V=$(ls -t input/spacetype_*.mp4 | head -1) && .venv/bin/python frontend/tests/tools/compare_videos.py "$V" "$V"
```
Expected: `"frames": 60`, `"primaries": "bt709"`, `"mae_rgb": 0.0`.
Then delete what the gate uploaded: `rm -f input/vtest_*.png`, and the `input/spacetype_*.mp4` / `.webm` files the `runServer` calls made (list with `ls -lt input | head`, delete only files from the last few minutes).

- [ ] **Step 7: Commit (controller)**

Paths: the harness page, the spec, the Python tool, and `videoRecorder.ts` if Step 5 changed it.
Message: `test(export): browser video quality gate — frame count, length, BT.709, closeness vs the server's own file`

---

### Task 4: Shader Studio records in the browser, with Cancel

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue` — `renderBlob` (~line 525), `bakeShaderVideo` (~line 614), `generateVideo` (~line 646), `downloadVideoFile` (~line 681), imports, the `<StudioActionsFooter :spec>` (~line 930)

**Interfaces:**
- Consumes: `exportStudioVideo`, `resultBlob`, `videoErrorText`, `StudioVideoResult` (Task 2); `isAbortError` (Task 1); `prefersServerVideoExport` (Task 2); `hostedModeEnabled` from `~/lib/hostedMode`.

Locate everything by content, not line number. Leave `generateImage`, `downloadPng`, `exportWebEmbed` and `renderBlobWithOverrides` alone apart from the `renderBlob` split below.

- [ ] **Step 1: Record the typecheck baseline**

`npx vue-tsc --noEmit 2>&1 | grep -E "vue-canvas/ShaderStudioSurface\.vue" > /tmp/claude-shader-tsc-before.txt; wc -l /tmp/claude-shader-tsc-before.txt`

- [ ] **Step 2: Split the frame render from the PNG step**

Replace `renderBlob` with:

```ts
/** Render frame `t01` into shaderFx's canvas and return that canvas. With
 *  `into`, the frame is also copied onto that 2D context immediately after the
 *  render — a WebGL canvas can be cleared once the browser presents, so the
 *  copy must not wait for anything. */
async function renderShaderFrame(t01: number, into?: CanvasRenderingContext2D): Promise<HTMLCanvasElement> {
  const src = resolved.value
  const { w, h } = src
    ? outputDims(src.width, src.height, config.value.resolution, { upscale: true })
    : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }
  const dur = clockDuration()
  const t = t01 * dur
  const cfg = animated.value ? applyMotion(motionConfigFor(config.value, dur), t) : config.value
  const base = src ? await src.getFrame(t01, w, h) : GENERATIVE_BASE
  shaderFx.render(composePasses(cfg, defForId, t, (def, layer) => texBundle(def, layer)), base, w, h)
  const c = shaderFx.outputCanvas!
  into?.drawImage(c, 0, 0, w, h)
  return c
}

async function renderBlob(t01: number): Promise<Blob> {
  const c = await renderShaderFrame(t01)
  return await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png', 0.95))
}
```

- [ ] **Step 3: Imports and cancel state**

Add to the script imports:

```ts
import { exportStudioVideo, resultBlob, videoErrorText, type StudioVideoResult } from '~/lib/studio/studioVideoExport'
import { prefersServerVideoExport } from '~/lib/engine/videoExportSupport'
import { isAbortError } from '~/lib/engine/videoRecorder'
import { hostedModeEnabled } from '~/lib/hostedMode'
```

Directly after `const bakeMsg = ref('')` add:

```ts
// The running video export, so Cancel can stop it.
let videoAbort: AbortController | null = null
const exportingVideo = ref(false)
function cancelVideoExport() { videoAbort?.abort() }
function showVideoError(e: unknown) {
  if (isAbortError(e)) { bakeMsg.value = 'Export cancelled.'; return }
  console.error('[shader-studio] video failed', e)
  bakeMsg.value = videoErrorText(e)
}
```

- [ ] **Step 4: Replace `bakeShaderVideo`** (keep its doc comment's first paragraph about who owns the clock; replace the rest of the comment with the one below)

```ts
/** Make the current Shader Studio state into a video: recorded in the browser,
 *  or — local mode only, with a notice — by today's server route. `publish`
 *  uploads the file (Assets / canvas Video node); a download does not need it.
 *  Callers own baking.value/stopPreview/startPreview and the source guard. */
async function bakeShaderVideo(publish: boolean): Promise<StudioVideoResult | null> {
  const src = resolved.value
  const clock = exportClock(src, config.value.motion.duration, config.value.motion.fps)
  const { w, h } = src
    ? outputDims(src.width, src.height, config.value.resolution, { upscale: true })
    : { w: GENERATIVE_DIM, h: GENERATIVE_DIM }
  const total = Math.max(1, Math.round(clock.fps * clock.duration))
  videoAbort = new AbortController()
  exportingVideo.value = true
  try {
    return await exportStudioVideo({
      prefix: 'shader', publish,
      width: w, height: h, fps: clock.fps, frameCount: total, alpha: false,
      signal: videoAbort.signal,
      // Normalized (i / total), not i / fps: the last frame lands just before
      // the loop point instead of duplicating frame 0.
      drawFrame: async (i, ctx) => {
        bakeMsg.value = `Rendering ${i + 1}/${total}`
        await renderShaderFrame(i / total, ctx)   // copies onto ctx right after the render
      },
      serverFallback: async () => {
        const bakeCfg = { fps: clock.fps, loopDuration: clock.duration, W: w, H: h, seed: 'shader', sig: JSON.stringify(config.value) }
        const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
          renderFrame: async (i) => { bakeMsg.value = `Baking ${i + 1}/${total}`; return await renderBlob(i / total) },
        })
        bakeMsg.value = 'Encoding…'
        try {
          return await encodeFrames({ frames: bake.frames, fps: clock.fps, width: w, height: h })
        } catch (encErr) {
          bakeMsg.value = 'Encode failed — restart ComfyUI to load the encoder.'
          console.error('[shader-studio] encode failed', encErr)
          return null
        }
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
  } finally {
    exportingVideo.value = false
    videoAbort = null
  }
}
```

- [ ] **Step 5: Replace `generateVideo` and `downloadVideoFile`**

```ts
async function generateVideo() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; stopPreview()
  try {
    const made = await bakeShaderVideo(true)
    if (!made?.filename) return
    await recordAsset(activeTab.value?.projectUuid, 'video', made.filename)
    window.dispatchEvent(new CustomEvent('sailor:shaderStudioOutput', { detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: made.filename } } }))
    bakeMsg.value = made.notice ?? ''
    // A fallback notice must be seen: keep the studio open when there is one.
    if (!made.notice) closeEditor()
  } catch (e) { showVideoError(e) }
  finally { baking.value = false; startPreview() }
}
```

```ts
/** Same video as generateVideo(), saved locally instead of dispatched. The
 *  modal stays open, so bakeMsg must end on the result, not "Rendering…". */
async function downloadVideoFile() {
  if (!resolved.value && !isGenerative.value) { bakeMsg.value = 'Add a source first'; return }
  baking.value = true; stopPreview()
  try {
    const made = await bakeShaderVideo(false)
    if (!made) return
    downloadBlobAsFile(await resultBlob(made), `shader_${Date.now()}.${made.ext}`)
    bakeMsg.value = made.notice ?? ''
  } catch (e) { showVideoError(e) }
  finally { baking.value = false; startPreview() }
}
```

- [ ] **Step 6: Cancel in the footer**

In the `<StudioActionsFooter :spec="{ … }">` object, add a `utilities` entry (the spec has none today):

```
        utilities: exportingVideo ? [{ label: 'Cancel', onClick: cancelVideoExport }] : [],
```

- [ ] **Step 7: Tests and typecheck**

`npx vitest run tests/unit/studio-video-export.unit.spec.ts tests/unit/video-recorder.unit.spec.ts` — PASS.
Typecheck into `/tmp/claude-shader-tsc-after.txt`, `diff` against before — no new lines.
If `grep -rln "ShaderStudioSurface" frontend/tests/*.spec.ts` finds a browser spec that clicks the video buttons, run it: `npx playwright test <that file> --project=chromium`.

- [ ] **Step 8: Prove it both ways (controller, in the running app)**

In the browser pane at `http://127.0.0.1:3002`, open a Shader Studio with a generative effect (no source needed), set Motion to 2 s at 30 fps.
1. Press **Render on canvas → As video**. Expected: footer counts "Rendering n/60", a Video node appears, the modal closes; `ls -t input | head -3` shows a new `shader_<ts>.mp4`.
2. Run `localStorage.setItem('Sailor.VideoExport','server')` in the page, reload, repeat. Expected: "Baking…/Encoding…", footer ends on "Made on the server (browser recording is switched off).", the modal stays open; a new `spacetype_<ts>.mp4` in `input/`.
3. Compare: `.venv/bin/python frontend/tests/tools/compare_videos.py input/shader_<ts>.mp4 input/spacetype_<ts>.mp4` — expected: same frame count (60), same size, both `"primaries": "bt709"`, `mae_rgb` ≤ 3.0.
4. Start a long export (Motion 10 s) and press **Cancel** mid-way. Expected: footer shows "Export cancelled.", no new file in `input/`, the preview resumes.
5. `localStorage.removeItem('Sailor.VideoExport')`. Record the two timings (from the footer's start to the Video node) in the report.

- [ ] **Step 9: Commit (controller)**

Paths: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue`
Message: `feat(shader-studio): videos are recorded in the browser — faster, works hosted, Cancel; server route kept as a visible fallback`

---

### Task 5: Gradient Studio

**Files:**
- Modify: `frontend/app/lib/gradientfx/renderer.ts` — add `renderInto` next to `renderToBlob` (~line 537)
- Modify: `frontend/app/components/vue-canvas/GradientStudioSurface.vue` — `bakeGradientVideo` (~line 740), `generateVideo` (~line 761), `downloadVideoFile` (~line 789), imports, footer spec (~line 994)

**Interfaces:**
- Consumes: as Task 4.
- Produces: `GradientFxRenderer.renderInto(ctx: CanvasRenderingContext2D, cfg: GradientConfig, width: number, height: number, time?: number): void`

- [ ] **Step 1: Typecheck baseline** for `gradientfx/renderer\.ts|vue-canvas/GradientStudioSurface\.vue` into `/tmp/claude-gradient-tsc-before.txt`.

- [ ] **Step 2: `renderInto` in the renderer** — add directly above `renderToBlob`:

```ts
  /** Render, then copy the frame onto `ctx` in the same turn (a WebGL canvas
   *  can be cleared once the browser presents). Used by the video recorder. */
  renderInto(ctx: CanvasRenderingContext2D, cfg: GradientConfig, width: number, height: number, time = 0): void {
    this.render(cfg, width, height, time)
    ctx.drawImage(this.canvas!, 0, 0, width, height)
  }
```

- [ ] **Step 3: Imports + cancel state in the surface** — same four imports as Task 4 Step 3; after `const bakeMsg = ref('')` add the same block as Task 4 Step 3 with the log tag `'[gradient] video failed'`.

- [ ] **Step 4: Replace `bakeGradientVideo`**

```ts
/** Make the current Gradient Studio state into a video: recorded in the
 *  browser, or — local mode only, with a notice — by today's server route. */
async function bakeGradientVideo(publish: boolean): Promise<StudioVideoResult | null> {
  const m = config.value.motion
  const { w, h } = { w: m.size && aspectRatio(config.value.canvas.aspect) >= 1 ? Math.round(m.size * aspectRatio(config.value.canvas.aspect)) : m.size, h: m.size }
  const total = Math.max(1, Math.round(m.fps * m.duration))
  videoAbort = new AbortController()
  exportingVideo.value = true
  try {
    return await exportStudioVideo({
      prefix: 'gradient', publish,
      width: w, height: h, fps: m.fps, frameCount: total, alpha: false,
      signal: videoAbort.signal,
      drawFrame: (i, ctx) => {
        bakeMsg.value = `Rendering ${i + 1}/${total}`
        gradientFx.renderInto(ctx, config.value, w, h, i / m.fps)
      },
      serverFallback: async () => {
        const bakeCfg = { fps: m.fps, loopDuration: m.duration, W: w, H: h, seed: config.value.seed, sig: JSON.stringify(config.value) }
        const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
          renderFrame: async (i) => {
            bakeMsg.value = `Baking ${i + 1}/${total}`
            return gradientFx.renderToBlob(config.value, w, h, (i / m.fps))
          },
        })
        bakeMsg.value = 'Encoding…'
        try {
          return await encodeFrames({ frames: bake.frames, fps: m.fps, width: w, height: h })
        } catch (encErr) {
          bakeMsg.value = 'Encode failed — restart ComfyUI to load the encoder.'
          console.error('[gradient] encode failed', encErr)
          return null
        }
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
  } finally {
    exportingVideo.value = false
    videoAbort = null
  }
}
```

- [ ] **Step 5: Replace `generateVideo` and `downloadVideoFile`**

```ts
async function generateVideo() {
  baking.value = true
  stopPreview()
  try {
    const made = await bakeGradientVideo(true)
    if (!made?.filename) return
    await recordAsset(activeTab.value?.projectUuid, 'video', made.filename)
    window.dispatchEvent(new CustomEvent('sailor:gradientStudioOutput', {
      detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: made.filename } },
    }))
    bakeMsg.value = made.notice ?? ''
    if (!made.notice) closeEditor()
  } catch (e) { showVideoError(e) }
  finally { baking.value = false; startPreview() }
}
```

For `downloadVideoFile`: read the current function first and keep its guard and `stopPreview`/`startPreview` shape; replace its body's bake + `/view` fetch + download with:

```ts
    const made = await bakeGradientVideo(false)
    if (!made) return
    downloadBlobAsFile(await resultBlob(made), `gradient_${Date.now()}.${made.ext}`)
    bakeMsg.value = made.notice ?? ''
```
and its `catch` body with `showVideoError(e)`. If the current function names the downloaded file differently, keep its existing name pattern and only swap the extension source to `made.ext`.

- [ ] **Step 6: Cancel in the footer** — the spec already has `utilities: [{ label: copied ? '✓ Copied' : 'Copy config', onClick: copyConfig }]`. Make it:

```
        utilities: [{ label: copied ? '✓ Copied' : 'Copy config', onClick: copyConfig }, ...(exportingVideo ? [{ label: 'Cancel', onClick: cancelVideoExport }] : [])],
```

- [ ] **Step 7: Tests and typecheck** — unit specs from Task 4 Step 7 PASS; typecheck diff clean; run `npx vitest run tests/unit/gradient*.unit.spec.ts` (all must stay green — the renderer changed).

- [ ] **Step 8: Prove it both ways (controller)** — as Task 4 Step 8, in Gradient Studio (Motion 2 s at 30 fps); browser file `gradient_<ts>.mp4`. Same four checks and the Cancel check.

- [ ] **Step 9: Commit (controller)** — paths: the renderer and the surface. Message: `feat(gradient-studio): videos are recorded in the browser, with Cancel; server route kept as a visible fallback`

---

### Task 6: Space Type (including transparent WebM)

**Files:**
- Modify: `frontend/app/lib/spacetype/engine.ts` — add `drawFrameInto` next to `frameToBlob` (~line 388)
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` — `bakeSpaceTypeVideo` (~line 1612), `generateVideo` (~line 1639), `downloadVideoFile` (~line 1670), imports, footer spec (~line 2364)

**Interfaces:**
- Consumes: as Task 4.
- Produces: `SpaceTypeEngine.drawFrameInto(ctx: CanvasRenderingContext2D, targetW: number, targetH: number): void`

- [ ] **Step 1: Typecheck baseline** for `spacetype/engine\.ts|vue-canvas/SpaceTypeSurface\.vue`.

- [ ] **Step 2: `drawFrameInto` in the engine** — add directly above `frameToBlob`:

```ts
  /** Re-render the current frame and draw it onto `ctx` at targetW×targetH in
   *  the same turn — the canvas equivalent of frameToBlob, for the video
   *  recorder. A supersampled render is downscaled with high-quality smoothing,
   *  exactly as frameToBlob does. */
  drawFrameInto(ctx: CanvasRenderingContext2D, targetW: number, targetH: number): void {
    if (postEnabled(this.post) && this.postChain) this.postChain.render(this.scene, this.activeCam)
    else this.renderer.render(this.scene, this.activeCam)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.renderer.domElement, 0, 0, targetW, targetH)
  }
```

- [ ] **Step 3: Imports, cancel state, a visible notice**

Same four imports as Task 4. After `const baking = ref(false)` add:

```ts
// The running video export, so Cancel can stop it; and the line the footer
// shows about how the last video was made (a fallback must be seen).
let videoAbort: AbortController | null = null
const exportingVideo = ref(false)
const videoNotice = ref('')
function cancelVideoExport() { videoAbort?.abort() }
```

- [ ] **Step 4: Replace `bakeSpaceTypeVideo`** (keep the doc comment, updating its last sentence to: "Records in the browser, or — local mode only, with a notice — through today's server route.")

```ts
async function bakeSpaceTypeVideo(publish: boolean): Promise<StudioVideoResult | null> {
  if (!engine) return null
  await ensureEffectFonts()
  engine.setSize(W.value * BAKE_SS, H.value * BAKE_SS)
  engine.setFps(fps.value)
  engine.setLoopDuration(loopDuration.value)
  // Full-resolution, unclamped shader fields for every exported frame — see
  // engine.setBake's doc; every renderFrameAt call below inherits it.
  engine.setBake(true)
  rebuild()
  const rates = seamlessLoop.value ? (effect.value.loopRates?.(params) ?? []) : []
  const k = loopMultiplier(rates)
  const origFrames = Math.max(1, Math.round(fps.value * loopDuration.value))
  const loopCfg = k > 1 ? { ...cfg.value, loopDuration: loopDuration.value * k } : cfg.value
  const total = Math.max(1, Math.round(loopCfg.fps * loopCfg.loopDuration))
  // Gate on exportAlphaAvailable too, not just the checkbox: it's a stale UI
  // value once the menu closes — never make a transparent file unearned.
  const wantAlpha = exportAlpha.value && exportAlphaAvailable.value
  videoAbort = new AbortController()
  exportingVideo.value = true
  try {
    return await exportStudioVideo({
      prefix: 'spacetype', publish,
      width: W.value, height: H.value, fps: fps.value, frameCount: total, alpha: wantAlpha,
      signal: videoAbort.signal,
      // Unwrapped t01 = i / origFrames runs 0..k so motions keep their per-loop
      // rate across k loops and land on whole cycles → seamless.
      drawFrame: (i, ctx) => {
        engine!.renderFrameAt(i / origFrames, params)
        engine!.drawFrameInto(ctx, W.value, H.value)
      },
      serverFallback: async () => {
        const bake = await ensureSpaceTypeBake(loopCfg, undefined, {
          renderFrame: async (i) => { engine!.renderFrameAt(i / origFrames, params); return engine!.frameToBlob(W.value, H.value) },
        })
        return encodeFrames({ frames: bake.frames, fps: fps.value, width: W.value, height: H.value, alpha: wantAlpha })
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
  } finally {
    engine?.setSize(W.value, H.value)
    exportingVideo.value = false
    videoAbort = null
  }
}
```

Check: if `total` differs from what `ensureSpaceTypeBake(loopCfg, …)` computes (`Math.round(cfg.fps * cfg.loopDuration)` on `loopCfg`), use that exact expression — the two routes must make the same number of frames.

- [ ] **Step 5: Replace `generateVideo` and `downloadVideoFile`**

```ts
async function generateVideo() {
  if (!engine) return
  baking.value = true
  videoNotice.value = ''
  stopPreview()
  try {
    const made = await bakeSpaceTypeVideo(true)
    if (!made?.filename) return
    await recordAsset(activeTab.value?.projectUuid, 'video', made.filename)
    window.dispatchEvent(new CustomEvent('sailor:spaceTypeOutput', {
      detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: made.filename } },
    }))
    videoNotice.value = made.notice ?? ''
    if (!made.notice) closeEditor()
  } catch (e) {
    if (isAbortError(e)) { videoNotice.value = 'Export cancelled.'; return }
    console.error('[spacetype] video export failed', e)
    videoNotice.value = videoErrorText(e)
  } finally {
    engine?.setBake(false)
    baking.value = false
    startPreview()
  }
}
```

```ts
/** Same video as generateVideo(), saved locally instead of dispatched. */
async function downloadVideoFile() {
  if (!engine) return
  baking.value = true
  videoNotice.value = ''
  stopPreview()
  try {
    const made = await bakeSpaceTypeVideo(false)
    if (!made) return
    downloadBlobAsFile(await resultBlob(made), `spacetype_${Date.now()}.${made.ext}`)
    videoNotice.value = made.notice ?? ''
  } catch (e) {
    if (isAbortError(e)) { videoNotice.value = 'Export cancelled.'; return }
    console.error('[spacetype] video download failed', e)
    videoNotice.value = videoErrorText(e)
  } finally {
    engine?.setBake(false)
    baking.value = false
    startPreview()
  }
}
```

(The old `generateVideo` used `alert(...)` for a failure; the footer line replaces it.)

- [ ] **Step 6: Footer** — change the `status` line and add utilities:

```
        status: { saving: autoSaving, saved: autoSaved, error: embedErr ? embedMsg : null, notice: embedErr ? null : (embedMsg || videoNotice || null) },
        utilities: exportingVideo ? [{ label: 'Cancel', onClick: cancelVideoExport }] : [],
```

- [ ] **Step 7: Tests and typecheck** — Task 4's unit specs PASS; `npx vitest run tests/unit/spacetype*.unit.spec.ts` stays green; typecheck diff clean; if `tests/embed-spacetype.spec.ts` or any `tests/*spacetype*.spec.ts` exercises the engine, run it with `--project=chromium`.

- [ ] **Step 8: Prove it both ways (controller)** — as Task 4 Step 8 in Space Type (a 2 s loop), for **As video** AND **As video (transparent)**. For the transparent pair, compare with the tool: both `codec: "vp9"`, `alpha_min` 0 and `alpha_max` 255, same frame count, `mae_rgb` ≤ 3.0. Plus the Cancel check.

- [ ] **Step 9: Commit (controller)** — paths: engine and surface. Message: `feat(space-type): videos, transparent ones included, are recorded in the browser, with Cancel`

---

### Task 7: 3D Studio

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — `bakeSceneVideo` (~line 549), `exportVideo` (~line 593), `renderVideoToCanvas` (~line 607), imports, footer spec (~line 5876)

**Interfaces:**
- Consumes: as Task 4. `renderMotionFrame(engine, doc, t01)` returns the WebGL canvas it rendered into.

- [ ] **Step 1: Typecheck baseline** for `vue-canvas/Scene3DStudioSurface\.vue`.

- [ ] **Step 2: Imports, cancel state, notice** — same four imports as Task 4. After `const bakeError = ref('')` add:

```ts
// The running video export, so Cancel can stop it; and how the last video was
// made, when it was not the browser (a fallback must be seen).
let videoAbort: AbortController | null = null
const videoNotice = ref('')
function cancelVideoExport() { videoAbort?.abort() }
```

- [ ] **Step 3: Replace `bakeSceneVideo`** — keep everything around the frame loop (the reentrancy guard, the camera sync, `setSize`, and the whole `finally` that restores the viewport) exactly as it is; replace from `const { ensureSpaceTypeBake } = await import('~/lib/spacetype/bake')` down to the end of the inner `try { return await encodeFrames(...) } catch { … }` with:

```ts
    videoAbort = new AbortController()
    videoNotice.value = ''
    return await exportStudioVideo({
      prefix: 'scene3d', publish,
      width: W, height: H, fps, frameCount: total, alpha: false,
      signal: videoAbort.signal,
      drawFrame: (i, ctx) => {
        const cv = renderMotionFrame(engine!, doc, total > 1 ? i / total : 0)
        ctx.drawImage(cv, 0, 0, W, H)   // same turn as the render
      },
      serverFallback: async () => {
        const { ensureSpaceTypeBake } = await import('~/lib/spacetype/bake')
        const cfg = { fps, loopDuration: dur, W, H, seed: 'scene3d', sig: JSON.stringify({ id: props.nodeId, n: total, w: W, h: H, s: serializeDoc(doc) }) }
        const bake = await ensureSpaceTypeBake(cfg as any, undefined, {
          renderFrame: async (i) => {
            const cv = renderMotionFrame(engine!, doc, total > 1 ? i / total : 0)
            return await new Promise<Blob>((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'))
          },
        })
        try {
          return await encodeFrames({ frames: bake.frames, fps, width: W, height: H })
        } catch {
          bakeError.value = 'Video encode failed'
          return null
        }
      },
    }, { hosted: hostedModeEnabled(useRuntimeConfig().public), forceServer: prefersServerVideoExport() })
```

Then:
- change the signature to `async function bakeSceneVideo(publish: boolean): Promise<StudioVideoResult | null>`;
- in its outer `catch (err)`, put first: `if (isAbortError(err)) { videoNotice.value = 'Export cancelled.'; return null }`, and replace `bakeError.value = 'Video export failed'` with `bakeError.value = videoErrorText(err)`;
- in its `finally`, add `videoAbort = null`.

- [ ] **Step 4: Replace `exportVideo` and `renderVideoToCanvas`**

```ts
async function exportVideo() {
  const made = await bakeSceneVideo(false)
  if (!made) return
  const blob = await resultBlob(made)
  const obj = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = obj; a.download = `scene3d-${props.nodeId}.${made.ext}`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(obj)
  videoNotice.value = made.notice ?? ''
}
```

```ts
async function renderVideoToCanvas() {
  if (!(await commitSculptIfNeeded())) return
  const made = await bakeSceneVideo(true)
  if (!made?.filename) return
  window.dispatchEvent(new CustomEvent('sailor:scene3dStudioOutput', {
    detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: made.filename } },
  }))
  videoNotice.value = made.notice ?? ''
  if (!made.notice) emit('close')
}
```

Keep the existing comment above `renderVideoToCanvas`, adding: "A fallback notice keeps the studio open so it is seen."

- [ ] **Step 5: Footer** — change `status` and add utilities:

```
        status: { saving: autoSaving, saved: autoSaved, error: (bakeError && !baking) ? bakeError : null, notice: videoNotice || null },
        utilities: videoBaking ? [{ label: 'Cancel', onClick: cancelVideoExport }] : [],
```

Also check the Motion panel's own **Export video** button (`<StudioButton @click="exportVideo">`, ~line 4713): it calls `exportVideo`, so nothing else to change there.

- [ ] **Step 6: Tests and typecheck** — Task 4's unit specs PASS; typecheck diff clean; run `npx playwright test tests/scene3d-motion.spec.ts --project=chromium` (it exercises motion + export paths) — must stay green.

- [ ] **Step 7: Prove it both ways (controller)** — as Task 4 Step 8 in 3D Studio with a scene that has motion (a turntable), output 1280×720, 2 s at 30 fps: **As video** both ways, compare with the tool (60 frames, bt709, `mae_rgb` ≤ 3.0), plus the Cancel check. Confirm the viewport is back to its normal size after each export.

- [ ] **Step 8: Commit (controller)** — path: the surface. Message: `feat(3d-studio): videos are recorded in the browser, with Cancel; server route kept as a visible fallback`

---

## After this plan

- **Plan 2 — Compositor / Frame + the embed bridge.** Waits for the parallel Frame web-export session (`docs/superpowers/specs/2026-09-21-frame-web-export-design.md`) to land how a Frame draws at time t. `renderCompositeAtTime(t)` (`ArtifactFrameNode.vue:907`) already awaits wired layers and paints, so its canvas goes straight to `recordVideo`. Includes the embed bridge (`recordEmbed.ts`) tested against the three existing embed surfaces, and the wired-video exactness check. Coordination note: `docs/superpowers/HANDOFF-video-export-and-frame-embed.md`.
- **Plan 3 — the Timeline.** Adds `audio?: AudioBuffer` to `recordVideo` (mediabunny `AudioBufferSource`, AAC in MP4 with an Opus fallback), feeds it `ensureTimelineMix`'s buffer, teaches the WebGL preview plain text clips, raises exact decode for big files, and adds the tone-probe and timing gates before the Timeline's Export switches.
- **Retire `/sailor/spacetype_encode`** two weeks after plan 3 lands, if no fallback notice has been reported in that time.
