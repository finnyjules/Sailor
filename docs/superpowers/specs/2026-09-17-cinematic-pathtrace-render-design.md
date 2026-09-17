# Cinematic (path-traced) render for 3D Studio — design

Date: 2026-09-17
Author: Julien + Claude
Status: design — awaiting go-ahead to build
Follows: `2026-09-17-gemstone-material-design.md` (this is that spec's deferred Slice 6)

## Goal

A "hero shot" render mode that reaches true Octane-grade gem fidelity — the rainbow
**floor caustic** and fullest multi-bounce **fire** that the real-time raster renderer
cannot produce — WITHOUT losing the fast raster studio for everyday work.

## Agreed UX (decided with Julien, 2026-09-17)

Model **B + warn-then-render**:

1. **A `Cinematic` toggle in the viewport toolbar** (beside `snap` / `Light`), OFF by
   default so raster stays the working renderer.
2. **On enable → the viewport becomes a progressive path-tracer.** It **accumulates to a
   target sample count, then idles** (holds the clean image, stops rendering — no wasted
   GPU/battery). Any orbit / pan / edit **resets accumulation**: grain that resolves over
   ~1–3 s when the user stops. A small, unobtrusive **"refining… %" ring** in a corner that
   **fades out when converged** — never a blocking modal.
3. **Final render is WYSIWYG.** Because the viewport can already *be* cinematic, the existing
   still exports (**Download PNG**, **Render on canvas**, **As image**) simply render what the
   viewport is showing. In cinematic mode they first converge a full-quality pass at the
   OUTPUT resolution (a brief progress bar), then hand the still to the SAME destination as
   today. No separate quality dropdown — the toggle IS the quality switch.
4. **Warn-then-render on incompatible content.** The first time Cinematic is enabled on a
   scene containing things the path-tracer can't faithfully show (custom-shader materials,
   the raster treatment stack), a **one-time dismissible heads-up** appears
   ("These effects won't ray-trace — they'll render simplified"), then it renders what it
   can: path-traceable objects true, the rest as their base PBR, treatments skipped.

## Scope boundaries (deliberate)

- **Stills only.** A path-traced clip is minutes-to-hours per second, so **Export video
  stays on the raster renderer** always. The toggle does not apply to video.
- **Physical-materials mode.** The tracer understands PBR: `gemstone` / `glass` / `standard`
  render true (transmission, IOR, dispersion, attenuation → real caustics + fire). It does
  NOT run our `onBeforeCompile` materials (`gradient`, `opalescent`, `holographic`,
  `shaderFill`) or the treatment stack (`treatmentStage` / G-buffer / motion / AI-restyle) —
  those fall back to a base approximation or are ignored (covered by the warn-then-render
  notice).
- **Capability-gated.** Requires WebGL2. On a GPU where a probe render is unworkably slow, or
  WebGL2 is absent, the toggle disables with a tooltip; raster is unaffected.

## Architecture

- **Deps:** `three-gpu-pathtracer` + `three-mesh-bvh` (peer). Pinned exact versions.
- **`lib/scene3d/pathtrace/` (new):** a `PathTracer` wrapper owning the
  `WebGLPathTracer` (or `PathTracingRenderer` + BVH), separate from the raster `engine.ts`
  render path. It:
  - Builds the traced scene from the live `THREE.Scene`: keeps meshes whose material is a
    plain `MeshPhysicalMaterial`/`MeshStandardMaterial` (our physical + gemstone path);
    swaps any custom-shader material for a base `MeshStandardMaterial` snapshot (colour/
    roughness/metalness) so the object still occludes/reflects sanely; skips treatment shells
    and the treatment stage entirely.
  - Feeds lighting from an **equirectangular** env: render the existing procedural env scene
    (`environments.ts`) — including the new `studio` — to an equirect RT once per env change
    and hand it to the tracer as its environment map (the tracer wants equirect, not the
    PMREM cube the raster path uses).
  - Progressively accumulates; exposes `reset()`, `renderFrame()`, `samples`, `targetSamples`,
    and a `converged` flag.
- **Render-loop seam (`engine.ts` render):** when `doc.render?.cinematic` is on, route to the
  `PathTracer` instead of `renderWithPost`; reset accumulation on any camera/scene change
  (reuse the existing dirty signals). Bloom/tonemap: apply the shared post **grade/bloom** as
  a cheap 2D pass over the converged HDR result (OutputPass-equivalent), so the look matches
  the raster preview's post. Gizmos draw raster, un-accumulated, ON TOP of the converged frame
  (like the current gizmo overlay), only while idle.
- **Final bake:** the existing `bake()` still path, in cinematic mode, drives the `PathTracer`
  at output resolution to `targetSamples` (or a time budget), reads the pixels, and returns
  them through the same download / canvas / Frame-layer plumbing.
- **State:** one new doc field `render.cinematic` (boolean, default false) + maybe
  `render.samples` (target, default ~256) behind an advanced disclosure — otherwise no new
  controls (defaults-over-controls).

## UX details

- Toggle label **Cinematic**; a small ray/diamond icon. Sentence-case tooltip.
- The "refining" indicator: a thin radial progress in a viewport corner + "Refining…" that
  disappears at convergence; shows "Ray-traced" quietly when idle-converged.
- The warn-then-render heads-up is a one-time toast/inline note per session (not a modal that
  blocks); dismiss persists for the session.
- Motion authoring stays in the Motion tab; Cinematic never appears there (video is raster).

## Testing / verification

- Path tracing is stochastic → **no pixel-exact tests.** Test the PLUMBING deterministically:
  the traced-scene BUILDER (which meshes kept vs base-swapped vs skipped, given a scene of
  mixed materials + treatments), the env→equirect conversion runs, the capability probe, and
  the `render.cinematic` doc round-trip + control gating.
- Live GPU verification in `/dev/scene3d-lab` (the same `__scene3dBeauty` capture): a
  gemstone diamond converges to a caustic-bearing still; toggling off returns to raster
  byte-for-byte (raster path untouched when `cinematic` is false — the byte-identity gate).
- A visual smoke: diamond on floor, Cinematic on, confirm a rainbow caustic pools on the
  floor (the feature's whole point).

## Risks / open questions

- **Env fidelity:** equirect conversion of the procedural env must match the raster look
  closely, or Cinematic vs raster diverge confusingly. Mitigate: convert the SAME env scene.
- **Dispersion in the tracer:** confirm `three-gpu-pathtracer` honours `material.dispersion`
  (it supports IOR + a dispersion term in recent versions); if not, drive it from IOR.
- **Bundle size / lazy-load:** the tracer is heavy — lazy-import it only when Cinematic is
  first enabled, so it never costs the raster studio.
- **Perf on export:** a 2K still at 256 spp can take many seconds; the progress bar + Cancel
  must be honest, and a time-budget cap should exist.
- Shared checkout / private-index committing as before; `three-gpu-pathtracer` addition to
  `package.json` is one line but must not disturb a parallel session's lockfile work.
