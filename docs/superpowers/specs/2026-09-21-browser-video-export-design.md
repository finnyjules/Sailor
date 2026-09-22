# One browser video export — design

Date: 2026-09-21. Status: approved in brainstorm, ready for an implementation plan.

## Plain-language summary

Every "Export video" button in Sailor sends work to the Python server today: the browser draws each frame, saves it as a PNG, uploads hundreds of PNGs, and the server encodes them. This is slow (measured ~77–96 s of overhead on a 900-frame 1080p studio export, on top of drawing), holds over a gigabyte of pictures in memory, and — the reason this matters now — is **switched off entirely in hosted mode**, because the encode routes write to a shared folder. There is also no Cancel anywhere.

This design moves encoding into the browser with the `mediabunny` library. The browser draws each frame straight into the machine's video hardware and writes the file locally. Measured once (July 2026, this Mac): ~12× faster after drawing, ~60× less memory. It works in hosted mode because it needs no new server route — only the existing, hosted-safe upload of the one finished file.

Nothing about the buttons or formats changes: MP4 by default, transparent WebM when the background is empty, no new settings. The one visible addition is a **Cancel** button. Every surface keeps the drawing code it already has; only the last step (frame → PNG → upload → server-encode) is replaced by (frame → recorder → publish).

**What is risky / what you will notice:** the browser video encoder behaves differently across machines and browsers, so there is a safety net — in local mode a failed or unsupported export falls back to today's server route and says so; in hosted mode it shows a clear message. The timeline is the hardest surface and goes last: its browser preview must first learn to draw plain text clips (it skips them today), and its speed with several video clips at once is unmeasured, so it only switches after a timing check. Captions, mattes, a quality slider and a format picker are **not** in this design.

## Goal

One browser-side video export used by every surface that produces video: the five studios (Shader, Space Type, Gradient, Scene3D, Compositor/Frame including wired Frames) and the multi-track Timeline. Replace the PNG-upload-then-server-encode pipeline. Keep exports pixel-comparable to today, prove each surface before switching it, and keep a working fallback.

## Chosen approach (A, with an embed bridge)

Rejected alternatives:
- **B — every surface adopts the web-embed contract first, one generic exporter drives them all.** Cleaner end state, but the embed contract is "set the time, now, no waiting" (a web page must never stall), which the Timeline and wired Compositor cannot satisfy — they wait on video decoding and read from the node graph. It also means nothing ships until the contract is right for all six surfaces, and it would have two sessions reshaping the embed contract at once. Deferred; A leaves it reachable as a later cleanup.
- **C — record the canvas live with `MediaRecorder`.** Almost no code, but real-time only (a 30 s video takes 30 s), drops frames under load, no frame-exactness, no proper alpha, no quality control. Ruled out.

A is chosen because it delivers a working, tested result per surface within days, contains failures to one surface at a time, and gives the Timeline and wired Compositor the "draw at time t, waiting allowed" shape they actually need.

## Components

### 1. The recorder (`frontend/app/lib/engine/videoRecorder.ts`, new)

Pure-ish encoder wrapper around `mediabunny`. Knows nothing about studios/timeline/Frames.

Proposed interface (final names settled in the plan):
```ts
export interface RecordRequest {
  width: number
  height: number
  fps: number
  frameCount: number
  /** Draw frame i (0-based) onto `ctx`'s canvas; may await (video decode, font load, wired pull). */
  drawFrame: (i: number, canvas: HTMLCanvasElement) => Promise<void> | void
  alpha?: boolean                      // true → VP9/WebM with an alpha plane; else H.264/MP4
  audio?: AudioBuffer | null           // optional mixed track (Timeline)
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal                 // Cancel
}
export interface RecordResult { blob: Blob; ext: 'mp4' | 'webm'; contentType: string }
export async function recordVideo(req: RecordRequest): Promise<RecordResult>
```
Behaviour:
- Pulls frames one at a time via `drawFrame`; encodes each as produced through mediabunny's `CanvasSource` (avc/mp4) or `{codec:'vp9', alpha:'keep'}`/`WebMOutputFormat` (webm), fed from an `HTMLCanvasElement` / `OffscreenCanvas`. Never holds all frames — memory stays ~constant.
- **Colour tag set explicitly to BT.709** on both containers (the July finding: mediabunny tagged WebM BT.601 and MP4 BT.709 from the same canvas; the server tags BT.709 — see `webcodecs-alpha-via-mediabunny` memory).
- **Timestamps computed from frame index**, never wall-clock: `frame i` at `i/fps` seconds. A slow machine slows the export but never drops/doubles a frame.
- **Even dimensions:** rounds W/H up to even for H.264 and records that it did (the server silently rounds today).
- **Quality** derived from resolution×fps to meet-or-beat today's server bitrate; no user control.
- `signal` aborts cleanly (tears down encoder, resolves rejected).
- Returns a `Blob` + extension + content-type; does not upload.

### 2. The publisher (`frontend/app/lib/engine/publishVideo.ts`, new)

Takes a `RecordResult`, uploads the single finished file via the existing `/upload/image` route (accepts any file type, hosted-safe), returns the server filename in the shape every surface already consumes. One upload of one file, replacing hundreds of PNG uploads. Preserves today's three downstream uses: download link (`/view`), save to Assets (`recordAsset` → `saveGeneration`), and Video-node-on-canvas (the `sailor:*Output` events with `widgetOverrides.file`).

### 3. The capability check + safety net (`frontend/app/lib/engine/videoExportSupport.ts`, new)

