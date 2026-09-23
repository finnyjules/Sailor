# Browser Video Export — Plan 3 of 3: the Timeline, with sound

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The multi-track timeline's Export records the video in the browser — drawn by the same WebGL renderer as the preview, with every audio clip mixed in — so it works in hosted mode, needs no pre-bake of Motion/Space Type clips, and falls back to today's server render (visibly) in local mode.

**Architecture:** Plan 1's recorder (`app/lib/engine/videoRecorder.ts`) gains an optional sound track. A new `recordTimeline()` (`app/lib/timeline/recordTimeline.ts`) loads a private `WebGLPreviewRenderer`, refuses (by name) any clip it can't draw frame-exactly, mixes the audio into an `AudioBuffer` (the mix already exists, minus the upload), and records `renderFrame(i)` into the file. The editor's Export tries that first; today's `renderViaFFmpeg` body becomes the server fallback, untouched.

**Tech Stack:** Vue 3 + TS (Nuxt 4), mediabunny 1.59 (`AudioBufferSource`, AAC in MP4), Web Audio (`OfflineAudioContext`), WebGL2, Vitest, Playwright (`--project=chromium`), PyAV.

**Spec:** `docs/superpowers/specs/2026-09-21-browser-video-export-design.md` (stage 4, "Timeline extra work"). Plans 1–2: `docs/superpowers/plans/2026-09-22-browser-video-export-studios.md`, `docs/superpowers/plans/2026-09-23-browser-video-export-frame.md`.

## Plain-language summary

- **What changes:** pressing Export in the timeline makes the video in the browser: it draws each frame exactly as the preview does, adds all the sound, and saves one file. It works in hosted mode (today timeline export is switched off there). There is a Cancel button while it runs, and the button shows "Mixing sound…", "Rendering n%", "Uploading…".
- **Fixed along the way:** title and lower-third clips, which today's export silently drops, will be in the video; Motion and Space Type clips no longer need their slow "Baking…" step before an export; plain text clips are drawn by the preview (today they only appear in the server export).
- **When the browser can't do it exactly:** a very large video file (over 96 MB) or an unusual format that the preview can only show ±1 frame is named in a message ("the video clip at 4.0 s can't be drawn frame-exactly…"); local mode then uses the old server render and says so; hosted mode asks you to replace that clip. Clips fed by a running workflow that has no file yet are left out, exactly as the server does today, and the export says how many.
- **Sound:** AAC in the MP4, the same mix the preview plays. A test puts a beep at a known moment and checks it lands on the right frame.
- **Not in this plan:** captions and mattes (drawn nowhere yet); transparent timeline video; a separate progress for the upload of very long videos (hosted cap 100 MB).

## Global Constraints

- Work directly in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch. Never `git stash`. Never touch files you did not write.
- **Subagents do not commit.** The controller commits with the private-index recipe (plan 1), only this plan's paths/hunks.
- Never run `npm run dev` or start/stop servers. Dev server `http://127.0.0.1:3002`, ComfyUI `http://127.0.0.1:8188`.
- Do not change `comfy_extras/`. The Python timeline renderer stays as the local fallback and for Timeline nodes run inside a workflow.
- Reuse plan 1 modules: `recordVideo`, `isAbortError`, `throwIfAborted`, `planRecording` (`app/lib/engine/videoRecorder.ts`); `publishVideo`, `HOSTED_UPLOAD_LIMIT` (`app/lib/engine/publishVideo.ts`); `canRecordInBrowser`, `prefersServerVideoExport` (`app/lib/engine/videoExportSupport.ts`); `videoErrorText` (`app/lib/studio/studioVideoExport.ts`); `hostedModeEnabled` (`app/lib/hostedMode.ts`).
- A quiet fallback is forbidden: every fallback or skipped clip is said in plain words.
- Frame timestamps from the index only; BT.709 (the recorder). Frames are integers in `EditState`.
- UI copy: sentence case, plain words, no internal identifiers.
- Unit: `npx vitest run tests/unit/<file>`; browser: `npx playwright test tests/<file> --project=chromium` (from `frontend/`). Typecheck: grep baseline before, same after; only new lines count.
- After every commit the controller updates `docs/STATE.md` and the build dashboard.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/engine/videoRecorder.ts` | + optional `audio: AudioBuffer` (AAC in MP4, Opus in WebM). |
| `frontend/app/lib/engine/videoExportSupport.ts` | `canRecordInBrowser` checks the audio codec when asked. |
| `frontend/app/lib/engine/plainTextClip.ts` (new) | Plain text clip layout (pure, a port of Python's `render_text_to_pil`) + Canvas2D draw. |
| `frontend/app/lib/engine/sources/textCanvasSource.ts`, `compositor.ts`, `webglPreviewRenderer.ts` | Draw `text` clips; record clips that fell back to the ±1-frame video source. |
| `frontend/app/lib/engine/audio/mixdown.ts` | `mixTimelineAudio()` returns the mix as an `AudioBuffer`; `ensureTimelineMix` built on it. |
| `frontend/app/lib/timeline/recordTimeline.ts` (new) | Load a private renderer, refuse inexact clips, mix, record. |
| `frontend/app/pages/dev/timeline-export-harness.vue` (new) | Dev page the gate drives. |
| `frontend/tests/timeline-browser-export.spec.ts` (new) | Frames, length, BT.709, sound on the right frame, text drawn where the server draws it. |
| `frontend/app/components/vue-canvas/TimelineEditor.vue` | Export → browser first, server fallback, Cancel, phases. |

---

### Task 1: The recorder takes a sound track

**Files:** Modify `frontend/app/lib/engine/videoRecorder.ts`, `frontend/app/lib/engine/videoExportSupport.ts`; Test `frontend/tests/unit/video-recorder.unit.spec.ts`

**Interfaces:**
- Produces: `RecordRequest.audio?: AudioBuffer`; `audioCodecFor(ext: 'mp4' | 'webm'): 'aac' | 'opus'`; `MediabunnyLike` gains `'AudioBufferSource'`; `canRecordInBrowser(o: { width; height; fps; alpha?; audio?: boolean })`.

- [ ] **Step 1: Failing tests** — extend the spec's `fakeLib()` with:

```ts
  class AudioBufferSource {
    constructor(public config: any) { log.audio = { config, added: [] as any[] } }
    async add(b: any) { log.audio.added.push(b); log.order.push('audio') }
  }
