# 3D Studio: ambientCG texture sets

Date: 2026-09-01. Status: approved design, not yet built.

## What this is

A 3D Studio object gets a real-world surface from the ambientCG library: wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, and so on. Around two thousand sets, all CC0, each a bundle of PBR maps. The user picks one from a thumbnail grid in the Material panel. The agent picks one from a plain-English word in a prompt, so "a wooden box" becomes a cube with a wood surface.

Measured on 2026-09-01: a 1K JPG set is about 3.9 MB and downloads in about 1.7 seconds. The maps alone are about 2.5 MB once the Blender, USD, and MaterialX side files are dropped.

## Scope

In:
- Texture sets on 3D Studio materials, at 1K JPG, fetched on demand and cached on disk.
- Five map slots on the engine side: colour, roughness, normal, metalness, ambient occlusion. Displacement feeds the existing relief bump.
- A picker in the Material panel.
- One agent control that accepts a plain phrase.

Out, for later specs:
- HDRI environments from ambientCG.
- Higher resolutions. The download route accepts only 1K.
- True vertex displacement.
- A mirrored subset shipped with Sailor.

## Data model

One new optional field on `SceneMaterial` in `frontend/app/lib/scene3d/config.ts`:

```
texture?: string        // 'ambientcg:Wood095' once resolved; a plain phrase such as 'wood' while unresolved
textureTiling?: number  // repeats across the object's UVs, default 1, range 0.25 to 12
```

The id is namespaced so another library can join later without a schema change. Map filenames are never stored. They derive from the id: the set `Wood095` lives at `input/sailor_textures/Wood095/` and its maps are `Color.jpg`, `Roughness.jpg`, `NormalGL.jpg`, `Displacement.jpg`, `AmbientOcclusion.jpg`, `Metalness.jpg`, whichever the set provides.

A value without the `ambientcg:` prefix is an unresolved phrase. It renders untextured until something resolves it. It is a legal document state, so a half-applied agent patch never breaks a load.

The field applies to the `standard`, `glass`, and `opalescent` material types, the three built on three.js's physical pipeline. Other types keep the field but ignore it, the same way they ignore the base colour today. Switching type back to standard brings the texture back.

The normaliser in `config.ts` copies `texture` only when it is a non-empty string and `textureTiling` only when it is a finite number, following the existing copy-only-when-present rule.

## Server

Both routes sit under the existing `/api/scene3d` prefix, which the proxy allowlist already owns, so no allowlist change is needed. A guard test still asserts both paths resolve as Nitro paths.

### Catalog: `GET /api/scene3d/textures/catalog`

Returns a slim index of every material set:

```
{ sets: [{ id, name, category, tags, thumb, popularity }], count, fetchedAt }
```

`thumb` is the ambientCG 256px JPG on a dark ground. Built from the ambientCG v2 JSON API with `type=Material`, which is 14.6 MB raw, so the slimming happens server-side and the browser receives well under 1 MB. Cached in memory for 24 hours in `server/utils/ambientcgCatalog.ts`, mirroring `googleCatalog.ts`. If a refresh fails and a stale copy exists, the stale copy is served. If no copy exists, the route returns 502 with a plain message.

### Fetch: `POST /api/scene3d/textures/fetch` with `{ id }`

- Validates the id against `^[A-Za-z0-9]+$` and against the catalog. Anything else is 400.
- If `input/sailor_textures/<id>/manifest.json` exists, returns it immediately.
- Otherwise downloads `https://ambientcg.com/get?file=<id>_1K-JPG.zip` to a temp file under the same folder, following redirects, then opens it with jszip and writes only the map JPEGs, renamed to the fixed names above. `NormalGL` is kept, `NormalDX` is dropped. Everything else in the zip is discarded.
- Writes `manifest.json`: `{ id, maps: ['color','roughness','normal',...], fetchedAt }` and returns it.
- Concurrent requests for the same id share one in-flight promise.
- On any failure the partial folder is removed and the route returns 502 with a plain message.

### Resolve: `POST /api/scene3d/textures/resolve` with `{ phrase }`

Turns a plain phrase into a set id, deterministically:

