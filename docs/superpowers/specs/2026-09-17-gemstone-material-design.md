# Gemstone look for 3D Studio — design

Date: 2026-09-17
Author: Julien + Claude
Status: approved (build)

## Goal

Make the 3D Studio able to render **precious stones** that read as "between an
Octane product render and a macro photo of a real gemstone" — the reference
Julien picked is a brilliant-cut diamond on black: razor-crisp facets, star-glint
bloom, rainbow fire, a caustic on the floor.

Plus an explicit second ask: **a modifier that adds more facets** to geometry.

## What we already proved (throwaway spikes, this session)

Three real-time levers, rendered live in `/dev/scene3d-lab`, take the gem from
"PS1 blob" to a convincing sparkling brilliant — with **zero** path-tracing:

1. **A real HDRI environment** — rich reflections + fire instead of plastic.
2. **Brilliant-cut geometry** — a convex hull of *structured* table/crown/girdle/
   pavilion/culet vertex rings reads as a genuine cut (vs the current random hull).
3. **Bloom** — scene3d's existing `PostChain` already has bloom; tuned tight it
   gives the sparkle glint. (Chromatic aberration at high amount looks like an
   RGB-split, not fire — keep it off / very low.)

Honest ceiling: raster three.js reaches ~85% of the reference. The **rainbow
floor caustic** and fullest multi-bounce fire are genuinely path-traced features
(deferred to the optional hero-export slice).

## Non-goals

- True spectral caustics / path tracing in the interactive renderer (that is the
  later, optional `three-gpu-pathtracer` hero-export slice, out of scope here).
- Opaque stones (jade/turquoise) — a separate future effort (needs subsurface).

## Current-state facts (verified in code)

- `lib/scene3d/gem.ts`: `gemGeometry(points, spread, depth, seed)` builds a
  `ConvexGeometry` over a **random** point cloud (`gemPoints`, capped 64). The gem
  primitive already exposes a `points` param labelled **"Facets"** (4–40).
- Materials (`config.ts` `MATERIAL_TYPES`): `standard phong toon matcap glass
  fresnel gradient opalescent holographic image shaderFill`. `glass` is a
  `MeshPhysicalMaterial` with `transmission/ior/thickness/dispersion/iridescence/
  clearcoat`. Coloured transmission today **greys out** — base `color` does not
  tint transmitted light; only `attenuationColor` over `attenuationDistance` does,
  and it barely accumulates on a small thin stone.
- Environments (`environments.ts`): procedural only — `room` (three's
  RoomEnvironment), `darkStrips` (black void + bright HDR bars, built for gem
  dispersion), `softbox`, `colorGels`. **No HDRI loading.**
- Post (`spacetype/post.ts` `PostChain`, used by scene3d): has bloom
  (`bloom/bloomStrength/bloomRadius/bloomThreshold`), chroma, grade, bokeh blur.
  **No SMAA** in the composite path (renderer `antialias:true` only helps the
  direct-render path, lost through the composer).
- Modifier stack (`modifierStack.ts` / `modifiers.ts`): ordered, duplicable rows;
  `subdivide` pinned first, `cloner` pinned last, a reorderable middle of
  DEFORM_KINDS + PRODUCER_KINDS. Adding a kind touches: `MODIFIER_KINDS`,
  `MODIFIER_KIND_PARAMS`, `MODIFIER_LABELS`, region map, defaults/params,
  `DEFORM_KINDS`/`PRODUCER_KINDS`, `applyMiddleRow`, and `modifierControls.ts`.
  **Byte-identity contract**: an absent/disabled modifier must return the input
  geometry untouched (vertex-buffer oracle in tests).

## Slices

Ordered by impact; each independently verifiable in `/dev/scene3d-lab` via the
`__scene3dBeauty()` hook (write PNG through `/api/dev-scratch`, then look).

### Slice 1 — Real cut geometry for the gem  (biggest lever; also serves "more facets")

Replace the random hull with **parametric jewellery cuts**, back-compatible with
the existing gem params.

- New gem param `cut` (options): `brilliant` (round), `emerald` (step), `cushion`,
  `marquise`, `cabochon`, and `raw` (= today's random hull, the default so existing
  scenes are byte-identical).
- New gem param `facetDensity` (or reuse/relabel `points`): drives ring counts /
  segment counts of the cut → literally "more facets". Keep `spread`/`depth`/
  `gemSeed` meaningful where they apply (`raw` unchanged; cuts use `depth` for
  crown/pavilion depth, `spread` for table size).
- Implementation: each cut is a function returning structured vertex rings; feed
  through the existing `ConvexGeometry` path (a brilliant/step/cushion is convex;
  cabochon is a convex dome). `raw` keeps calling `gemPoints`. Flat-facet shading
  is already the gem's variant.
- Back-compat: `cut` absent ⇒ `raw` ⇒ identical output to today (guards the
  existing gem look and any saved scenes).

### Slice 2 — Facet modifier  (the explicit ask; works on ANY object)

