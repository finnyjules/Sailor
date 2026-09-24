# Sailor without ComfyUI — Phase A implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sailor's own server answers every request the app makes of ComfyUI except running non-runner workflows, so the app boots and works with ComfyUI switched off.

**Architecture:** A new `frontend/server/native/` module holds ports of the Python `/sailor/*` handlers and of ComfyUI's `/view`, `/upload/*` and `/object_info`. They read and write the SAME folders and file formats. `server/middleware/comfyui-proxy.ts` asks one dispatcher (`nativeEngineRoute(event)`) first. In hosted mode the existing ownership gates (`server/utils/engineGate.ts`) call the native handler instead of fetching the engine. What remains proxied is `/prompt`, `/history`, `/queue`, `/interrupt`, `/ws`, `/gate/resume`, `/system_stats`, the PyAV routes and ComfyUI's own settings/userdata. Those tolerate an absent engine.

**Tech stack:** Nitro/h3 1.15.8, Node fs, `sharp` (already a dependency), `fontkit` (already a dependency), vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-09-24-engine-free-sailor-design.md` (read it; its Rulings bind every task).

**Style note:** this plan specifies each task as a behaviour contract plus the Python source to port, not as finished code. Implementers read the Python handler and its Python tests, and port both. The parity tests are the proof.

## Global constraints

- Work in the main checkout. Never `git stash`. Other sessions edit this checkout: never touch files outside your task.
- **Implementers do not commit or stage.** The controller commits with a private git index.
- Never run a dev server. The shared one on :3002 is the controller's to use.
- **Same folders, same formats.** Paths come from `resolveEngineRoot()` / `engineDirForType()` in `server/utils/inputUploads.ts` (input/, output/, temp/, user/, models/). JSON files keep the exact field names and layout the Python writes. A Python-written file must read back through the native code unchanged, and vice versa.
- **Hosted keeps every ownership rule** that `server/utils/engineGate.ts` and `enginePath.ts` enforce today. `tests/unit/sailor-routes-gate.unit.spec.ts` and the other engine-gate specs stay green.
- Server modules import explicitly (`from 'h3'`, relative paths), not through Nitro auto-imports, so vitest can load them.
- Unit tests go in `frontend/tests/unit/native-*.unit.spec.ts`. Tests write into temp folders, never the real engine folders. Point the engine root at a temp folder with `__setInputUploadsEngineRootForTests`.
- Path safety: every file name from a request goes through one shared guard (no `..`, no separators where the Python forbids them, resolved path must stay inside its root). Port the Python's own checks exactly.
- Typecheck: `npx vue-tsc --noEmit -p .nuxt/tsconfig.server.json 2>/dev/null | grep server/native` shows nothing. For app files: `-p tsconfig.json`, and don't grow the baselines (default.vue 5, VueNodeCanvas.vue 16, ComfyNode.vue 2, AssetsHistory.vue 12).
- UI copy: sentence case, plain words.
- No new npm dependencies without a written reason in the report. `sharp` and `fontkit` are already there.

## Task A1 — The native dispatcher, and projects + spend

**Port:** `comfy_extras/nodes_sailor_projects.py`, all 9 handlers at :456–:561 and the pure storage layer they use (`projects_root()` = `user/sailor/projects/`, versions, generations, the spend ledger `user/sailor_spend.jsonl`), plus its Python unit tests (find them under `tests-unit/` or `tests/`).

**Build:**
- `server/native/paths.ts`: engine-root folders and the shared safe-name guard.
- `server/native/projects.ts`: the storage port.
- `server/native/router.ts`: `nativeEngineRoute(event): Promise<unknown | undefined>`. It returns undefined for paths it doesn't own, and it is the single list of native paths.
- Wire the proxy middleware to call it before proxying, in local mode.
- In hosted mode, make `handleHostedSailor` (engineGate.ts ~:720) and its spend handling call the native storage after the ownership check, instead of fetching the engine. Keep the 404 rules exactly.
- Response shapes and status codes must be the same as the Python's, including the 409 stale-version check.
- The generation-record POST that the runner makes to `http://127.0.0.1:8188/sailor/projects/{uuid}/generations` (`server/runner/index.ts`) must call the native storage directly, not HTTP.

**Tests:** port the Python storage tests. Add a round-trip test: a project folder in the Python layout, read back and appended natively, keeps every field. Add router tests with h3 `toWebHandler` (see `tests/unit/runner-routes.unit.spec.ts`).

## Task A2 — Media library routes

**Port** from `comfy_extras/nodes_timeline.py`:
- `output_listing` :2020 and `input_listing` :2391;
- `input_file` DELETE :2438 and `output_file` DELETE :2452;
- the asset library: `assets` GET :2118, `asset_import` :2122, `assets/{id}` DELETE :2160, stored in `user/timeline_assets.json`;
- `input_thumbnail` :2247 and `asset_thumbnails` :2281, **images only**, with sharp, cached in `user/timeline_thumbs/` under the same names.

`asset_import` probes image size with sharp. For video and audio: if ComfyUI is reachable, forward the request to it. If not, record the asset without duration/size (fields null) so it still appears.

Video thumbnails and `asset_waveform`: forward to ComfyUI when reachable; otherwise answer 503 `{ error: 'This needs the local engine' }`, and make the frontend callers (`useClipPreview.ts`, `TimelineEditor.vue`) show their empty or placeholder state on a 503 instead of erroring.