1. Exact id match, case-insensitive, with or without the `ambientcg:` prefix.
2. Every word of the phrase matched against tags and category, scored by number of matching words, ties broken by popularity.
3. A small synonym table in `server/utils/ambientcgSynonyms.ts` for words the tags miss, for example `wooden` to `wood`, `stone` to `rock`, `steel` to `metal`, `cloth` to `fabric`, `floorboards` to `wood planks`.

Returns `{ id, name }` or `{ id: null }` on a miss. Never 404s, so the caller distinguishes a miss from a network error.

Resolution is a pure function over the catalog, exported from `server/utils/ambientcgResolve.ts` so it can be unit tested without the network.

## Client library: `frontend/app/lib/scene3d/textures.ts`

- `isResolvedTexture(value)`: true when the value starts with `ambientcg:`.
- `textureMapUrl(id, map)`: the `/view?type=input` URL for one map of a set.
- `ensureTextureFetched(id)`: calls the fetch route once per id per session and caches the manifest promise. Returns the manifest.
- `resolveTexturePhrase(phrase)`: calls the resolve route.
- `loadTextureCatalog()`: fetches and caches the catalog for the picker.

## Engine

In `materials.ts`, one shared step `applyTextureSet(material, sceneMaterial)` runs after per-type construction, next to `applyRelief`, on any material with a `map` slot. It:

- Does nothing unless the value is a resolved id and the material type is standard, glass, or opalescent.
- Fetches the manifest through `ensureTextureFetched`, then binds each present map through the existing `getImageTexture` cache: colour in sRGB, everything else in `NoColorSpace`.
- Sets `map`, `roughnessMap`, `metalnessMap`, `normalMap`, and `aoMap`. The ambient occlusion texture has its channel set to 0 so it reads the primary UVs.
- Leaves `roughness` and `metalness` as multipliers, which is how three.js composes them with the maps. A set with no metalness map gets `metalness` from the slider as before.
- Sets `RepeatWrapping` and `repeat` from `textureTiling` on every bound map. Tiling updates in place through `updateMaterial` without a rebuild, following the relief tiling pattern.
- Displacement: when the set has a displacement map and the material has no relief of its own (`relief.source` is `none` or absent), the displacement map is bound as the bump through the existing height-texture path at the default relief scale and the same tiling. An explicit relief always wins.
- A material with a `normalImage` set by the user keeps it. The set's normal map only fills an empty slot.

`identityKey` includes `texture` so a change rebuilds the material. `textureTiling` is excluded, like relief tiling.

Textures arrive asynchronously. Until the manifest and images land, the material renders untextured. When they land, the maps bind and `needsUpdate` fires. This follows the existing relief heal pattern.

## Picker UI

In `Scene3DStudioSurface.vue`, a bespoke block under the Material group, declared as a control `object.material.texture` of kind `text` in `controls.ts` with a `when` of "physical material type", and rendered through the `#control-ui.material.texture` slot.

The row shows a 28px thumbnail of the current set plus its name, or "None", and a clear button. Clicking opens `TexturePicker.vue`, a new component in `app/components/vue-canvas/`, shaped like `FontPicker.vue`:

- Search box filtering by name, tag, and category.
- Category chips down the left, from the catalog's own categories, most popular first.
- A thumbnail grid capped at 120 rows, sorted by popularity, with the current set highlighted.
- Picking calls `ensureTextureFetched` first and shows a spinner on the row until the manifest returns, then writes the resolved id to the material. On failure the row shows a short inline error and nothing is written, so the material keeps its previous value.

A `Texture tiling` slider follows the row, gated on a texture being set.

The picker writes ids only. It never writes a phrase.

## Agent

`object.material.texture` reaches the agent through the existing `sceneAgentControls` path as a text control. Its hint reads: "A real-world surface from the ambientCG library. Write a plain material word such as wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, or an exact set id. Needs a standard, glass, or opalescent material type."

