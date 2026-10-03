# Attribution — `frontend/public/models/body-reference.glb`

## What this is

A baked preview mesh for Sailor's Body editor (body-reference-builder plan,
Task 4). One base body at all-phenotype defaults, plus 8 morph targets — one
per Body-editor slider (`frame`, `height`, `build`, `muscle`, `shoulders`,
`chest`, `waist`, `hips`, in that order — see
`frontend/shared/characters/types.ts` `BODY_SLIDERS`) — each holding the
position delta of that slider's mapped phenotype/local-change axis pushed to
its max, all other axes held at default. Display-only: it renders a live
preview of the slider values the user has already set via the text-based
mechanism (Tasks 2-3); it is not itself the source of truth for anything.

## Source: Anny

- Library: [Anny](https://github.com/naver/anny) v0.6.0 (pinned in
  `scripts/bake-body-model/venv`)
- Code: Copyright (c) 2025 NAVER Corp., licensed under the
  **Apache License, Version 2.0**.
- Body mesh data used here: `anny/data/mpfb2/*` — MakeHuman assets adapted
  from [MPFB2](https://github.com/makehumancommunity/mpfb2/), licensed
  **CC0 1.0 Universal** (see `anny/data/mpfb2/LICENSE.md` inside the
  installed package, and Anny's own top-level license note: "Anny relies on
  MakeHuman assets adapted from MPFB2 that are licensed under the CC0 1.0
  Universal License").

## Topology used — CC0 only, never SMPL-X

This bake instantiates:

```python
anny.Anny(topology="anny", local_changes="all")
```

`topology="anny"` resolves to `TopologyConfig(base_mesh="makehuman", ...)`
(see `anny/models/model_data.py`, `_parse_topology_spec`), which is backed
by the CC0 `data/mpfb2` assets above.

**This script never requests `topology="smplx"`/`"smpl"`.** That alternate
topology requires a separate, non-commercial-only download
(`http://download.europe.naverlabs.com/humans/Anny/noncommercial.zip`, per
Anny's own README) and is explicitly out of scope for Sailor, a commercial
product. `scripts/bake-body-model/bake.py` asserts this in a comment at the
`build_model()` call site as a standing guard for anyone touching this file
later.

## License chain summary

| Layer | License | Used here? |
|---|---|---|
| Anny code (Python/Apache-licensed inference code) | Apache-2.0 | Yes — imported, not redistributed |
| `data/mpfb2` (MakeHuman/MPFB2 body mesh + morph data) | CC0 1.0 Universal | Yes — this is the mesh baked into `body-reference.glb` |
| `data/soma` (alternate topology) | Apache-2.0 | No |
| `smplx`/`smpl` (alternate topology, non-commercial download) | Non-commercial only | **No — never requested, never downloaded** |

Because the baked mesh geometry comes from the CC0 layer, `body-reference.glb`
itself carries no commercial-use restriction from Anny's data. (Anny's own
Apache-2.0 code is not redistributed in the GLB — only its numeric output,
the mesh vertices, is baked in.)

## Bake details

- Base mesh: 13,718 vertices / 27,420 triangles (Anny's stock topology,
  undecimated — the resulting GLB came in at ~1.7 MB, comfortably under the
  5 MB budget, so no decimation was needed).
- 8 morph targets, `POSITION`-delta only, in `BODY_SLIDERS` order. Slider →
  Anny axis mapping is locked in `scripts/bake-body-model/out/slider-mapping.md`
  (Task 1 probe output); `bake.py`'s `SLIDER_TARGETS` dict mirrors it exactly.
- glTF authored directly via `pygltflib` (not trimesh's exporter — see the
  docstring in `bake.py` for why) as a single-buffer `.glb` with
  `mesh.extras.targetNames` set to the 8 slider ids.
- Verified by round-tripping the output through `pygltflib.GLTF2().load()`
  and through three.js's real `GLTFLoader.parse()` (via
  `frontend/node_modules/three`) before committing — both confirm
  `mesh.morphTargetInfluences.length === 8`.

## Bake date + exact command

Baked: 2026-08-13

```
cd scripts/bake-body-model
./venv/bin/python bake.py
```

Output: `frontend/public/models/body-reference.glb`