```
add `audio: null, order: [] as string[]` to `log`, add `AudioBufferSource` to the returned lib, and in the fake `Output` add `addAudioTrack(_src: any) { log.audioTrack = true }`; make the fake `VideoSampleSource.add` push `'video'` to `log.order`. Then add:

```ts
describe('recordVideo — sound', () => {
  it('MP4 gets an AAC track; the whole buffer is added once, before the first frame', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const buf = { duration: 1 } as any
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 2, audio: buf, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audioTrack).toBe(true)
    expect(log.audio.config.codec).toBe('aac')
    expect(log.audio.added).toEqual([buf])
    expect(log.order).toEqual(['audio', 'video', 'video'])
  })

  it('transparent WebM with sound uses Opus', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 1, alpha: true, audio: { duration: 1 } as any, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audio.config.codec).toBe('opus')
  })

  it('no audio → no audio track', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 1, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audioTrack).toBeUndefined()
  })
})
```

(Keep every existing test green: adapt the existing fake's `VideoSampleSource.add` / `order` bookkeeping without changing what those tests assert.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `videoRecorder.ts`:
  - Add `audio?: AudioBuffer` to `RecordRequest` with the doc comment `/** Optional sound for the whole video, starting at 0 s (the timeline mix). */`.
  - Add `export function audioCodecFor(ext: 'mp4' | 'webm'): 'aac' | 'opus' { return ext === 'mp4' ? 'aac' : 'opus' }`.
  - Add `'AudioBufferSource'` to `MediabunnyLike`.
  - After `output.addVideoTrack(...)`: 
    ```ts
    const audioSource = req.audio
      ? new mb.AudioBufferSource({ codec: audioCodecFor(plan.ext), quality: new mb.Quality('high') })
      : null
    if (audioSource) output.addAudioTrack(audioSource)
    ```
  - Inside the `try`, right after `await output.start()`: `if (audioSource) await audioSource.add(req.audio!)` (the mix is one buffer that starts at 0 s; adding it first keeps the muxer from waiting on audio).
- In `videoExportSupport.ts`, `canRecordInBrowser` takes `audio?: boolean`; when true and the video check passed, also `return await canEncodeAudio(audioCodecFor(plan.ext), { numberOfChannels: 2, sampleRate: 48000 })` (import `canEncodeAudio` from `mediabunny` in the same dynamic import, `audioCodecFor` from `./videoRecorder`). Its existing catch still returns false.

- [ ] **Step 4: Run** `npx vitest run tests/unit/video-recorder.unit.spec.ts tests/unit/studio-video-export.unit.spec.ts` — PASS. Typecheck grep for both files — nothing new. Run `npx playwright test tests/browser-video-export.spec.ts --project=chromium` — 4 passed (no regression in video-only files).

- [ ] **Step 5: Commit (controller)** — `feat(export): the recorder takes a sound track — AAC in MP4, Opus in WebM`

---

### Task 2: The preview draws plain text clips

**Files:** Create `frontend/app/lib/engine/plainTextClip.ts`; Modify `frontend/app/lib/engine/sources/textCanvasSource.ts`, `frontend/app/lib/engine/compositor.ts:17,94,110`, `frontend/app/lib/engine/webglPreviewRenderer.ts` (the `caption`/`text` warn in `load`); Test `frontend/tests/unit/plain-text-clip.unit.spec.ts`

**Interfaces:**
- Produces: `wrapPlainText(text: string, maxW: number, measure: (s: string) => number): string[]`; `layoutPlainText(spec: Partial<TextSpec>, W: number, H: number, measure: (s: string) => number, glyphHeight: number): PlainTextLayout`; `interface PlainTextLayout { font: string; color: string; bg: string; lineHeight: number; lines: { text: string; x: number; y: number }[] }`; `drawPlainTextClip(ctx: CanvasRenderingContext2D, spec: Partial<TextSpec>, W: number, H: number): void`; `PLAIN_TEXT_FONT_STACK`.

- [ ] **Step 1: Failing test** — `frontend/tests/unit/plain-text-clip.unit.spec.ts`. Python reference: `comfy_extras/nodes_text.py` `_wrap` and `render_text_to_pil` (read them).

```ts
import { describe, it, expect } from 'vitest'
import { wrapPlainText, layoutPlainText } from '../../app/lib/engine/plainTextClip'

const measure = (s: string) => s.length * 10   // 10 px per character

describe('wrapPlainText (Python _wrap)', () => {
  it('wraps greedily at spaces, never breaks a single long word', () => {
    expect(wrapPlainText('aa bb cc', 50, measure)).toEqual(['aa bb', 'cc'])
    expect(wrapPlainText('abcdefghij xy', 50, measure)).toEqual(['abcdefghij', 'xy'])
  })
  it('keeps explicit line breaks; a trailing newline adds no line; empty text is one empty line', () => {
    expect(wrapPlainText('a\nb', 999, measure)).toEqual(['a', 'b'])
    expect(wrapPlainText('a\n', 999, measure)).toEqual(['a'])
    expect(wrapPlainText('', 999, measure)).toEqual([''])
  })
})