At the point where an agent patch is applied to a scene document in `studioTune.ts`, an async step `resolveTexturePatches(patch)` runs first. For every key ending in `.material.texture` whose value is not a resolved id, it calls the resolve route. A hit replaces the value with the id. A miss removes the key from the patch and appends a note to the agent's result: "No texture set matched '<phrase>'". The rest of the patch applies as normal.

The guide in `agentControls.ts` gains a section:

> SURFACE TEXTURES: `object.material.texture` takes a plain material word (wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, sand, rock, plaster) or an exact set id and dresses the object in a real photographed PBR surface: colour, roughness, normal and relief together. It needs a lit PBR type (standard, glass, opalescent). When the ask names a material by what it is made of ("a wooden box", "a brick wall", "a marble sphere"), reach for this rather than a flat colour. Pair with `textureTiling` when the pattern should repeat more or less across the object.
>
> WORKED EXAMPLE, "a wooden box" on an empty scene: {"primitive":"box", "object.material.type":"standard", "object.material.texture":"wood", "object.material.roughness":0.8}.

## Error handling

- Network failure on fetch: the row shows "Couldn't download this texture", the material keeps its previous value, and the agent gets the same note.
- A set missing a map: that slot stays unbound. No error.
- A document referencing a set not on disk, for instance after a fresh deploy: `ensureTextureFetched` re-downloads on first render. The object renders untextured until it arrives.
- Catalog unavailable and no stale copy: the picker shows "Texture library unavailable" and the resolve route returns a miss.
- A phrase that resolves to nothing: the control stays at None. The agent's note names the phrase.

## Testing

Unit, under `frontend/tests/unit/`:
- `ambientcg-catalog.unit.spec.ts`: slimming a captured API sample produces the expected shape, and a refresh failure serves the stale copy.
- `ambientcg-resolve.unit.spec.ts`: exact id, single word, multi-word ranking, synonym, and miss. Runs against a fixture catalog, no network.
- `ambientcg-fetch.unit.spec.ts`: given a fixture zip, the extractor writes exactly the renamed maps and manifest, drops the side files, keeps NormalGL over NormalDX, and cleans up on a corrupt zip.
- `scene3d-textures.unit.spec.ts`: `isResolvedTexture`, `textureMapUrl`, one fetch per id, and `resolveTexturePatches` rewriting a hit, dropping a miss, and leaving resolved ids alone.
- `scene3d-config.unit.spec.ts`: the normaliser keeps and drops the two fields correctly.
- `scene3d-materials.unit.spec.ts`: `applyTextureSet` binds only the maps the manifest lists, sets ao channel 0, applies tiling, and skips non-physical types.
- `scene3d-agent-controls.unit.spec.ts`: the texture control is offered for physical types and withheld otherwise, and the guide contains the worked example.
- Nitro path guard: both new routes resolve as Nitro paths.

Rendering parity, under `frontend/tests/`: a textured cube and an untextured cube rendered headless differ in pixels once the fixture textures load. This catches a silently unbound map, following the rule that a graceful fallback must not hide an integration failure.

Browser E2E: open the 3D Studio, add a box, open the picker, type "wood", pick the first result, and assert the row shows a thumbnail and the fetch route returned 200.

## Files touched

New:
- `frontend/server/utils/ambientcgCatalog.ts`, `ambientcgResolve.ts`, `ambientcgSynonyms.ts`, `ambientcgExtract.ts`
- `frontend/server/api/scene3d/textures/catalog.get.ts`, `fetch.post.ts`, `resolve.post.ts`
- `frontend/app/lib/scene3d/textures.ts`
- `frontend/app/components/vue-canvas/TexturePicker.vue`
- Tests listed above, plus a fixture zip and a fixture catalog JSON under `frontend/tests/fixtures/ambientcg/`.

Changed:
- `frontend/app/lib/scene3d/config.ts`: fields, defaults, normaliser.
- `frontend/app/lib/scene3d/materials.ts`: `applyTextureSet`, identity key, in-place tiling.
- `frontend/app/lib/scene3d/controls.ts`: texture and tiling controls.
- `frontend/app/lib/scene3d/agentControls.ts`: guide section.
- `frontend/app/lib/agent/studioTune.ts`: `resolveTexturePatches` step.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`: texture row slot.