Hosted: `handleHostedSailorData` / `handleHostedOutputListing` keep filtering to owned rows and 404 on misses, calling native code instead of the engine.

**Tests:** listing parity (media types, sort order, subfolder handling, the fields each item carries), delete guards, asset JSON round-trip with a Python-written file, thumbnail cache naming.

## Task A3 — The small routes

**Port:**
- `shader_effects` GET :224 and `shader_effects/assets/{name}` :231 (`nodes_shader_effects.py`): same catalog shape, same headers.
- `space_defaults` :1906, `space_default/{id}` POST :1920, `space_thumbnails` :1937, `space_thumbnail/{id}` GET/POST :1949/:1963: same folders, found via `_scene_defaults_dir()` / `_scene_thumbnails_dir()`.
- `font_subset` :1853: use fontkit's `createSubset`. It must return a font that contains every requested character, same request/response shape. If fontkit can't subset a given font (e.g. CFF/OTF), return the original font unsubsetted rather than failing. Say which in the report.
- `lora/save_captions` :117 and `lora/clear_dataset` :154 (`_lora_training.py`), with identical path guards.
- `motion/cleanup_frames` :958 (`nodes_compositor.py`), with the identical regex and keep-list guard.
- `models/status` :204 (`_model_downloads.py`): read-only disk check. `models/download` stays proxied, and answers 503 "needs the local engine" when down.

Hosted: keep today's classification (proxy / refuse) exactly. Refused routes stay refused, and the proxied ones are served natively.

**Tests:** per route, the shape and the guards. Font subset: the output font contains the requested glyphs.

## Task A4 — Files: `/view` and uploads

- `server/routes/view.get.ts` serves bytes from disk through the native paths (input/output/temp, subfolder, filename, and the same query params ComfyUI's `/view` honours that the app uses). Keep the hosted ownership gate as it is. Remove the fetch to 8188 and keep the `.cache/images` fallback only if still needed.
- `/upload/image` and `/upload/mask`: port ComfyUI's semantics from `server.py` (search `upload/image`, `image_upload`, `upload/mask`):
  - fields `image`, `type`, `subfolder`, `overwrite`;
  - on a name clash without overwrite, the name gets ` (1)`, ` (2)` and so on, exactly as ComfyUI does it;
  - response `{ name, subfolder, type }`;
  - the mask upload composites the mask into the original's alpha: use sharp and match ComfyUI's pixel rule.
- Hosted: `handleHostedUpload` keeps refusing `overwrite` and recording the upload owner, then writes natively. Respect the multipart size cap the app already uses (see memory: h3 multipart 64 MiB — check `readMultipartFormData` usage in other routes).

**Tests:** name-clash numbering, subfolders, type, path guards, mask alpha against a small fixture, and `/view` for each type.

## Task A5 — Node definitions (`/object_info`)

- Nitro answers `/object_info` (and `/object_info/{node}`, `/api/object_info`, if the app calls them).
- When ComfyUI answers within 3 s, pass its body through and save a copy to `join(storeDir('data'), 'object_info.json')`.
- When ComfyUI is down, serve the saved copy, or else the committed baseline `frontend/server/native/objectInfo.baseline.json.gz`. Write the generator script `scripts/snapshot_object_info.mjs`, which fetches from a running ComfyUI and writes the gz, and run it once while ComfyUI is up.
- In both cases, refresh the file-list combos from disk: the inputs `scrubObjectInfo` in engineGate.ts (~:124–190) knows about (input image/video/audio lists) and the model/LoRA lists from `models/*`.
- Hosted keeps `handleHostedObjectInfo`'s scrub (empty shared listings) on whichever body is served.

**Tests:** down → baseline served with refreshed lists; up → pass-through and a saved copy; hosted scrub still applied.

## Task A6 — ComfyUI becomes optional in the app

- Add `GET /api/engine/health` → `{ sailor: true, engine: 'up' | 'down' }`. It checks `127.0.0.1:8188/system_stats` with a 1.5 s timeout and caches the answer for 3 s.
- The app's `useBackendHealth.ts` uses it: the app is "up" when Sailor answers, and the engine state is a separate field.
- `canvasReady` in `layouts/default.vue` keys on Sailor, not the engine.
- In `runVueWorkflow`, when the engine is down and the workflow isn't runner-eligible, don't queue. Show a toast: "This workflow needs the local engine" with a description naming the node titles that need it — every node whose class isn't in `RUNNER_NODE_TYPES`, plus model-ineligible generators.
- The direct-execution WebSocket, the queue panel and the history fetches must not spam errors or toasts when the engine is down. Back off quietly and show empty states.
- Keep all behaviour identical when the engine is up.

**Tests:** pure helpers (which nodes need the engine; health caching) as unit tests. The controller checks the rest live.

## Task A7 — Controller verification (not delegated)

With ComfyUI up, then **stopped**:
- the app boots and a project opens and saves;
- Assets lists files;
- an upload works;
- node menus are populated;
- a runner workflow runs (use a fixed-seed request the runner already has a saved result for, so it's reused and costs nothing);
- a non-runner workflow is refused with the plain message.

Then restart ComfyUI. Record the results in the ledger and in docs/STATE.md.
