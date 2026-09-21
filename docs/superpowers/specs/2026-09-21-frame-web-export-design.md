# Frame Web Export — Design

*2026-09-21 · Builds on: [Web Embed Export](2026-07-28-web-embed-export-design.md) ·
Parallel: Frame responsive constraints (own session, own spec)*

## In plain terms

**What this is.** A Frame can already be saved as a picture or a video. This adds a third way out: a
small web file that *plays* the Frame live in a browser — sharp at any size, transparent if you want,
and far lighter than a video. Shader, Gradient and Space Type studios already export this way. Frame
does not, and Frame is where pieces actually get put together.

**What changes for you.** A "Web export" button sits in the Frame editor's footer, next to "Generate as
video" and "Generate as image". It opens a short sheet that tells you, before anything downloads: how
big the file is, which fonts are going inside it, what will play live, and what (if anything) will be
held as a still. Then you download one file.

**What plays.** Everything the Frame itself does: moves, letter behaviours, transitions, shader fills,
effects, image clips. Pieces wired in from other studios play live too, whenever that studio has a web
version (Shader, Gradient, Space Type today; 3D Studio next). A wired piece whose studio has no web
version yet is held as a still, and the sheet says so by name. Nothing is ever dropped quietly.

**What it looks like in a different-shaped box.** The Frame scales to fit and its background stretches
to the edges, so there are no empty bands. Or you can choose Fill, which covers the box and crops the
sides. Proper "re-arrange itself for a phone" behaviour is a separate project, already under way in its
own session.

**What is risky.**
- *Size.* Fonts, images and clips travel inside the file. The sheet always shows the real number first.
- *Fonts go public.* An uploaded commercial font ends up inside a file on the open web. The sheet lists
  every font by name so that is a choice, not an accident.
- *One known technical hazard* when a live wired piece is drawn into the Frame (stale pixels). It has
  its own test, and the work is staged so the first stage ships even if that hazard turns out to be real.

**What comes right after.** Two sibling projects, each with its own design: a web version of 3D Studio
(so animated 3D plays inside exported Frames), and **Publish** — a link you can paste into Webflow,
Framer or Notion instead of handling a file. Publish is what makes this genuinely easy for a designer;
the download is the honest first step.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Purpose | Moving poster: autoplay loop, frozen snapshot, one file | Same promise as the three existing exports; reuses the real renderer, so export matches studio |
| Renderer | Ship `paintLayerStack` as-is; swap its supply lines in the embed build only | Smallest change to the most-edited file in the repo; app behaviour cannot regress |
| Wired layers | **Nest where the source studio has an embed adapter, freeze-and-say-so where it does not** | Registry-driven: every new adapter upgrades Frame exports for free |
| Wired stills | Inline as an image | Costs bytes only; for a still 3D scene this is also the best possible quality |
| Image clips | **Play.** Re-encoded as WebP-with-alpha frames at drawn size | Frames stay individually addressable, so cloner phase offsets, clip speed and later scrubbing all work |
| Fonts | Inline subsetted fonts, **named in the sheet** | Exact rendering; letter behaviours need real glyphs at runtime; licence exposure is visible |
| Responsive (v1) | Fit-and-bleed, plus Fill; snapshot holds a *list* of variants (one entry today) | Cheap now; leaves the door open for variants and for the constraint model |
| Bundles | Two: `frame-lean`, `frame-full` (adds fontkit + paper) | Picked per document by a flag the snapshot walk sets |
| Entry point | Compositor modal footer only | The modal is the only host that plays motion, so it is the parity reference. The card's single Download button would need a menu — separate job |
| Delivery (v1) | Download + "Copy embed code" | Works today with no hosting. Publish follows as its own spec |
| Snapshot / runtime | **Must stay separable** in the assembled file | Publish and a script-tag embed later serve the same two pieces as cacheable files |

## What exists today (verified 2026-09-21)

- "Frame" is the Compositor in code. There is no single document type: the document is a bag of
  `sailor_*` keys on a node's `data.properties`, read through
  `frontend/app/composables/useLocalLayerEditor.ts`.