describe('layoutPlainText (Python render_text_to_pil)', () => {
  const spec = { text: 'ab cd', font_size: 40, color: '#ff0000', bg_color: '#000000', align: 'center', v_align: 'middle', padding: 0.1, line_spacing: 1.5 } as const

  it('insets by W×padding and H×padding (truncated), wraps within them', () => {
    // W 100 → inset 10, maxW 80: 'ab cd' is 50 px, one line
    const l = layoutPlainText(spec, 100, 60, measure, 20)
    expect(l.lines.map(x => x.text)).toEqual(['ab cd'])
    expect(l.lineHeight).toBe(30)                      // 20 × 1.5
  })

  it('middle: block centred; center: line centred', () => {
    const l = layoutPlainText(spec, 100, 60, measure, 20)
    expect(l.lines[0]).toEqual({ text: 'ab cd', x: 25, y: 15 })   // (100-50)/2, (60-30)/2
  })

  it('top / bottom / left / right', () => {
    expect(layoutPlainText({ ...spec, v_align: 'top', align: 'left' }, 100, 60, measure, 20).lines[0]).toEqual({ text: 'ab cd', x: 10, y: 6 })
    expect(layoutPlainText({ ...spec, v_align: 'bottom', align: 'right' }, 100, 60, measure, 20).lines[0]).toEqual({ text: 'ab cd', x: 40, y: 24 })
  })

  it('font string, colours, and Python defaults for missing fields', () => {
    const l = layoutPlainText({ text: 'x' }, 200, 100, measure, 10)
    expect(l.font).toMatch(/^72px /)
    expect([l.color, l.bg]).toEqual(['#ffffff', '#000000'])
    expect(l.lineHeight).toBeCloseTo(12, 10)            // 10 × 1.2
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `frontend/app/lib/engine/plainTextClip.ts`:

```ts
import type { TextSpec } from '~~/shared/timeline/types'

// Plain text clips, drawn in the browser the way the server's
// render_text_to_pil (comfy_extras/nodes_text.py) draws them: an opaque
// full-canvas card in bg_color, greedy word wrap inside a W×padding / H×padding
// inset, lines spaced by the "Ag" glyph height × line_spacing, block aligned
// top / middle / bottom and each line left / center / right. Fonts differ a
// little (Python uses system Helvetica/Arial TrueType), so this matches layout,
// not pixels.

export const PLAIN_TEXT_FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif'

export interface PlainTextLayout {
  font: string
  color: string
  bg: string
  lineHeight: number
  lines: { text: string; x: number; y: number }[]
}

export function wrapPlainText(text: string, maxW: number, measure: (s: string) => number): string[] {
  let raw = text.split(/\r\n|\r|\n/)
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()   // Python splitlines() drops a trailing break
  if (!text) raw = ['']
  const lines: string[] = []
  for (const rawLine of raw) {
    let cur = ''
    for (const w of rawLine.split(' ')) {
      const trial = cur + (cur ? ' ' : '') + w
      if (measure(trial) <= maxW || !cur) cur = trial
      else { lines.push(cur); cur = w }
    }
    lines.push(cur)
  }
  return lines
}

export function layoutPlainText(
  spec: Partial<TextSpec>, W: number, H: number, measure: (s: string) => number, glyphHeight: number,
): PlainTextLayout {
  const fontSize = Math.trunc(spec.font_size ?? 72)
  const padding = spec.padding ?? 0.06
  const lineSpacing = spec.line_spacing ?? 1.2
  const insetX = Math.trunc(W * padding)
  const insetY = Math.trunc(H * padding)
  const lines = wrapPlainText(spec.text ?? '', W - 2 * insetX, measure)
  const lineHeight = glyphHeight * lineSpacing
  const blockH = Math.max(1, lineHeight * lines.length)
  const vAlign = spec.v_align ?? 'middle'
  let y = vAlign === 'top' ? insetY : vAlign === 'bottom' ? H - insetY - blockH : (H - blockH) / 2
  const align = spec.align ?? 'center'
  const out: PlainTextLayout['lines'] = []
  for (const text of lines) {
    const tw = measure(text)
    const x = align === 'center' ? (W - tw) / 2 : align === 'right' ? W - insetX - tw : insetX
    out.push({ text, x, y })
    y += lineHeight
  }
  return {
    font: `${fontSize}px ${PLAIN_TEXT_FONT_STACK}`,
    color: spec.color ?? '#ffffff',
    bg: spec.bg_color ?? '#000000',
    lineHeight,
    lines: out,
  }
}

export function drawPlainTextClip(ctx: CanvasRenderingContext2D, spec: Partial<TextSpec>, W: number, H: number): void {
  ctx.save()
  ctx.font = `${Math.trunc(spec.font_size ?? 72)}px ${PLAIN_TEXT_FONT_STACK}`
  const ag = ctx.measureText('Ag')
  const glyphHeight = ag.actualBoundingBoxAscent + ag.actualBoundingBoxDescent
  const layout = layoutPlainText(spec, W, H, s => ctx.measureText(s).width, glyphHeight)
  ctx.fillStyle = layout.bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = layout.color
  ctx.textBaseline = 'top'
  for (const l of layout.lines) ctx.fillText(l.text, l.x, l.y)
  ctx.restore()
}
```

Check the Step 1 numbers against this code before running (e.g. top/left: y = insetY = trunc(60×0.1) = 6; bottom: 60 − 6 − 30 = 24; right: 100 − 10 − 50 = 40). If an expected value disagrees with Python's formula, fix the TEST to Python's formula and say so in the report.

- [ ] **Step 4: Wire it into the preview.**
  - `textCanvasSource.ts`: `supports` also accepts `clip.kind === 'text'`; widen the constructor/field type to include `TextClip`; in `getFrame`, add a `text` branch: the card is static, so draw once and reuse (`private drawnStatic = false`; on the first call for a text clip, `drawPlainTextClip(this.ctx, (this.clip as TextClip).text, this.canvasW, this.canvasH)` and set the flag; later calls return the canvas without clearing). Other kinds unchanged. Update the class comment to mention plain text.
  - `compositor.ts`: add `'text'` to `RENDERABLE_KINDS`; update the two comments that say plain text is "Phase 2/3".
  - `webglPreviewRenderer.ts` `load`: the warning now only for `caption` (`if (clip.kind === 'caption')`).
  - If `tests/unit/compositor.unit.spec.ts` or any `resolutionPlanFor` test asserts that `text` is skipped, update it to the new behaviour and say so.

- [ ] **Step 5: Run** `npx vitest run tests/unit/plain-text-clip.unit.spec.ts tests/unit/compositor.unit.spec.ts` + every unit spec that imports `textCanvasSource` or `webglPreviewRenderer` (`grep -l` them) — PASS. Typecheck grep for the four files — nothing new. `npx playwright test tests/timeline-golden.spec.ts --project=chromium` — must stay green (no fixture has a text clip).

- [ ] **Step 6: Commit (controller)** — `feat(timeline): the preview draws plain text clips, laid out like the server's`

---

### Task 3: Know which video clips can't be drawn frame-exactly

**Files:** Modify `frontend/app/lib/engine/webglPreviewRenderer.ts` (`load`, `loadSource`); Test `frontend/tests/unit/webgl-preview-renderer-inexact.unit.spec.ts`

**Interfaces:**
- Produces: `WebGLPreviewRenderer.inexactClips: Map<string, string>` (clip id → plain reason), cleared on each `load`.

- [ ] **Step 1: Failing test** (mocks the GL and source modules so it runs in Node):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../app/lib/engine/gl/glRenderer', () => ({
  GlRenderer: class { canvas = {}; clearSources() {} ; dispose() {} ; setSource() {} ; render() {} },
}))
vi.mock('../../app/lib/engine/sources/webCodecsSource', () => {
  class UnsupportedSourceError extends Error {}
  return {
    UnsupportedSourceError,
    WebCodecsSource: { load: vi.fn(async (url: string) => {
      if (url.includes('odd')) throw new UnsupportedSourceError('no decoder')
      return { width: 1, height: 1, getFrame: async () => ({}), dispose() {} }
    }) },
  }
})
vi.mock('../../app/lib/engine/sources/videoElementSource', () => ({
  VideoElementSource: { load: vi.fn(async () => ({ width: 1, height: 1, getFrame: async () => ({}), dispose() {} })) },
}))

import { WebGLPreviewRenderer } from '../../app/lib/engine/webglPreviewRenderer'

const state = (paths: string[]) => ({
  version: 2, canvas: { width: 10, height: 10, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0,
  tracks: [{ id: 'v', kind: 'video', name: 'V', muted: false, locked: false,
    clips: paths.map((p, i) => ({ id: `c${i}`, kind: 'video', asset_id: 'x', path: p, start_frame: i * 10, in_frame: 0, length: 10 })) }],
}) as any

describe('WebGLPreviewRenderer.inexactClips', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, headers: { get: () => (url.includes('huge') ? String(200 * 1024 * 1024) : '1000') } })))
  })

  it('names the clips that fell back to the ±1-frame source, and why', async () => {
    const r = new WebGLPreviewRenderer()
    await r.load(state(['/view?filename=a.mp4', '/view?filename=huge.mp4', '/view?filename=odd.mov']))
    expect([...r.inexactClips.keys()].sort()).toEqual(['c1', 'c2'])
    expect(r.inexactClips.get('c1')).toBe('the file is larger than 96 MB')
    expect(r.inexactClips.get('c2')).toBe('this browser cannot decode its format frame by frame')
  })

  it('is cleared on the next load', async () => {
    const r = new WebGLPreviewRenderer()
    await r.load(state(['/view?filename=huge.mp4']))
    await r.load(state(['/view?filename=a.mp4']))
    expect(r.inexactClips.size).toBe(0)
  })
})
```

If `tooLargeForWebCodecs` reads the size differently (e.g. `content-length` via `res.headers.get('content-length')`, a HEAD request), adapt the fetch stub to what the code actually does — the stub, not the code.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add `readonly inexactClips = new Map<string, string>()` next to `loadWarnings`; `this.inexactClips.clear()` beside `this.loadWarnings.clear()`. `loadSource` gains a `clipId: string` parameter (pass `clip.id` at its call site); in the too-large branch `this.inexactClips.set(clipId, 'the file is larger than 96 MB')` before returning the element source; in the `UnsupportedSourceError` branch `this.inexactClips.set(clipId, 'this browser cannot decode its format frame by frame')`. Keep the existing `console.warn`s. Doc comment on the field: "Video clips drawn through the seek-and-capture fallback, which can land one frame off — fine for preview, not for export (recordTimeline refuses them)."

- [ ] **Step 4: Run** the new spec + `tests/unit/compositor.unit.spec.ts` — PASS; typecheck grep nothing new.

- [ ] **Step 5: Commit (controller)** — `feat(timeline): the preview renderer names video clips it can only draw ±1 frame`

---

### Task 4: `recordTimeline` — the timeline recorded in the browser

**Files:** Modify `frontend/app/lib/engine/audio/mixdown.ts` (split `ensureTimelineMix`); Create `frontend/app/lib/timeline/recordTimeline.ts`; Test `frontend/tests/unit/record-timeline.unit.spec.ts`

**Interfaces:**
- Consumes: `recordVideo`, `RecordResult` (Task 1), `WebGLPreviewRenderer` + `inexactClips` + `loadWarnings` (Task 3), `RendererLoadOptions`, `computeTotalFrames`, `ClipPreview` type.
- Produces:
  - `mixTimelineAudio(state, resolveClipUrl): Promise<{ buffer: AudioBuffer | null; skipped: number }>` in mixdown.ts; `ensureTimelineMix` unchanged in behaviour, built on it.
  - `class TimelineExportRefused extends Error { clips: string[] }`
  - `describeClip(clip: Clip, fps: number): string` → e.g. `"the video clip at 4.0 s"`.
  - `recordTimeline(state: EditState, deps: TimelineRecordDeps, o?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; onPhase?: (p: 'mixing' | 'rendering') => void }): Promise<{ result: RecordResult; skippedAudio: number; skippedClips: string[] }>`
  - `interface TimelineRecordDeps { resolve: (clip: Clip) => ClipPreview | null; resolveAudioUrl: (clip: Clip) => string | null; createRenderer?: () => RendererLike; record?: typeof recordVideo; mixAudio?: typeof mixTimelineAudio; createCanvas?: () => HTMLCanvasElement }` with `RendererLike = Pick<WebGLPreviewRenderer, 'load' | 'renderFrame' | 'dispose' | 'loadWarnings' | 'inexactClips'>`.

- [ ] **Step 1: Split the mix.** In `mixdown.ts`, move everything in `ensureTimelineMix` up to and including the `renderMixdown(...)` call into:

```ts
/** Mix every audio clip into one stereo AudioBuffer (48 kHz) — the same voices
 *  the preview plays. `buffer` is null when there is nothing to mix or nothing
 *  loaded; a clip whose file is missing / fails to load is left out and counted. */