A new **producer** modifier `facet` that adds facets to any geometry by re-cutting
it as a convex hull over an up-sampled point set.

- Params: `facetCount` (target points/facets, e.g. 8–400), `facetJitter`
  (0 = clean cut, 1 = irregular/raw-crystal), `facetSeed`.
- Behaviour: sample the input mesh's vertices (+ optional surface/midpoint points),
  jitter by `facetJitter`, rebuild via `ConvexGeometry` → controllable facet
  density. It **gemifies** (convex-hulls) the shape — documented and intended:
  "turn anything into a faceted gem / add facets." Named clearly ("Facets").
- Registration: producer kind (returns NEW geometry); add to `PRODUCER_KINDS`, the
  kinds array, labels, params, defaults, `applyMiddleRow`, control rows. Re-check
  the add-menu fits at ~640px viewport (per studio-add-menus-overflow memory).
- Byte-identity: absent/disabled ⇒ untouched geometry (add a vertex-buffer test).

### Slice 3 — Jewellery studio environment

Give stones something rich to reflect/refract on a black backdrop (the reference
look).

- First, pragmatic: **enrich the procedural path** — the existing `darkStrips`
  (black void + bright bars) is already gem-oriented; tune it (a few more crisp
  bright bars at varied angles) so a clear gem sparkles on `background:#000`.
- Optional/stretch: bundle **one CC0 studio HDRI** (`RGBELoader` + PMREM), added as
  a new `EnvironmentKind` (`studioHdri`). Keeps `buildEnvironmentScene` sync path
  intact by loading async and swapping `scene.environment` when ready (mirrors the
  spike). Only if procedural enrichment falls short.

### Slice 4 — Gemstone material

Make coloured stones actually read as coloured, and package the recipe.

- Add material type `gemstone` (a `MeshPhysicalMaterial` preset engine): a `stone`
  picker (Diamond, Ruby, Sapphire, Emerald, Amethyst, Aquamarine, Topaz, …) sets
  `color`, `attenuationColor`, `attenuationDistance`, `ior`, `dispersion`,
  `transmission`, `thickness`, `roughness`, `clearcoat` to per-stone values.
- **Fix the coloured grey-out**: tie the visible body colour to attenuation with a
  sane default distance relative to the stone's size, so ruby/sapphire/emerald show
  saturated (validated live, not just by param existence — see
  graceful-fallback-hides-integration-failure memory).
- Keep `glass` as-is (raw physical controls). `gemstone` = the curated front door.

### Slice 5 — Finishing (sparkle + crisp edges)

- Add **SMAA** to the composite path so facet edges are crisp (currently soft
  through the composer). Small, self-contained pass in the PostChain.
- Bloom defaults tuned for gems (tight radius, high threshold → glints not haze).
  Bloom already exists; this is defaults + maybe a "gem" convenience.

### Slice 6 (optional, later) — Path-traced hero export

`three-gpu-pathtracer` as a still-only "final render" for the true floor caustic +
fullest fire. Separate spec when/if we get there.

## UX

- Gem cut + facet density live in the gem primitive's params panel (existing
  StudioSlider/options rows; sentence-case labels, optionLabels for the `cut` and
  `stone` selects — ui-copy memory).
- `gemstone` material appears in the material-type select with a proper label
  (`MATERIAL_TYPE_LABELS`), stone picker beneath it.
- `Facets` modifier in the object's add-modifier menu (hover plus-menu), under
  producers. Re-verify menu fit at ~640px.
- Motion authoring, if any dial becomes animatable, lives in Motion surfaces only
  (motion-authoring-lives-in-motion-surfaces memory) — not inspector blocks.

## Testing / verification

- **Live GPU oracle is authoritative** (hidden pane pauses rAF; unit CPU-twins
  miss GPU bugs — scene3d-treatments-s4 memory). Verify each slice by rendering in
  `/dev/scene3d-lab?state=…`, capturing `__scene3dBeauty()` via `/api/dev-scratch`,
  and looking.
- Unit tests: cut geometry vertex/face counts per cut + facet density; facet
  modifier vertex-buffer **byte-identity when absent**; material preset param
  mapping.
- Coloured-stone check: a metric that a ruby renders *red*, not grey (mean hue),
  to prevent the silent grey-out regressing.
- Emit **float GLSL literals** if any shader work arises (ANGLE rejects
  `float/int` — scene3d-treatments-s4 memory).

## Risks / notes

- Shared checkout: several sessions edit `engine.ts`. Stage **only own hunks** via
  a private `GIT_INDEX_FILE`; never `git add -A`; leave foreign hunks alone
  (private-git-index memory). Subagents don't commit here.
- Never let a subagent run `npm run dev` (kills :3002). One server per checkout;
  `:3002` is the main. After any frontend restart, re-check ComfyUI on :8188.
- Adding a material type / env kind / modifier kind each has a fixed registration
  rhythm (total-Record guards will flag a missed spot at compile time).