- One function draws everything:
  `paintLayerStack(ctx, W, H, items, localLayers, skip, t, motion, wiredTreatments, background, groups, post, bake)`
  at `frontend/app/composables/useCompositorLayers.ts` (~line 5517). Canvas2D, with offscreen WebGL for
  shader fills, depth-of-field, and the Pixels/Assemble transitions.
- Its import cone — 128 files, ~48k lines, plus `fontkit` and `paper` — contains **no Vue and no Nuxt**.
- It is not self-contained. At draw time it reads: images by ComfyUI `/view?` URL; fonts by CSS family
  name (injected by host composables); shader source from a catalog fetched elsewhere; and wired layers
  through a host-registered provider (`withWiredContent`).
- There is no headless render path outside the components. Every export entry point lives in
  `CompositorModal.vue` or `ArtifactFrameNode.vue`.
- The Frame **card** deliberately never passes `motion` to the painter; only the **modal** plays moves
  and letter behaviours.
- Patterns, templates and the grid are authoring-time only and never reach the painter.
- The embed system: contract in `frontend/app/lib/embed/contract.ts`
  (`mount` / `setTime(t01)` synchronous / `setSize` / `destroy`), HTML assembly in `bundle.ts`, a
  network scan (`externalRefs`) that runs on **every** export, prebuilt IIFE bundles from
  `frontend/vite.embed.config.ts`.

## User experience

### The sheet

Opened by **Web export** in the modal footer. While the snapshot is being built (about a second) it
shows "Working out what goes in the file…" with Download disabled — never a guessed number that then
changes.

Left column:
- A small preview box with the Frame inside it, and a **Fit / Fill** choice.
  - *Fit:* "Whole Frame stays visible. The background stretches to the edges of the box."
  - *Fill:* "Frame covers the whole box. The edges get cropped." Crop is centred; no focal-point picker in v1.
- **Transparent background** — enabled only when the Frame's background is actually empty; otherwise
  disabled with "This Frame has a background".

Right column, each group shown only when it has entries:
- **Fonts going into the file** — family and origin ("uploaded", "Google", "library").
- **Plays live** — the Frame's own motion, each nested wired piece, each image clip with its weight
  ("Image clip · adds 3.2 MB"). A seam warning appears here when it applies: "Space Type loops every 3s,
  the Frame every 4s — it restarts at the seam."
- **Will be a still** — each frozen layer with the reason in plain words
  ("3D scene layer · no web version of 3D Studio yet").
- **Left out** — e.g. "Depth blur · needs a depth map" when none is cached.

Header: "One file · plays anywhere · 1.4 MB". Footer: Cancel, Download. Below the lists, one quiet line:
"Upload this file to your site, then embed it" with **Copy embed code** (an iframe snippet with the right
aspect ratio).

Other states:
- *Nothing moves:* one line replaces the lists — "This Frame doesn't move. The export will be a single
  sharp image that scales to any size."
- *Cannot export:* a font file cannot be fetched, an image is missing, a generated mesh link has
  expired. The sheet names the layer and keeps Download disabled. It never ships a wrong picture.
- *Too heavy:* above the clip memory ceiling the sheet offers "Export this clip as a still instead"
  rather than refusing the whole file.
- *After download:* the sheet closes; the footer's existing status slot reads "Downloaded · 1.4 MB".

All copy is sentence case and names no internal identifiers.

### Time

- Loop length = the Frame's own motion duration when it has motion; otherwise the longest nested loop
  (the existing `deriveMasterClock` rule).
- Each nested piece and each clip loops on its own length inside that, via the existing
  `slotPhase01(masterTimeSec, slotDuration)` in `frontend/app/lib/compositor/masterClock.ts`.
- A nested loop that does not divide evenly into the Frame's loop jumps at the wrap. This is **stated in
  the sheet**, not hidden behind an internal elapsed-time counter — a counter would break scrubbing once
  scroll drives `setTime`.

### Fit and bleed