export async function mixTimelineAudio(
  state: EditState, resolveClipUrl: (clip: Clip) => string | null,
): Promise<{ buffer: AudioBuffer | null; skipped: number }>
```
ending with:
```ts
  const channels = await renderMixdown({ ...plan, voices: plan.voices.filter(v => buffers.has(v.clipId)) }, buffers, ctx)
  const buffer = new AudioBuffer({ length: channels[0]!.length, numberOfChannels: 2, sampleRate: MIX_SAMPLE_RATE })
  buffer.copyToChannel(channels[0]!, 0)
  buffer.copyToChannel(channels[1]!, 1)
  return { buffer, skipped }
```
(the early returns become `{ buffer: null, skipped }`; the 30-minute throw stays). Then:
```ts
export async function ensureTimelineMix(state, resolveClipUrl, slot = null) {
  const { buffer, skipped } = await mixTimelineAudio(state, resolveClipUrl)
  if (!buffer) return { file: null, skipped }
  const file = await uploadMix(encodeWav16([buffer.getChannelData(0), buffer.getChannelData(1)], MIX_SAMPLE_RATE), `${mixTabToken()}_${slot ?? ''}`)
  return { file, skipped }
}
```
Keep the existing comments on `ensureTimelineMix`. `tests/unit/timeline-mixdown.unit.spec.ts` must stay green.

- [ ] **Step 2: Failing test** — `frontend/tests/unit/record-timeline.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { recordTimeline, TimelineExportRefused, describeClip } from '../../app/lib/timeline/recordTimeline'

