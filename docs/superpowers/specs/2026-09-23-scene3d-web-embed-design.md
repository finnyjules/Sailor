# 3D Studio on the web — design

Date: 2026-09-23. Sibling of `2026-09-21-frame-web-export-design.md` (Frame web export), which lists
this as "3D Studio web version — own spec, next". Status: design approved in conversation; this
document is the record.

## In plain words

A 3D scene made in 3D Studio should play, animated, on any web page — as its own piece, and inside
an exported Frame. Julien wants **both equally**, and embeds a **real mix** of scenes: type and logos
with the built-in lighting, product shots with real models lit by an HDRI, and heavily styled scenes
(treatments, post effects, AI restyle, cinematic).

No single way of playing 3D on a web page serves all of those, so the export has **two routes** and
picks one per scene:

- **Pre-rendered** — at export, the loop is rendered into frames and the page plays them back. It
  matches the editor exactly (treatments, restyle, even cinematic), is light on the viewer's phone,
  and works inside Frames straight away because Frames already play image clips. It has a fixed
  resolution, and the file grows with the loop's length and size.
- **Live** — the page carries the 3D engine and draws the scene itself. It stays sharp at any size,
  and a light scene is a small file. Heavy assets make it big, and some looks can't come through.

The export sheet picks the route from what the scene uses, says why, and lets you override it.

It ships in **two phases**. **Phase 1 is the pre-rendered route**: on its own it already delivers a
standalone 3D export *and* 3D inside Frame exports, for every kind of scene, looking right. **Phase 2
adds the live route** for the light scenes, and registers it so Frame nesting (Frame stage 2, its own
plan) picks it up.

Each phase gets its own implementation plan. Phase 1 covers Parts 1–4 below (the shared renderer, the
pre-rendered route, 3D inside Frames, and the sheet without the picker); Phase 2 covers Part 5 and the
picker.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where must 3D play | Standalone **and** inside Frames, equally | Julien, 2026-09-23 |
| What scenes | A real mix of light, product and heavily styled | Julien, 2026-09-23 |
| Route | **Both**, picked per export with an override | Neither route serves the whole mix |
| Order | **Pre-rendered first**, live second | Pre-rendered alone covers both targets and every scene |
| Pre-rendered size | The scene's own Output size (default 1024²), with a **2× Sharp** option | Julien |
| Pre-rendered frame rate | 30 fps, 24 as an option | Julien |
| Picker rule | Pre-rendered for cinematic, any treatment, any animated modifier, or a live file over **8 MB**; otherwise Live | Julien; those are the features heavy per frame or not possible live |
| 3D inside a Frame | Rendered into a clip **at the size the layer is drawn at**, like image clips | Julien; keeps Frame files small |
| Cinematic | Not saved with the scene (it is an editor view mode), so offered as an **export option** that forces pre-rendered | It is `ref(false)` in the editor, not a doc field |
| Why not a video file | Rejected: an embed must jump to any moment synchronously | `setTime` is synchronous by contract; cloner Phase needs several moments of one scene at once |

## What the code says (found while scoping — verified 2026-09-23)

The embed contract (`frontend/app/lib/embed/contract.ts:11-28`):

```ts
interface EmbedSurface {
  readonly kind: string
  readonly caps: { alpha: boolean }
  mount(container: HTMLElement, config: unknown): Promise<EmbedHandle>  // all async work, once
}
interface EmbedHandle {
  setTime(t01: number): void   // synchronous — no awaits
  setSize(w: number, h: number): void
  destroy(): void
}
```

- The adapter owns its canvas and appends it to `container`; the runtime, the poster bake and video
  recording all find it with `container.querySelector('canvas')` (`bundle.ts:291`, `export.ts:47`,
  `engine/recordEmbed.ts:39`). Recording calls `setTime` then `drawImage` in the same turn, in a
  container that is never attached to the document — so `setTime` must leave the frame's pixels on
  the canvas before it returns, and an adapter must not depend on the container's measured size.
- The runtime passes **device pixels** to `setSize` (`bundle.ts:234-253`, `dpr = min(2, devicePixelRatio)`).
- Adapters are registered in `lib/embed/surfaces.ts:9-14`; bundles are built one per surface by
  `scripts/build-embed.mjs` (list at `:51`, `:79-89`) through `vite.embed.config.ts`. The
  build-output test's `ceilingFor()` **throws on a bundle name it does not know**
  (`tests/unit/embed-build-output.unit.spec.ts:103-120`).