- The background is painted **once**, across the whole box; then the layers are painted over it under a
  scale-and-offset transform. One paint, so there is no seam at the artboard edge for a gradient or
  shader background. Backdrop effects (glass, backdrop shader, displacement lens) read the bled
  background, which is the correct result.
- Consequence: at the artboard's own shape the export is pixel-identical to the studio, and parity tests
  run there. At other shapes a gradient or shader background spans the wider box and is *not* expected
  to match.
- The painter already handles being scaled (full-resolution export does it). Being **offset** as well is
  untested for the backdrop-reading effects and gets its own test.

## Architecture

### `FrameSnapshot` — `frontend/app/lib/embed/frameSnapshot.ts`

Plain JSON, built once at export time by a pure walk over the Frame's properties plus the resolved
wired sources.

```ts
interface FrameSnapshot {
  version: 1
  fit: 'fit' | 'fill'
  duration: number
  variants: FrameVariant[]        // v1 always writes exactly one
  assets: FrameAssetTable         // shared by all variants
  wired: Record<number, WiredEntry>   // by slot
  notices: FrameNotice[]          // the sheet's sentences
  needsOutlines: boolean          // picks frame-lean vs frame-full
}

interface FrameVariant {
  width: number; height: number
  layers: LocalLayer[]; stackOrder: StackKey[]; groups: LayerGroup[]
  background: Paint | null; post: PostEffect[]
  motion: FrameMotion | null; wiredTreatments: Record<StackKey, WiredTreatment>
}

type WiredEntry =
  | { kind: 'still'; assetRef: string }
  | { kind: 'child'; surface: string; bundle: string; config: unknown; duration: number }

interface FrameNotice {
  group: 'fonts' | 'live' | 'still' | 'leftOut' | 'blocked'
  text: string          // plain sentence, ready to show
  layerId?: string
  bytes?: number
}
```

- **Assets are keyed by the reference the painter already uses** (the image filename, the clip folder +
  index, the shader texture file, the font token, the effect id). Layers are not rewritten, so the
  snapshot's layers are the studio's layers.
- **The walk that collects assets is the walk that produces notices.** The sheet renders `notices`
  directly, so it cannot disagree with the file.
- `variants` is a list so that art-directed variants, or the constraint model's `resolveLayout`, can
  arrive later without changing the format.

Asset policy:
- *Images:* downscaled to at most 2× the size they are drawn at; PNG kept where there is transparency.
- *Image clips:* each frame resized to at most 2× drawn size and encoded as WebP with alpha. The painter
  keeps loading clip frames by URL through its own clip cache, unchanged; `mount` warms that cache by
  requesting every frame and waiting for all of them before the first paint, so `setTime` never meets an
  undecoded frame. A per-clip decoded-memory ceiling gates the "export as a still instead" offer. The
  expected size (a few MB per clip) and the ceiling are estimates and **must be measured on a real clip
  before numbers are written into the plan**. The painter's clip cache is capped and swept today; the
  adapter must make sure a clip the Frame is showing is never evicted mid-loop.
- *Fonts:* subsetted through the existing `/sailor/font_subset` route. The subset always keeps basic
  Latin, which covers the letters, numbers and symbols pools that Decode and Slot substitute from
  (`frontend/app/lib/motionx/text/charsets.ts`). The `'text'` pool draws only from the layer's own
  characters. A glyph-coverage test pins this, because a missing glyph shows as a silently wrong
  character.
- *Shaders:* GLSL source for only the effects this Frame uses, plus their textures. The
  Pixels/Assemble transitions need `ascii_dither` / `bayer_dither` included when used.
- *Depth maps:* inlined when already cached; otherwise depth blur is left out with a notice. Export
  never calls the depth-estimate route.

### Supply-line stand-ins

The painter reaches outside itself in six places. In the **embed build only**, a Vite alias replaces
each module with a stand-in that reads `FrameSnapshot.assets`:

| Supply line | App module | Stand-in returns |
|---|---|---|
| Image URL | `imageLayerUrl` in `useCompositorLayers.ts` | data URL from the asset table |
| Clip frame URL | `clipFrameUrl` in `lib/compositor/clip.ts` | data URL (WebP) from the asset table |
| Shader texture URL | `textureAssetUrl` in `lib/shaderfill/field.ts` | data URL |
| Font bytes | `lib/vectortype/font.ts` + `fontToken.ts` | bytes from the asset table |
| Shader catalog | `lib/shaderfx/catalogStore.ts` | pre-filled from the snapshot |
| Depth map | `lib/compositor/depthRegistry.ts` | cached map or "none" |

Where a supply line is a function inside a large file rather than its own module (`imageLayerUrl`), it
is first moved into a small module of its own so the alias has something to target. That is the only
edit to `useCompositorLayers.ts` this spec requires.

`frontend/app/data/variable-fonts.ts` (13 literal Google Fonts URLs, pulled in by
`lib/compositor/textOutline.ts`) is the known first offender for the network scan; it gets a stand-in
too. **Enforcement is `externalRefs`**, which already runs on every export and throws on any surviving
network reference.

### Adapter — `frontend/app/lib/embed/surfaces/frame.ts`

- `mount(container, snapshot)`: decode every image and clip frame; register fonts and await them — a
  font failure **rejects** the mount (same rule as Space Type: never draw the wrong typeface); fill the
  shader catalog; mount nested children (stage 2); create and append the canvas; paint once.
- `setTime(t01)`: one synchronous `paintLayerStack` call, inside `withWiredContent`.
- `setSize(w, h)`: recompute the fit/fill transform; pass each nested child the pixel size its layer
  actually occupies.
- `destroy()`: release bitmaps, children, canvas.
- `caps.alpha`: true only when the snapshot's background is empty.

The stack-item builder (ten lines, duplicated today in the modal and the card) becomes one shared
function in `lib/compositor/`, called by the modal, the card and the adapter.

### Bundles

`frame-lean` excludes `fontkit` and `paper`. `frame-full` includes them and is chosen when any text is
outlined or any layer uses geometry effects or booleans (`needsOutlines`). `bundleNameFor` in
`lib/embed/surfaces.ts` reads the flag — the same pattern as Space Type's per-effect bundles. Both get
size ceilings in `tests/unit/embed-build-output.unit.spec.ts`.

### Shared foundations (built in stage 1, used by every embed after)

- `fetchFontDataUrl` moves out of `SpaceTypeSurface.vue` into `lib/embed/`.
- `bundle.ts` moves from the single `__SAILOR_SURFACE__` global to a keyed registry, so several adapter
  bundles can sit in one file. Existing single-surface exports keep working.
- The assembled file keeps the snapshot and the runtime as two separable pieces.
- The notices sheet is a reusable component; the three existing studio exports can adopt it later.

### Nesting wired children (stage 2)

- New registry `frontend/app/lib/studio/embedSource.ts`, beside the existing frame-source registry.
  Shader, Gradient and Space Type each register
  `buildEmbedConfig(): Promise<{ kind, config, duration, width, height }>` — the block each studio's
  own export button already runs, moved into a function that **both** the button and the Frame call.
- Snapshot rule per wired slot: embed source + animated → `child`; still → inlined image; animated with
  no adapter, or a studio-into-studio chain → frozen still + notice.
- Each child adapter mounts into a hidden container inside the Frame's stage. A bundle is inlined once
  per kind, not once per layer.
- Each tick: every child gets `setTime(slotPhase01(...))`; then the Frame paints, reading each child's
  canvas through `withWiredContent`. Nothing awaits.
- Child fonts ride in the child's own config; the Frame's notices merge them so "Fonts going into the
  file" is complete.

## Failure handling

Inherits the existing runtime unchanged: a poster baked **through the embed adapter itself**, shown
before mount completes, under `prefers-reduced-motion`, with no WebGL2, on context loss, and on any
throw. Off-screen pause applies to the single Frame loop; children have no loop of their own.

A failing nested child fails the **whole** Frame embed to its poster. A Frame playing with one layer
missing is a plausible-looking wrong picture, which is worse than a correct still.