const S = (clips: any[], extra: any = {}) => ({
  version: 2, canvas: { width: 64, height: 36, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0,
  tracks: [{ id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips }], ...extra,
}) as any
const img = (id: string, start: number, length: number) => ({ id, kind: 'image', asset_id: 'a', start_frame: start, in_frame: 0, length })

function fakes(opts: { inexact?: [string, string][]; failed?: [string, string][] } = {}) {
  const log: string[] = []
  const renderer = {
    loadWarnings: new Map(opts.failed ?? []), inexactClips: new Map(opts.inexact ?? []),
    load: vi.fn(async (_s: any, o: any) => { log.push('load'); expect(typeof o.resolve).toBe('function') }),
    renderFrame: vi.fn(async (i: number, target: any) => { log.push(`render ${i}`); target.frame = i }),
    dispose: vi.fn(() => log.push('dispose')),
  }
  const record = vi.fn(async (req: any) => {
    for (let i = 0; i < req.frameCount; i++) await req.drawFrame(i, { drawImage: (c: any) => log.push(`copy ${c.frame}`) })
    return { blob: new Blob(['v']), ext: 'mp4', contentType: 'video/mp4', width: req.width, height: req.height }
  })
  const buffer = { duration: 1 } as any
  const mixAudio = vi.fn(async () => { log.push('mix'); return { buffer, skipped: 1 } })
  return { log, renderer, record, mixAudio, buffer, createCanvas: () => ({}) as any }
}

describe('recordTimeline', () => {
  it('mixes, loads, records every frame of the timeline with the mix as sound, then disposes', async () => {
    const f = fakes()
    const phases: string[] = []
    const r = await recordTimeline(S([img('a', 0, 3)]), {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    }, { onPhase: p => phases.push(p) })
    expect(phases).toEqual(['mixing', 'rendering'])
    expect(f.record.mock.calls[0]![0]).toMatchObject({ width: 64, height: 36, fps: 30, frameCount: 3, audio: f.buffer })
    expect(f.log).toEqual(['mix', 'load', 'render 0', 'copy 0', 'render 1', 'copy 1', 'render 2', 'copy 2', 'dispose'])
    expect(r.skippedAudio).toBe(1)
  })

  it('refuses, by name, clips that can only be drawn ±1 frame or failed to load — and still disposes', async () => {
    const f = fakes({ inexact: [['v1', 'the file is larger than 96 MB']], failed: [['i2', 'fetch 404']] })
    const state = S([{ id: 'v1', kind: 'video', asset_id: 'a', start_frame: 120, in_frame: 0, length: 30 }, img('i2', 0, 30)])
    const err = await recordTimeline(state, {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    }).then(() => null, e => e)
    expect(err).toBeInstanceOf(TimelineExportRefused)
    expect(err.clips).toEqual(['the video clip at 4.0 s', 'the image clip at 0.0 s'])
    expect(err.message).toBe("These clips can't be drawn frame-exactly in the browser: the video clip at 4.0 s (the file is larger than 96 MB); the image clip at 0.0 s (fetch 404).")
    expect(f.record).not.toHaveBeenCalled()
    expect(f.log.at(-1)).toBe('dispose')
  })

  it('lists workflow clips with nothing to draw as skipped, like the server does', async () => {
    const f = fakes()
    const state = S([img('a', 0, 2), { id: 'w', kind: 'workflow', port_index: 0, start_frame: 30, in_frame: 0, length: 10 }])
    const r = await recordTimeline(state, {
      resolve: c => (c.kind === 'workflow' ? null : { url: 'u', kind: 'image' } as any), resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    })
    expect(r.skippedClips).toEqual(['the workflow clip at 1.0 s'])
  })

  it('no sound → no audio track asked for', async () => {
    const f = fakes()
    f.mixAudio.mockResolvedValueOnce({ buffer: null, skipped: 0 })
    await recordTimeline(S([img('a', 0, 1)]), {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    })
    expect(f.record.mock.calls[0]![0].audio).toBeUndefined()
  })

  it('describeClip speaks plainly', () => {
    expect(describeClip({ kind: 'lower_third', start_frame: 45 } as any, 30)).toBe('the lower third clip at 1.5 s')
  })
})
```

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** `frontend/app/lib/timeline/recordTimeline.ts`:

```ts
import type { Clip, EditState } from '~~/shared/timeline/types'
import { computeTotalFrames } from '~~/shared/timeline/types'
import type { ClipPreview } from '~/composables/usePlaybackEngine'
import { WebGLPreviewRenderer } from '~/lib/engine/webglPreviewRenderer'
import { recordVideo, type RecordResult } from '~/lib/engine/videoRecorder'
import { mixTimelineAudio } from '~/lib/engine/audio/mixdown'

// The timeline recorded in the browser: a private WebGL preview renderer (the
// same draw list, transitions, filters and text the preview shows) draws each
// frame; the audio mix the preview plays becomes the sound track. A clip the
// renderer can only draw ±1 frame, or could not load, is refused by name — an
// export must not quietly contain a wrong frame. Workflow clips with no file
// yet are left out, exactly as the server render does, and listed.

type RendererLike = Pick<WebGLPreviewRenderer, 'load' | 'renderFrame' | 'dispose' | 'loadWarnings' | 'inexactClips'>

export interface TimelineRecordDeps {
  resolve: (clip: Clip) => ClipPreview | null
  resolveAudioUrl: (clip: Clip) => string | null
  createRenderer?: () => RendererLike
  record?: typeof recordVideo
  mixAudio?: typeof mixTimelineAudio
  createCanvas?: () => HTMLCanvasElement
}

export class TimelineExportRefused extends Error {
  constructor(message: string, readonly clips: string[]) {
    super(message)
    this.name = 'TimelineExportRefused'
  }
}

const KIND_WORDS: Record<string, string> = { lower_third: 'lower third', spacetype: 'Space Type', workflow: 'workflow' }

export function describeClip(clip: Pick<Clip, 'kind' | 'start_frame'>, fps: number): string {
  return `the ${KIND_WORDS[clip.kind] ?? clip.kind} clip at ${(clip.start_frame / fps).toFixed(1)} s`
}

export async function recordTimeline(
  state: EditState,
  deps: TimelineRecordDeps,
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; onPhase?: (p: 'mixing' | 'rendering') => void } = {},
): Promise<{ result: RecordResult; skippedAudio: number; skippedClips: string[] }> {
  const { width, height, fps } = state.canvas
  const clips = new Map<string, Clip>()
  for (const t of state.tracks) for (const c of t.clips) clips.set(c.id, c)

  o.onPhase?.('mixing')
  const { buffer, skipped: skippedAudio } = await (deps.mixAudio ?? mixTimelineAudio)(state, deps.resolveAudioUrl)

  const renderer = (deps.createRenderer ?? (() => new WebGLPreviewRenderer()))()
  try {
    await renderer.load(state, { resolve: deps.resolve })
    const problems: [string, string][] = []
    for (const [id, why] of renderer.inexactClips) problems.push([id, why])
    for (const [id, why] of renderer.loadWarnings) problems.push([id, why])
    if (problems.length) {
      const names = problems.map(([id]) => describeClip(clips.get(id)!, fps))
      throw new TimelineExportRefused(
        `These clips can't be drawn frame-exactly in the browser: ${problems.map(([, why], i) => `${names[i]} (${why})`).join('; ')}.`,
        names,
      )
    }
    const skippedClips: string[] = []
    for (const t of state.tracks) {
      if (t.muted || t.kind === 'audio') continue
      for (const c of t.clips) if (c.kind === 'workflow' && !deps.resolve(c)) skippedClips.push(describeClip(c, fps))
    }
    o.onPhase?.('rendering')
    const scratch = (deps.createCanvas ?? (() => document.createElement('canvas')))()
    const result = await (deps.record ?? recordVideo)({
      width, height, fps, frameCount: computeTotalFrames(state),
      audio: buffer ?? undefined,
      signal: o.signal, onProgress: o.onProgress,
      // renderFrame sizes `scratch` to the timeline and blits its WebGL canvas
      // into it; the recorder's own canvas may be one pixel larger (even size).
      drawFrame: async (i, ctx) => {
        await renderer.renderFrame(i, scratch)
        ctx.drawImage(scratch, 0, 0)
      },
    })
    return { result, skippedAudio, skippedClips }
  } finally {
    renderer.dispose()
  }
}
```

`loadWarnings` are included in the refusal: a clip the preview skips because its file failed would be silently missing from the video — today's server render would include it, so the browser must not quietly differ. The test's expected order puts inexact clips first, then failed ones — keep that order.

- [ ] **Step 5: Run** `npx vitest run tests/unit/record-timeline.unit.spec.ts tests/unit/timeline-mixdown.unit.spec.ts` — PASS; typecheck grep `timeline/recordTimeline|audio/mixdown` — nothing new.

- [ ] **Step 6: Commit (controller)** — `feat(timeline): recordTimeline — the timeline drawn by the preview renderer, with its mix, recorded in the browser`

---

### Task 5: The quality gate for timeline exports

**Files:** Create `frontend/app/pages/dev/timeline-export-harness.vue`, `frontend/tests/timeline-browser-export.spec.ts`

**Interfaces:**
- Consumes: `recordTimeline`, `encodeWav16` (mixdown.ts), `uploadFrameBatch` or a plain `/upload/image` POST, mediabunny `Input`, `BlobSource`, `ALL_FORMATS`, `CanvasSink`, `AudioBufferSink`.
- Produces: `window.__timelineExport = { makeTone(o), makeImage(o), run(state), ready: true }`.

- [ ] **Step 1: The harness page** — `frontend/app/pages/dev/timeline-export-harness.vue` (mirror `app/pages/dev/video-export-harness.vue`'s structure and page meta):

```vue
<template>
  <div style="padding: 8px; font: 12px monospace">timeline export harness ready</div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import type { EditState, Clip } from '~~/shared/timeline/types'
