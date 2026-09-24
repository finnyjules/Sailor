# Sailor without ComfyUI — design

Date: 2026-09-24. Status: written overnight on the user's "I'd like the divorce from comfy to be done when I wake up". The controller made the rulings below and recorded them; the user reviews them in the morning.

## In plain words

Today Sailor needs ComfyUI, the Python app, running beside it. ComfyUI does five jobs for Sailor:
1. runs every workflow the new runner doesn't know;
2. tells the canvas what nodes exist (`/object_info`);
3. stores and serves files (`/view`, `/upload/image`, the input and output folders);
4. hosts about 37 of Sailor's own server routes (`/sailor/*`: projects, assets, thumbnails, shader catalog…);
5. hosts three helper scripts.

The goal is that **Sailor boots and works with ComfyUI switched off**. Anything that still truly needs Python says so in plain words instead of breaking. ComfyUI becomes an optional add-on, needed only for nodes nobody has moved yet.

## What moves, in phases

**Phase A — Sailor owns its own server** (tonight):
- A1. Projects and spend history: served by Sailor from the same folders, in the same format.
- A2. Media library: input/output listings, deletes, the Timeline asset library, image thumbnails.
- A3. Small routes: shader catalog, Space Type defaults and thumbnails, font subsetting, LoRA caption files, motion-frame cleanup, model-bundle status.
- A4. Files: `/view` and `/upload/image` (and `/upload/mask`) served by Sailor from disk.
- A5. Node definitions: Sailor serves `/object_info`. When ComfyUI is up, Sailor passes it through and keeps a copy; when it's down, Sailor serves the last copy (or a committed baseline), with file and model lists refreshed from disk.
- A6. ComfyUI becomes optional: the app's "backend up" signal is Sailor's own. Runner workflows run with ComfyUI down. Any other workflow is refused before queueing, with the names of the nodes that need the local engine. Queue and history panels stay empty rather than erroring.

**Phase B — the runner grows** (as far as the night allows, each family behind a switch until checked live):
- B1. A Replicate client, and the remaining Generate image / Generate video models.
- B2. The Nano Banana edit family: Edit image, Develop, From references, Blend scene, Product shot, Rotate camera, Relight, Remove object, Text edit, Recolor, Swap background/product, Person swap, Restyle.

**Later** (not tonight):
- the other ~190 provider nodes, family by family;
- the ~75 local processing nodes (pixel effects, audio and video ops) ported to TypeScript/sharp;
- the 13 local-model nodes (rembg, SAM, RealESRGAN, Whisper, Demucs…), which need hosted model APIs or ONNX;
- the Timeline server render, Space Type server encode and video thumbnails and waveforms (all PyAV — browser export already replaced the renders);
- the three helper scripts;
- saving node settings by name.

## Rulings (the controller's, for the user's review)

1. **The local diffusion blueprints are not removed.** They keep working when ComfyUI runs and say "needs the local engine" when it doesn't. Removing a feature is the user's call.
2. **Same folders, same formats.** Every route Sailor takes over reads and writes the files ComfyUI used, byte-compatible, so switching back is a code revert and no data moves. Parity tests compare against the Python behaviour.
3. **No new switch for Phase A.** Because the data format is unchanged, native routes simply replace the proxy for those paths. The proxy still exists for everything else. Phase B families get switches, because they spend money and can't be checked live overnight.
4. **PyAV routes stay on ComfyUI** (server Timeline render, Space Type encode, video thumbnails, waveforms). With ComfyUI down they answer "needs the local engine", and the app falls back: browser export for renders, a placeholder for thumbnails.
5. **Hosted keeps every ownership rule.** The native handlers call the same ownership checks the proxy gate uses today (projects via `resource_owners`, per-user data via the upload and timeline-asset ledgers). The route-classification guard test stays green.
6. **No paid runs overnight.** New runner families are proven by fixtures generated from the Python builders, and stay switched off until the user approves live checks.
7. **Storage stays on local disk.** The file store goes behind one interface so R2 can drop in later; the hosting choice is the user's.

## Risks

- **Parity.** A native route that differs subtly from Python could corrupt project history. Mitigation: parity tests against the Python code's own behaviour, and the same files.
- **Snapshot drift.** The committed node-definitions copy goes stale as Python nodes change. Mitigation: the live copy refreshes whenever ComfyUI is up, and a script regenerates the baseline.
- **Size.** Phase A touches the request path of every page. Mitigation: each task is reviewed; the controller checks the app live with ComfyUI up and then down.