## Testing

Each test targets a failure this codebase has actually had.

1. **Contract conformance** — mount, tick, resize, destroy; then twice on one page. This is the proof
   that the painter's module-level state (`_fieldCtx`, `_cloneSlot`, the shared shader GL context) is
   safe when two embeds coexist.
2. **Pixel parity against the modal's render**, at the artboard's own shape. Asserts the live canvas is
   visible and the poster hidden, so an export that fell back cannot pass. Clip layers use a small
   tolerance (lossy frames); every other layer is exact.
3. **Parity with teeth** — flip a layer colour, swap a font, drop a shader source; each must fail.
4. **Zero network** — the bundle scan, plus a runtime no-requests check, on a fixture Frame that uses
   all six supply lines.
5. **Glyph coverage** — a Decode or Slot layer on the symbols pool renders pool characters in the real
   typeface.
6. **Offset** — each backdrop-reading effect (glass, backdrop shader, displacement lens, long shadow)
   under a Fit offset.
7. **Nested staleness (stage 2)** — a Space Type child compared at three different times; every frame
   must differ from the last. Direct test for the known stale-read of a WebGL canvas through
   `drawImage`. Fallback if it fails: `preserveDrawingBuffer` on child contexts.
8. **Notices are truthful** — for each freeze case the sentence exists and the exported pixels really
   are still; for each "plays live" entry the pixels really change.
9. **Existing exports unchanged** — Shader, Gradient and Space Type exports still build and pass their
   suites after the keyed-registry change.

## Staging

**Stage 1 — Frames without nesting.** The extractions and shared foundations; snapshot and stand-ins;
adapter; two bundles; the sheet with Copy embed code; fit and bleed; image clips; tests 1–6, 8, 9.
Wired stills are inlined; wired motion freezes with a notice. Shippable on its own.

**Stage 2 — Nesting.** The embed-source registry; child lifecycle; test 7. Freeze notices for Shader,
Gradient and Space Type layers disappear.

## The programme around this spec

| Project | State | Relation |
|---|---|---|
| **Frame web export** (this spec) | Designed | — |
| **3D Studio web version** | Own spec, next | Registers an adapter; animated 3D then plays inside exported Frames with no Frame work. Findings so far: `renderMotionFrame` is already synchronous; only the plain three.js renderer is ever needed (it is what video export uses today); asset weight is the real problem (2k HDRIs are 5–15 MB, meshes up to 50 MB, generated meshes point at expiring links); animated modifiers rebuild geometry on the CPU every frame; the engine's own pixel-ratio multiply must be reset to 1 |
| **Publish** | Own spec, straight after stage 1 | A pasteable link instead of a file. Needs the Fly deploy, storage, and a **separate domain** for published pieces (user-made HTML must never be served from the app's own origin). Reuses the separable snapshot + runtime |
| **Frame responsive constraints** | Own session, in progress | Designs toward a pure `resolveLayout(doc, W, H)` that plugs in at `setSize` |
| `sceneHasMotion` ignores tracks | Own session, in progress | A scene animated only by tracks is reported as a still; independent bug found while scoping |

## Explicitly not in this spec

Variants (the snapshot is ready for them); the constraint model; the Scene3D adapter; Publish and any
hosting; scroll- or pointer-driven playback; an export action on the Frame card; a focal-point picker
for Fill; bundle splitting finer than lean/full; extracting the painter into `lib/compositor/render/`
with an explicit environment object — the right long-term shape, better done later with this spec's
parity tests as the safety net.

## Open items the plan must settle by measurement, not assumption

- Real size of a WebP-encoded clip at drawn size, on one of the existing clips, and from that the
  decoded-memory ceiling.
- That `/sailor/font_subset` really keeps all of basic Latin (read from a code comment, not yet from
  the route) — test 5 depends on it.
- Built size of `frame-lean` and `frame-full`.
- Whether `drawImage` of a nested child's WebGL canvas, in the same tick as its synchronous render,
  ever reads stale (test 7).
- Whether each backdrop-reading effect is correct under an offset (test 6).