- Every export is scanned for external references and refused if any are found (`bundle.ts:84-126`,
  `export.ts:114-120`); `tests/embed-network.spec.ts` and `tests/frame-embed-network.spec.ts` record
  real network traffic in a browser.
- Stage 1 built an asset seam: `lib/compositor/assetScope.ts:17-41` —
  `registerAssetResolver` / `resolveAssetUrl(kind, key, fallback)`. Only the Frame adapter registers
  one; with none registered, every URL is unchanged.
- Frame clips keep each frame as a compressed image and let the browser decode it at draw time
  (`useCompositorLayers.ts:1178` `_clipCache` of `HTMLImageElement[]`). `drawImage` is synchronous,
  and memory is left to the browser — the pattern the pre-rendered player reuses.
- 3D Studio has **no** web-export entry point (`Scene3DStudioSurface.vue:5923-5929`).

The 3D engine:

- `renderMotionFrame(engine, doc, t01)` is synchronous (`lib/scene3d/motion/render.ts:56`). But
  `syncFromDoc` (`engine.ts:1102`) only **starts** asset loads and renders placeholders meanwhile
  (an empty group for a model, a 0.3 box for text or a mesh, the built-in room for an HDRI, bare
  materials for textures). **Only decals can be waited for** — `settleAsyncAssets` awaits
  `pendingDecals` alone (`engine.ts:1685-1689`).
- The engine imports no Vue, Nuxt or Pinia; its network reach is in `glb.ts`, `hdriLoader.ts`,
  `outlines.ts`, `materials.ts`, `textures.ts`, `decals.ts` (which injects a Google Fonts `<link>`),
  `data/google-fonts.ts`, and `lib/shaderfill/field.ts` (which already goes through the asset seam).