import { recordTimeline } from '~/lib/timeline/recordTimeline'
import { encodeWav16 } from '~/lib/engine/audio/mixdown'

async function upload(blob: Blob, name: string): Promise<string> {
  const fd = new FormData()
  fd.append('image', new File([blob], name, { type: blob.type }))
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`upload ${res.status}`)
  const d = await res.json()
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name
}

/** A WAV: `silenceSec` of silence, then a `hz` tone for `toneSec`. */
async function makeTone(o: { silenceSec: number; toneSec: number; hz: number }): Promise<string> {
  const sr = 48000
  const n = Math.round((o.silenceSec + o.toneSec) * sr)
  const ch = new Float32Array(n)
  for (let i = Math.round(o.silenceSec * sr); i < n; i++) ch[i] = 0.5 * Math.sin(2 * Math.PI * o.hz * i / sr)
  return upload(new Blob([encodeWav16([ch, ch], sr)], { type: 'audio/wav' }), `tlx_tone_${Date.now()}.wav`)
}

async function makeImage(o: { w: number; h: number; color: string }): Promise<string> {
  const c = document.createElement('canvas'); c.width = o.w; c.height = o.h
  const ctx = c.getContext('2d')!; ctx.fillStyle = o.color; ctx.fillRect(0, 0, o.w, o.h)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
  return upload(blob, `tlx_img_${Date.now()}.png`)
}

const viewUrl = (f: string) => `/view?${new URLSearchParams({ filename: f, type: 'input' })}`

async function run(state: EditState) {
  const t0 = performance.now()
  const { result, skippedAudio, skippedClips } = await recordTimeline(state, {
    resolve: (c: Clip) => ((c.kind === 'image' || c.kind === 'video') && c.path ? { url: viewUrl(c.path), kind: c.kind } : null),
    resolveAudioUrl: (c: Clip) => (c.kind === 'audio' && c.path ? viewUrl(c.path) : null),
  })
  const ms = performance.now() - t0
  const { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS })
  const v = await input.getPrimaryVideoTrack()
  const a = await input.getPrimaryAudioTrack()
  let frames = 0
  const centre: number[][] = []
  for await (const wc of new CanvasSink(v!).canvases()) {
    const c = wc.canvas as HTMLCanvasElement
    const p = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
    centre.push([p[0]!, p[1]!, p[2]!])
    frames++
  }
  let onset: number | null = null
  let audioCodec: string | null = null
  if (a) {
    audioCodec = await a.getCodec()
    for await (const { buffer, timestamp } of new AudioBufferSink(a).buffers()) {
      const d = buffer.getChannelData(0)
      const i = d.findIndex(x => Math.abs(x) > 0.1)
      if (i >= 0) { onset = timestamp + i / buffer.sampleRate; break }
    }
  }
  return {
    frames, ms, bytes: result.blob.size, ext: result.ext, skippedAudio, skippedClips,
    duration: await input.computeDuration(), colorSpace: await v!.getColorSpace(),
    audioCodec, onset, centre,
  }
}

onMounted(() => { (window as any).__timelineExport = { makeTone, makeImage, run, ready: true } })
</script>
```

If mediabunny's `AudioBufferSink` yields a different shape (read `node_modules/mediabunny/dist/mediabunny.d.ts` — `WrappedAudioBuffer`), adapt the loop to it and say so in the report.

- [ ] **Step 2: The browser test** — `frontend/tests/timeline-browser-export.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test'

// The timeline recorded in the browser (plan 3): every frame, the right length,
// BT.709, sound on the right frame, and a plain text clip laid out where the
// server lays it out. The page uploads its own tiny test assets to input/.

async function harness(page: Page) {
  await page.goto('/dev/timeline-export-harness')
  await page.waitForFunction(() => (window as any).__timelineExport?.ready, null, { timeout: 60_000 })
}
const H = (page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window as any).__timelineExport[f as string](a), [fn, arg] as const)