- Before recording, probe whether this browser can encode this codec at this size (`VideoEncoder.isConfigSupported`, WebGL2/canvas availability).
- On "no", or on a recorder throw mid-export:
  - **Local mode:** fall back to the existing PNG→`spacetype_encode` / `render_timeline_stream` path and surface a visible notice ("Exported with the server — the browser encoder was unavailable").
  - **Hosted mode:** show a clear message with the reason (no server fallback exists there).
- Never a silent fallback. (This session reinforced: a quiet fallback hides a broken path — see `graceful-fallback-hides-integration-failure`.)

### 4. The embed bridge (`frontend/app/lib/engine/recordEmbed.ts`, new)

A thin adapter: given an `EmbedSurface`/`EmbedHandle` (the July contract — `mount`/`setTime`/`setSize`/`destroy`, `caps.alpha`; `frontend/app/lib/embed/contract.ts`), produce a `drawFrame` for the recorder (`setTime(i/frameCount)` then hand over its canvas). **Reads the embed contract; never edits it or any embed file.** This is how Frame (from the parallel embed session) and later Vector Type / Shape / Texture get video export cheaply.

## Per-surface change

Each surface keeps its existing deterministic frame draw and swaps only the tail:
- Studios (Shader/Space Type/Gradient/Scene3D/Frame) drive frames through the shared bake helper `ensureSpaceTypeBake` (`frontend/app/lib/spacetype/bake.ts`) with `renderFrame(i) => Promise<Blob>`. The swap routes that same per-frame draw into `recordVideo` instead of PNG-blob + `uploadFrameBatch` + `encodeFrames`. Most of the change lives in the shared helper's export sink; each surface is still switched and verified one at a time.
- Wired Compositor/Frame: `renderCompositeAtTime(t)` (`ArtifactFrameNode.vue:907`) already pulls every wired layer to its phase, awaits it, and paints — exactly the "draw at time t, waiting allowed" contract. Its canvas goes straight to the recorder. Drawing code untouched, so wired video/studio layers and transparency behave as today.
- Timeline: `renderViaFFmpeg` in `TimelineEditor.vue` switches from posting an `EditState` to Python, to driving the browser preview renderer (`webglPreviewRenderer.renderFrame`, already awaitable and frame-exact) frame by frame into the recorder, with the mixed WAV (`ensureTimelineMix`, built this week) passed as `audio`.

## Correctness gates (per surface, kept as tests)

A surface's button switches only after the same piece is exported both ways and compared on:
1. **Colour** — BT.709 tag present; pixel values read back match.
2. **Frame count & length** — exactly as requested.
3. **Sharpness** — file size and per-frame difference vs the source frames; browser must be at least as close to source as the server. Pass mark set before building.
4. **Transparency** (where it applies) — alpha read back with the correct decoder (`libvpx-vp9`, not ffmpeg's native vp9, per the July trap).
5. **Sound** (Timeline) — the tone-probe method from this week: known beeps at known times, measured in the finished file.

## Timeline extra work (stage 4)

- **Preview learns plain text clips** (it warns and skips today; titles/lower-thirds already draw via the text painter, so this extends that).
- **Titles & lower-thirds** then appear in export (a silent drop in today's server export — a bug fixed for free).
- **Motion / Space Type clips** draw live — the pre-bake-and-upload phase disappears.
- **Exact video decode** for export: raise `WEBCODECS_MAX_BYTES`, stream big files; where a clip genuinely can't decode exactly, name it and fall back (local) rather than export a wrong frame.
- **Older non-WebGL2 preview** can't be an export path → falls back (local) / message (hosted). Rare.
- **Timing check** before switching, including one multi-video-clip timeline (the case most likely to be slow).

## Python's fate

- **Studio encode route (`/sailor/spacetype_encode`)**: retired after a ~2-week proving period.
- **Timeline renderer (`render_timeline_stream`)**: **stays** — a Timeline node running inside a workflow still needs it, and it is the local fallback. It stops growing: new timeline features are built once, in the browser. The golden parity test stays for features both paths have.

## Build order

1. Recorder + publisher + safety net, proven on **Shader Studio** (gates 1–3, first Cancel).
2. **Space Type, Gradient, Scene3D** (shared helper; transparency proven here).
3. **Compositor + Frame** incl. wired (after the embed session lands Frame draw); embed bridge tested against the 3 existing embed surfaces.
4. **Timeline** (plain-text clips, audio, exact decode, tone-probe + timing gates; switch last).
5. Retire the studio encode route after the proving period.

Every stage ends with a real exported file, made both ways and compared. Nothing switches on a promise.

## Coordination with the parallel embed session

- This work does not edit `frontend/app/lib/embed/*` or the embed contract; the bridge only reads it.
- Stage 3 waits for the embed session's Frame work so the two never edit Frame draw simultaneously.
- A note in the repo asks that session to keep "draw the Frame at time t" as one plain function separate from web-page mounting, and to signal when it lands. (Shared-checkout hygiene: `parallel-sessions-commit-hygiene`, `private-git-index-is-the-fix-for-shared-staging`.)

## Out of scope

Captions and mattes (drawn nowhere today); a quality slider / format picker; shader-based video transitions (become easy afterward, separate design); video export for Vector Type / Shape / Texture (cheap later via the bridge).

## Risks

- Browser encoder varies by machine → the capability check + safety net.
- Timeline multi-video decode speed → the timing gate before switching.
- Safari/Firefox unproven → Chrome/Edge are the target; fallback covers the rest; the repo already has a Safari engine test project.