- `renderMotionFrame` **never hides the floor grid** (visible for the default `shadow` floor and for
  `reflection`, `floor.ts:18-19`); the still bake `renderPasses` does (`passes.ts:175`). **Restyle** is
  loaded only by the editor surface (`Scene3DStudioSurface.vue:2116`, `2268-2281`) and never reaches
  `renderMotionFrame`. Video export (`bakeSceneVideo`, `Scene3DStudioSurface.vue:553-620`) and the
  Frame's 3D source (`makeScene3DFrameSource`, `Scene3DStudioNode.vue:124-148`) both go through it.
  *(Grid and restyle findings are from reading the code; confirm by eye in the plan's first task.)*
- `sceneHasMotion` (`render.ts:13-20`) **ignores `doc.motion.tracks`**: a tracks-only scene gets a
  loop length of 0 and exports as a still.
- The engine sets `setPixelRatio(min(devicePixelRatio, 2))` (`engine.ts:727`); `renderPasses` forces
  1 during a bake.
- Film grain is frozen: `renderMotionFrame` calls `engine.render()` with elapsed 0 (`engine.ts:1753-1757`).
- `applyMotionToDoc` copies the whole document every frame (`motion/apply.ts:65`) — fine offline,
  too slow for live playback of a scene with large inline meshes.
- Cinematic (the path tracer, `lib/scene3d/pathtrace/`) is only ever switched on by the editor
  (`Scene3DStudioSurface.vue:667`, `682`).
- Assets a scene can pull in: models (`GLTFLoader`, 50 MB cap, no DRACO/KTX2 decoder, generated
  models stored as fal CDN links that expire), HDRIs (2k `.hdr` via `/api/scene3d/hdri/<slug>`,
  5–15 MB), text fonts, SVG paths (inline), sculpted meshes (inline, compressed), image / relief /
  ambientCG textures (via `/view`), decals (image or text), restyle results, shader-fill effects.

## Part 1 — The shared export renderer

`frontend/app/lib/scene3d/exportRender.ts`. Used by both routes, by 3D Studio's video export and by the
Frame's 3D source.

```ts
interface ExportIO {
  /** Loads a restyle result (and, in a live embed, is backed by the inlined copies). */
  loadRestyle(resultRef: string): Promise<CanvasImageSource>
}
interface AssetFailure { kind: 'model'|'font'|'mesh'|'hdri'|'texture'|'decal'|'restyle'; name: string; reason: string }

function prepareExportEngine(doc: SceneDoc, opts: { width: number; height: number; io: ExportIO }):
  Promise<{ engine: SceneEngine; failures: AssetFailure[] }>
function renderExportFrame(engine: SceneEngine, doc: SceneDoc, t01: number): HTMLCanvasElement
function sceneLoop(doc: SceneDoc): { animated: boolean; duration: number; fps: number }
```

- **`prepareExportEngine`** creates a fresh engine, sets pixel ratio 1 and the export size, turns on
  an **export mode** that hides the grid, light markers and any editor gizmo, runs `syncFromDoc`, and
  then waits for **every** asset. Engine change: every loader records its promise in one
  `pendingAssets` set, and a new `settleAllAssets()` loops until the set is empty (a model can start
  more loads). Recording promises changes nothing in the editor. A load that fails is returned as a
  named `AssetFailure` — never drawn as a placeholder. Restyle results come in through `io` and are
  pushed with `setRestyleTextures`.
- **`renderExportFrame`** applies motion at `t01`, renders with elapsed = `t01 × duration` (film grain
  moves), and returns the engine's canvas. Synchronous.
- **`sceneLoop`** is the one answer to "how long is this loop": it counts keyframe tracks as motion,
  which fixes the tracks-only-is-a-still bug for every caller.
- **Migration in the same slice:** `bakeSceneVideo` and `makeScene3DFrameSource` switch to these
  functions, so video exports and Frame previews stop drawing the grid and start showing restyle.

## Part 2 — Phase 1: the pre-rendered route

**The bake** — `frontend/app/lib/scene3d/bakeFrames.ts`:

```ts
function bakeSceneFrames(doc: SceneDoc, opts: {
  width: number; height: number; fps: 24 | 30; transparent: boolean
  cinematic?: { samples: number }
  io: ExportIO; onProgress?: (done: number, total: number) => void; signal?: AbortSignal
}): Promise<{ frames: string[]; fps: number; duration: number; width: number; height: number; failures: AssetFailure[] }>
```

- Frame count = `max(1, round(duration × fps))`; a scene that isn't animated is one frame.
- Each frame is `renderExportFrame` at `i / count`, encoded with `canvas.toBlob('image/webp', q)` —
  keeping alpha when the background is transparent — and stored as a `data:` URI.
- **Cinematic:** each frame's path-trace is reset, accumulated to `samples`, then encoded. This is slow;
  the sheet shows progress, allows cancelling, and shows `cinematicScopeWarning(doc)`.
- A named failure stops the bake before any frame is encoded.

**The player** — `frontend/app/lib/embed/surfaces/frames.ts`, kind `frames`, `caps.alpha: true`.
Generic: it knows nothing about 3D, so any studio can use it later.

```ts
interface FramesEmbedConfig { frames: string[]; fps: number; width: number; height: number }
```

- `mount` loads every frame as an `HTMLImageElement` from its data URI (the browser decodes on draw
  and manages memory, as Frame clips do), creates its canvas, and draws frame 0.
- `setTime(t01)` draws frame `min(count − 1, floor(t01 × count))` with `drawImage` — synchronous, so
  the poster bake and recording always get the exact frame.
- `setSize(w, h)` resizes the canvas to the device pixels it is given and redraws the current frame,
  fitted.
- `destroy` removes the canvas and drops the images.
- Its bundle carries no 3D code; it gets its own entry, build-list line and size ceiling.

**Standalone export** — 3D Studio's footer gains **Export embed…**, opening the sheet (Part 4). Phase 1's
sheet offers Pre-rendered only. The output is one HTML file through the existing `exportEmbedHtml`,
with the poster baked through the `frames` player.

## Part 3 — Phase 1: 3D inside a Frame export

Today a wired 3D scene in a Frame export becomes a still (stage 1: "freeze and say so where there is
no adapter"). Phase 1 makes an **animated** wired 3D layer play:

- The Frame export's gatherer (`lib/embed/frame/gather.ts`) renders the layer's scene through the
  Frame's 3D source — now on the export renderer — at `sceneLoop(doc).fps`, at the **size the layer is
  drawn at** (the same drawn-size rule stage 1 already applies to image clips), into WebP frames.
- In the snapshot the wired layer becomes a local image layer carrying a synthetic `ImageClip`, and its
  frames are stored as `clipFrame` assets. The Frame painter then plays it through the path every
  image clip already takes — including cloner Phase, which needs several moments of one clip at once.
- The Frame sheet lists it under **Plays live** ("3D scene · pre-rendered · 120 frames").
- A still 3D scene is unchanged: it is inlined as an image.
- *Verify at plan time:* exactly how the gatherer converts a wired layer today, and how the snapshot's
  loop length accounts for a clip (stage-1 spec, line 175).

## Part 4 — The sheet, and the picker (Phase 2)

`Scene3DWebExportSheet.vue`, modelled on `FrameWebExportSheet.vue`:

- The route and the reason for it, with an override (Phase 2).
- Pre-rendered options: **Size** (Output · 2× Sharp), **Frame rate** (30 · 24), **Cinematic**.
- The file size before download; the fonts going in, by name; anything that can't export and why
  (a failed asset, by name); a **Transparent background** toggle; **Copy embed code**
  (`embedSnippet`); **Download**.

**The picker** (Phase 2) — `frontend/app/lib/scene3d/embedRoute.ts`:

```ts
function pickSceneRoute(doc: SceneDoc, liveBytes: number, opts: { cinematic: boolean }):
  { route: 'live' | 'frames'; reasons: string[] }
```

Pre-rendered when cinematic is chosen, when any object has a treatment, when any modifier dial is
animated, or when `liveBytes > 8 MB`. Otherwise Live. The reasons are written for the sheet, in plain
words ("uses a treatment — heavy to draw live").

## Part 5 — Phase 2: the live route

**The player** — `frontend/app/lib/embed/surfaces/scene3d.ts`, kind `scene3d`, `caps.alpha: true`.

```ts
interface Scene3DEmbedConfig { doc: SceneDoc; assets: Record<string, string>; shaderEffects?: unknown[]; width: number; height: number }
```

- `mount` registers an asset resolver so every loader's URL comes from `assets` (data URIs), adds the
  shader effects the scene uses to the catalog, runs `prepareExportEngine`, and appends the canvas.
  A failure rejects the mount; the page keeps its poster.
- `setTime` → `renderExportFrame`. `setSize` → the engine at pixel ratio 1 and the given device pixels.
  `destroy` → dispose the engine and force the context loss.
- **Engine changes for live:** the scene3d loaders route their URLs through `resolveAssetUrl` with new
  asset kinds (a no-op in the app); text decals and text primitives load their font from the resolver
  instead of injecting a Google Fonts `<link>`; `applyMotionToDoc` stops copying the whole document
  every frame.
- **Gathering** (`lib/embed/scene3d/gather.ts`): at export, each asset is fetched through its current
  URL while it still works, inlined as a data URI, and fonts are subsetted with the existing
  `/sailor/font_subset`. `liveBytes` = bundle + assets, fed to the picker.
- **Build:** a `scene3d` entry, build-list line and size ceiling (expected ~1.2 MB — measure). The
  engine's literal server paths must not trip the export scan: route them through stand-in aliases in
  the embed build, as stage 1 does for the Frame, or add them to the inert list — decided in the Phase
  2 plan by measuring.
- **Registering for Frames:** the `scene3d` kind is added to the registry, so Frame stage 2 (nesting)
  can mount it. Stage 2 itself is not part of this spec.

## Testing

- **Unit:** `sceneLoop` (tracks count as motion); `settleAllAssets` waits for every kind and returns
  named failures; the `frames` player picks the right frame for each t, including 0, 1 and the last
  frame; the bake's frame count and alpha; `pickSceneRoute` for each rule; the gatherer's byte count.
- **Browser (Playwright, following the existing embed specs):**
  - zero network for a `frames` export and a `scene3d` export;
  - **parity** — a pre-rendered frame and a live frame, each against the editor's render at the same
    t, within a pixel tolerance; mutations that must fail (wrong t, grid shown);
  - the embed contract for both players, including `recordEmbed`;
  - a Frame export with an animated wired 3D layer actually changes between two times, and a cloned
    copy with Phase shows a different frame;
  - a scene whose model link is dead produces a named failure, not a placeholder box.
- **Build:** both bundles registered with ceilings; `externalRefs` clean on both.

## Out of scope

- Frame stage 2 (nesting live children) — its own plan; this spec only registers the live player.
- Publish (a pasteable link) — the third sibling spec.
- Shrinking HDRIs or compressing models (DRACO/KTX2) for the live route: an HDRI scene is heavy
  enough to go pre-rendered, which serves product shots well.
- Cinematic in the live route; orbit or other interaction in the embed.
- Per-studio size budgets that block an export: the sheet shows the size, as the other studios do.

## Open questions (answered by measurement during the plans)

- The live bundle's size, and whether the engine's literal server paths are best aliased or allowlisted.
- Cinematic bake time per frame at a useful sample count.
- The WebP quality that keeps a 4-second 1024² loop near the 3–10 MB estimate.
- For Frame stage 2: whether `drawImage` of the 3D player's WebGL canvas in the same tick as its
  synchronous render reads fresh pixels (the parent spec's open question — only matters for live nesting).