const base = (tracks: any[]) => ({
  version: 2, canvas: { width: 320, height: 180, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0, tracks,
})

test.describe('timeline recorded in the browser', () => {
  test.setTimeout(180_000)

  test('every frame, the right length, BT.709, and the sound lands on the right frame', async ({ page }) => {
    await harness(page)
    const img = await H(page, 'makeImage', { w: 320, h: 180, color: '#3060c0' })
    const tone = await H(page, 'makeTone', { silenceSec: 0.5, toneSec: 1, hz: 1000 })
    // Image 0..90 frames (3 s). Audio clip starts at frame 30 (1.0 s); its file
    // is silent for 0.5 s, so the beep must start at 1.5 s.
    const state = base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{ id: 'i', kind: 'image', asset_id: 'x', path: img, start_frame: 0, in_frame: 0, length: 90 }] },
      { id: 'a', kind: 'audio', name: 'A', muted: false, locked: false, clips: [{ id: 't', kind: 'audio', asset_id: 'y', path: tone, start_frame: 30, in_frame: 0, length: 45 }] },
    ])
    const r: any = await H(page, 'run', state)
    test.info().annotations.push({ type: 'result', description: JSON.stringify({ ...r, centre: r.centre.slice(0, 2) }) })
    expect(r.frames).toBe(90)
    expect(Math.abs(r.duration - 3)).toBeLessThanOrEqual(1 / 30 + 0.05)
    expect(r.colorSpace.primaries).toBe('bt709')
    expect(r.colorSpace.fullRange).toBe(false)
    expect(r.audioCodec).toBe('aac')
    expect(Math.abs(r.onset - 1.5)).toBeLessThanOrEqual(1 / 30)
    // The image's colour survives the round trip (±6 levels per channel).
    const [red, green, blue] = r.centre[45]
    expect(Math.abs(red - 0x30)).toBeLessThanOrEqual(6)
    expect(Math.abs(green - 0x60)).toBeLessThanOrEqual(6)
    expect(Math.abs(blue - 0xc0)).toBeLessThanOrEqual(6)
  })

  test('a timeline with no sound makes a video with no audio track', async ({ page }) => {
    await harness(page)
    const img = await H(page, 'makeImage', { w: 320, h: 180, color: '#808080' })
    const r: any = await H(page, 'run', base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{ id: 'i', kind: 'image', asset_id: 'x', path: img, start_frame: 0, in_frame: 0, length: 15 }] },
    ]))
    expect(r.frames).toBe(15)
    expect(r.audioCodec).toBeNull()
  })

  test('a plain text clip is drawn where the server draws it', async ({ page }) => {
    // Rendered by the timeline harness through both renderers; compare the
    // bounding box of the text pixels (fonts differ slightly, layout must not).
    await page.goto('/timeline-harness')
    await page.waitForFunction(() => !!(window as any).__timelineHarness, null, { timeout: 60_000 })
    const state = base([
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips: [{
        id: 'tx', kind: 'text', start_frame: 0, in_frame: 0, length: 10,
        text: { text: 'Hello world', font_size: 40, color: '#ffffff', bg_color: '#000000', align: 'center', v_align: 'middle', padding: 0.06, line_spacing: 1.2 },
      }] },
    ])
    const box = async (kind: 'webgl' | 'server') => page.evaluate(async ([json, k]) => {
      const h = (window as any).__timelineHarness
      await h.load(json, k)
      const url: string = await h.renderFrame(0)
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4]! > 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
      }
      return { x0, y0, x1, y1 }
    }, [JSON.stringify(state), kind] as const)
    const serverUp = await page.evaluate(() => fetch('/system_stats').then(r => r.ok).catch(() => false))
    const b = await box('webgl')
    expect(b.x1).toBeGreaterThan(b.x0)                // something was drawn
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
    expect(Math.abs(cx - 160)).toBeLessThanOrEqual(8) // centred, like the server's layout
    expect(Math.abs(cy - 90)).toBeLessThanOrEqual(8)
    if (serverUp) {
      const s = await box('server')
      test.info().annotations.push({ type: 'boxes', description: JSON.stringify({ webgl: b, server: s }) })
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(b[k] - s[k])).toBeLessThanOrEqual(0.06 * 320)
    }
  })
})
```

If `timeline-harness.vue`'s API differs from `load(stateJson, kind)` / `renderFrame(frame) → dataURL` (read it), adapt the calls and say so.

- [ ] **Step 3: Run** `npx playwright test tests/timeline-browser-export.spec.ts --project=chromium --reporter=list` — 3 passed. Record the `result` and `boxes` annotations in the report. If the sound onset is off by more than one frame, STOP and report the measured onset (do not loosen the tolerance): that would be a real sync bug.

- [ ] **Step 4: Clean up** — delete the `tlx_*` files the runs uploaded (`input/tlx_img_*.png`, `input/tlx_tone_*.wav`) — only those.

- [ ] **Step 5: Commit (controller)** — `test(timeline): browser export gate — frames, length, BT.709, sound on the right frame, text where the server draws it`

---

### Task 6: The timeline's Export button records in the browser

**Files:** Modify `frontend/app/components/vue-canvas/TimelineEditor.vue` — `renderViaFFmpeg` (~1147–1301) and its refs (~1135–1145), the export button template (~1917–1946), `onUnmounted` (~114), imports

**Interfaces:**
- Consumes: `recordTimeline`, `TimelineExportRefused` (Task 4); `publishVideo`, `HOSTED_UPLOAD_LIMIT`; `canRecordInBrowser` (with `audio: true`), `prefersServerVideoExport`; `isAbortError`; `hostedModeEnabled`; local `resolveClipPreview`, `resolveAudioUrl`, `store`.

- [ ] **Step 1: Typecheck baseline** for `vue-canvas/TimelineEditor\.vue`. Read `renderViaFFmpeg`, its refs, the button template and `onUnmounted`.

- [ ] **Step 2: Split the server route out, unchanged.** Rename today's `renderViaFFmpeg` to `renderOnServer`, and delete ONLY its first lines — the `if (isRendering.value) return` guard and the block that resets `renderError`/`renderNotice`/`renderResult`/`renderProgress` and sets `isRendering = true` — because the new entry point does those. Everything else in it (bakes, mix, payload, NDJSON stream, its `finally` that clears `isRendering`/`renderProgress`/`renderPhase`) stays byte-identical. Give it a comment: `/** Today's route: bake Motion/Space Type clips, mix and upload the sound, and let the Python renderer draw every frame. The local fallback (and the only route a Timeline node inside a workflow uses). */`

- [ ] **Step 3: New state** next to the other render refs:

```ts
// The browser export in flight, so Cancel can stop it.
let exportAbort: AbortController | null = null
```
and widen `renderPhase` to `ref<'baking' | 'mixing' | 'rendering' | 'uploading' | null>(null)`.

- [ ] **Step 4: The new entry point** (the button and any other caller of `renderViaFFmpeg` — `grep` for it — now call `exportTimeline`):

```ts
/** Export: recorded in the browser — the preview's own renderer, with the
 *  sound — or, in local mode only and said out loud, today's server render. */
async function exportTimeline() {
  if (isRendering.value) return
  renderError.value = null
  renderNotice.value = null
  renderResult.value = null
  renderProgress.value = null
  isRendering.value = true
  store.pause()
  const es = store.state.value
  const hosted = hostedModeEnabled(useRuntimeConfig().public)
  let reason = ''   // why the browser route was not used ('' = the server route was chosen on purpose)

  if (!hosted && prefersServerVideoExport()) {
    // fall through to the server route below
  } else if (!(await canRecordInBrowser({ width: es.canvas.width, height: es.canvas.height, fps: es.canvas.fps, audio: true }))) {
    reason = "this browser can't record video"
  } else {
    exportAbort = new AbortController()
    try {
      const { result, skippedAudio, skippedClips } = await recordTimeline(es, {
        resolve: clip => resolveClipPreview(clip),
        resolveAudioUrl: clip => resolveAudioUrl(clip),
      }, {
        signal: exportAbort.signal,
        onPhase: p => { renderPhase.value = p; renderProgress.value = null },
        onProgress: (done, total) => { renderProgress.value = { current: done, total } },
      })
      if (hosted && result.blob.size > HOSTED_UPLOAD_LIMIT) throw new Error('This video is larger than 100 MB, the upload limit.')
      renderPhase.value = 'uploading'
      renderProgress.value = null
      const filename = await publishVideo(result.blob, result.ext, 'timeline')
      if (exportAbort.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      renderResult.value = { url: `/view?${new URLSearchParams({ filename, type: 'input' })}`, filename }
      const notes: string[] = []
      if (skippedClips.length) notes.push(`${skippedClips.length === 1 ? 'One clip fed by a workflow has' : `${skippedClips.length} clips fed by a workflow have`} nothing to show yet and ${skippedClips.length === 1 ? 'was' : 'were'} left out.`)
      if (skippedAudio === 1) notes.push('One audio clip could not be loaded, so it was left out.')
      else if (skippedAudio > 1) notes.push(`${skippedAudio} audio clips could not be loaded, so they were left out.`)
      renderNotice.value = notes.join(' ') || null
      isRendering.value = false
      renderPhase.value = null
      renderProgress.value = null
      return
    } catch (err) {
      if (isAbortError(err)) {
        renderNotice.value = 'Export cancelled.'
        isRendering.value = false; renderPhase.value = null; renderProgress.value = null
        return
      }
      console.warn('[timeline] browser export failed', err)
      if (err instanceof TimelineExportRefused) reason = err.message.replace(/\.$/, '')
      else if (err instanceof Error && err.message.startsWith('This video is larger')) reason = err.message.replace(/\.$/, '')
      else reason = "the browser's video encoder failed"
    } finally {
      exportAbort = null
    }
  }

  if (hosted) {
    renderError.value = reason.startsWith('These clips')
      ? `${reason}. Replace them with a smaller or more common video file.`
      : `Video export failed: ${reason}.`
    isRendering.value = false; renderPhase.value = null; renderProgress.value = null
    return
  }
  renderNotice.value = reason ? `Made on the server, because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` : 'Made on the server (browser recording is switched off).'
  await renderOnServer()
}
```

Notes: `renderOnServer` may overwrite `renderNotice` with its own mix notices — if so, keep the fallback sentence by prefixing: in `renderOnServer`, where it assigns a mix notice, append to an existing notice (`renderNotice.value = [renderNotice.value, text].filter(Boolean).join(' ')`) rather than replace it. That is the ONE change allowed inside `renderOnServer`.

- [ ] **Step 5: Cancel and labels.** In the export button's label expression, add the phases: `renderPhase === 'uploading' ? 'Uploading…'` before the rendering percentage branch (mixing already reads "Mixing sound…"). Directly after the export button add:

```html
<button v-if="isRendering && exportAbort !== null" type="button" class="px-2 h-7 rounded text-xs text-white/60 hover:text-white hover:bg-white/10" @click="exportAbort?.abort()">Cancel</button>
```
`exportAbort` is a plain `let`; if the template cannot react to it, add `const browserExporting = ref(false)` set true/false around the browser branch and use `v-if="browserExporting"` + `function cancelExport() { exportAbort?.abort() }`. The result link keeps working (`renderResult.url` now points at `type=input` for browser-made files).

- [ ] **Step 6: Abort on close** — in the existing `onUnmounted` (where `store.pause()` runs), add `exportAbort?.abort()` first.

- [ ] **Step 7: Tests and typecheck.** `npx vitest run tests/unit/record-timeline.unit.spec.ts tests/unit/timeline-editing-flows.unit.spec.ts tests/unit/timeline-mixdown.unit.spec.ts` PASS; typecheck grep no new lines; `npx playwright test tests/timeline-browser-export.spec.ts --project=chromium` still 3 passed.

- [ ] **Step 8: Prove it in the real editor (controller).** On the canvas at `http://127.0.0.1:3002`, a Timeline node with: two image clips with a crossfade, a title clip, a plain text clip, a video clip (a small MP4 from the asset library), and two audio clips on two tracks (one with a fade). Export with the default route → phases "Mixing sound…", "n%", "Uploading…", a result link to `timeline_<ts>.mp4`; forced server (`localStorage['Sailor.VideoExport']='server'`) → the notice "Made on the server (browser recording is switched off).", a result in `output/`. Compare with `compare_videos.py` (same frame count and size, BT.709); expect the TITLE to be present only in the browser file (today's server render drops titles — say so in the report, it is the known fix). Then the **timing check**: the same timeline with three video clips playing at once, both routes, wall-clock from click to result; record both times. If the browser route is slower than the server on that timeline, report it — the controller decides whether to keep the switch. Cancel mid-export → "Export cancelled.", no new file. Delete every file the checks created.

- [ ] **Step 9: Commit (controller)** — `feat(timeline): Export records in the browser — the preview's renderer, every audio clip, titles included, hosted-ready; server render kept as a visible fallback`

---

## After this plan

- `docs/STATE.md`: the timeline entry (browser export, what it fixed — titles, text, no pre-bake —, measured times, the escape hatch) and flip the dashboard's "hosted timeline export" line.
- Start the two-week clock for retiring `/sailor/spacetype_encode` (studios). The Python timeline render stays.
- Deferred: captions and mattes; transparent timeline export; files over the hosted 100 MB cap (a streaming/chunked upload target for `recordVideo`); exact decode for videos over 96 MB (streaming demux).
