# Slice S7.1 · AI restyle → projective surface texturing (task-level plan)

> Follow-up to **S7 AI restyle pass** (`docs/superpowers/plans/2026-09-09-scene3d-S7-ai-restyle-pass.md`,
> landed). S7 v1 composites the model's flat result masked to the object's SCREEN silhouette
> (`restyleComposite` / `RESTYLE_FRAG`, a screen-space billboard baked from ONE camera angle). It is
> correct ONLY from the bake angle — the moment the live camera orbits/pans, the flat image is merely
> re-stretched into the new axis-aligned screen bbox and slides off the surface. The user hit this:
> "it's great until i pan or orbit around. i didn't realize that the object was essentially masking a
> fixed image."
>
> **This slice makes the restyle STICK to the 3D surface.** It projects the restyle image onto the
> object's ACTUAL geometry from the BAKE camera (slide-projector model), so as the live camera moves
> the restyle stays painted on the surface. Architecturally this **replaces the treatment-stage screen
> composite with a per-object MATERIAL injection** (onBeforeCompile), the **S5 finishes pattern**
> (`app/lib/scene3d/finishes.ts` + `materials.ts`) — NOT a stage pass.
>
> **ATTRIBUTION.** This session is **Opus 4.8**; commits end
> `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
>
> **CONTROLLER RATIFICATION (2026-09-16): all Task-0 recommendations accepted as written.** Julien
> greenlit building the projective upgrade and accepted the honest front-only caveat. Tasks 1–3 spend
> nothing; the single live PAID acceptance run (Task 4) waits for Julien's explicit go.
>
> **Doc-location note:** the plans live at repo-root `docs/`; all code anchors are under `frontend/`.
> **Base:** current `main` tip `27e9b1502` (verify `git rev-parse HEAD`). S7 is landed:
> `RESTYLE_TREATMENT_KINDS`, `AiRestyleTreatment`, `renderObjectPasses`, `restyleCache.ts`, the stage
> `restyleComposite`, `engine.setRestyleTextures`, the surface `runRestyle` / `__scene3dRestyleInject`,
> and `tests/scene3d-restyle.spec.ts` all exist and are the direct precedent.

---

## The crux (read first)

1. **This is a rendering-seam SWAP, not a new feature.** The doc model (`prompt/strength/model/mix/
   resultRef/inputHash`), the paid route, `restyleCache.ts`, `runRestyle`, `renderObjectPasses`, and the
   result-texture cache are UNCHANGED. What changes: the restyle result is drawn by the object's
   **material** projected onto its surface, instead of by the **treatment stage** as a flat billboard.
   No new paid path, no new model call, no cost change.

2. **Projective texturing is correct-by-construction across camera motion.** The projector is a fixed
   WORLD-space transform (the bake camera's view-projection). The material projects each fragment's
   WORLD position into that fixed frame and samples the image there. Because the projector is pinned in
   world space, orbiting/panning the LIVE camera needs **zero per-frame uniform updates** — the paint is
   glued to the surface. This is the single biggest simplification over v1 (which recomputed the screen
   crop rect every frame precisely because it was screen-space).

3. **The matrix is tiny; pixels still never enter the doc.** The projection needs the bake camera's
   view-projection (16 floats) + the crop rect (4) + bake canvas size (2) + projector forward (3),
   stored on the treatment alongside `resultRef`. That is legible, reload-stable metadata — the image
   bytes remain out of the doc (still `resultRef` + the client texture cache).

4. **Byte-identity has the same TWO shapes as S7.** *Absent* aiRestyle ⇒ no material injection ⇒
   material compiles byte-for-byte as before (the `applyFinish(m, [])` early-out precedent). *Present but
   uncached* (no `resultRef`/texture yet) ⇒ no injection ⇒ the plain object (a no-op). The injection only
   exists when a decoded result texture is in hand — exactly the `tex != null` gate v1 used.

5. **Honest target:** "holds as you move around the FRONT of the object." A single image only knows the
   front; the back and grazing angles are unknown (multi-view generation is out of scope). The
   front-facing gate falls the surface back to the base material outside the projected/front region.

---

## Task 0 · Decisions (RATIFIED — controller accepted all recommendations)

### (a) Projection math
Inject at the **fragment** stage of the object's material; project the fragment's **world position**
through the stored bake view-projection, then map NDC → crop-square UV exactly as v1's `RESTYLE_FRAG`
did (`treatmentStage.ts:809-815`).

- **World position via a vertex-injected varying** (NOT reconstruction from `vViewPosition`). Inject into
  `shader.vertexShader`: `vRestyleWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;` (after
  `#include <project_vertex>`; `transformed` is defined by `<begin_vertex>`), and
  `vRestyleWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );` (`objectNormal` from
  `<beginnormal_vertex>`). **Why a varying, not reconstruction:** reconstructing world pos from
  `vViewPosition` needs `bakeViewProj * inverse(liveViewMatrix)` recomputed **every frame** (a per-frame
  uniform write per object) AND depends on `vViewPosition` existing (absent on unlit materials) and on
  WebGL2 `inverse()`. The world varyings make the projector a **constant uniform** — camera-independent,
  no per-frame churn, host-material-agnostic.
- **Fragment** (injected at `#include <dithering_fragment>`, the S5 terminal display-space anchor):
  ```glsl
  vec4 rProjClip = uRestyleProjVP * vec4( vRestyleWorldPos, 1.0 );
  vec3 rNdc      = rProjClip.xyz / rProjClip.w;
  vec2 rFull     = rNdc.xy * 0.5 + 0.5;                       // full-frame [0,1], bottom-left
  // full-frame [0,1] -> bake pixel (top-left origin) -> crop-square UV, exactly cropSquareDataUrl's map
  vec2 rPix      = vec2( rFull.x * uRestyleSize.x, ( 1.0 - rFull.y ) * uRestyleSize.y );
  float side     = max( uRestyleRect.z, uRestyleRect.w );
  vec2 off       = vec2( floor( ( side - uRestyleRect.z ) * 0.5 ), floor( ( side - uRestyleRect.w ) * 0.5 ) );
  vec2 rUv       = ( vec2( rPix.x - uRestyleRect.x, rPix.y - uRestyleRect.y ) + off ) / max( side, 1.0 );
  ```
  Sample `texture2D( uRestyleTex, vec2( rUv.x, 1.0 - rUv.y ) )` (flipY as v1, `treatmentStage.ts:813-815`).
  Byte-identical crop-mapping math to v1 — only the INPUT changed from live-frame screen position to the
  projected bake NDC. Ship a CPU twin `projectRestyleUV(...)`.
- **Emit every float operand with a decimal** (`X.toFixed(7)` for any JS-derived literal; all dials ride
  uniforms so there is nothing to interpolate) — the S4/S5 ANGLE trap. Source-guard unit in Task 3.

### (b) Front-facing gate
Gate the projection on BOTH:
1. `dot( normalize( vRestyleWorldNormal ), uRestyleForward ) < 0.0` — the fragment faces the projector
   (`uRestyleForward` = bake camera forward in world = `normalize(target - position)`), AND
2. projected UV inside the crop square: `all(greaterThanEqual(rUv, vec2(0.0))) && all(lessThanEqual(rUv, vec2(1.0)))`
   AND `rProjClip.w > 0.0` (in front of the projector).

Where the gate FAILS, leave `gl_FragColor` untouched (base material). To avoid a hard terminator seam,
soft-fade the normal term: `float face = smoothstep( 0.0, 0.25, -dot(n, uRestyleForward) );` and fold
`face` into the effective mix. Final:
`gl_FragColor.rgb = mix( gl_FragColor.rgb, restyleRgb, uRestyleMix * face * inUv );` where `inUv` is the
UV-in-range test (0/1). Keeps the image on the front and softly releases it toward the silhouette.

### (c) Occlusion — DEFER
A true projector uses the bake DEPTH to skip occluded fragments. For the mostly-convex primitives S7
targets, the normal gate suffices (a back-facing fragment is never painted). **Defer depth-test
occlusion to a follow-up** (needs the bake depth crop stored/re-uploaded as a shadow-map-style uniform —
not cheap, low payoff for convex hosts). Document the concavity caveat.

### (d) `mix` — KEEP FREE/LIVE
`mix` is a live per-fragment blend of the projected restyle over the base material (0 = base, 1 = full
restyle on the projected front region), written in place as a uniform (never rebuilds, never re-bills) —
the `updateFinishUniforms` in-place precedent (`finishes.ts:471`).

### (e) How the bake projection is stored
Store the **exact bake view-projection matrix** (not re-derived params), the crop rect, the bake canvas
size, and the projector forward, on `AiRestyleTreatment`:
```ts
projViewProj: number[]   // 16 — bakeViewProj, EXACTLY renderObjectPasses' local matrix (passes.ts:289)
projRect: number[]       // 4  — [x, y, w, h] bake-canvas px (top-left), the crop (passes.ts:290)
projSize: number[]       // 2  — [w, h] bake canvas px (doc.output at bake time)
projForward: number[]    // 3  — normalize(target - position) world, the projector's look direction
```
**Why the matrix, not params:** it guarantees the material reproduces the bake projection byte-exactly
regardless of any future camera-construction refactor, and it is exactly the value `renderObjectPasses`
already computes and discards today (`passes.ts:289`). All four are tiny, serialize in the doc, survive
reload. When ALL are absent/empty ⇒ no injection ⇒ byte-identical.

**Scope note (world-space projector):** this pins the paint across CAMERA motion (the reported bug). If
the OBJECT itself animates (`doc.motion`), a world-space projector slides over the moving surface —
documented follow-up (fold the bake modelMatrix in to make the projector object-LOCAL).

### (f) Replace the stage composite, or coexist — REPLACE
**Replace** `restyleComposite` / `RESTYLE_FRAG` / `StageContext.restyles` / the stage's `restylePlan`
threading. The screen-space composite is the exact thing that breaks on orbit; keeping it as a
"flat/billboard mode" adds a dead mode and a second code path over the same data. Remove it. **Keep**
everything upstream: the doc model, the route, `restyleCache.ts`, `renderObjectPasses`,
`engine.setRestyleTextures` + the `restyleTextures` map (its CONSUMER moves from the stage to the
material builder), `runRestyle`, `collectRestyleTextures`, `__scene3dRestyleInject`.

### (g) Sampled-texture colour space — NoColorSpace
The injection sits at `<dithering_fragment>`, which runs AFTER `<tonemapping_fragment>` +
`<colorspace_fragment>` — `gl_FragColor` is already **display-encoded (sRGB)**. The result PNG is sRGB
bytes. Sample it **raw** (`texture.colorSpace = THREE.NoColorSpace`, NO `srgbToLinear` in the shader) so
the raw sRGB sample blends directly into the display-encoded buffer — the **opal-ramp lesson**
(`finishes.ts:81-89`, `338-362`). This DIFFERS from v1: v1 injected in the stage's LINEAR-HDR space, so
it set `SRGBColorSpace` and manually `srgbToLinear`'d (`treatmentStage.ts:802-815`; surface `runRestyle`
sets `SRGBColorSpace` at `Scene3DStudioSurface.vue:2032`). Under REPLACE, the surface must set the cached
texture to `NoColorSpace` for the material consumer. **Verify against a plain-object `mix:1` reference.**

---

## Global constraints (bind every task)

- **Byte-identical when absent.** No aiRestyle (or no cached result) ⇒ the material compiles unchanged:
  (a) `parseTreatments` round-trip identity INCLUDING the four new fields, and (b) a real-canvas A/B on
  `/dev/scene3d-lab` (`.toBe()`, the `scene3d-finishes.spec.ts` pattern). RED first against a stub that
  forces the injection on.
- **`strength` / `mix` stay motion targets + agent controls by stable id** via `treatmentControls('aiRestyle')`
  (`treatmentControls.ts:238-246`); `prompt` (text) and `model` (select) are not numeric targets. The new
  stored fields are NOT `ControlSpec` rows.
- **Verify through `/dev/scene3d-lab?state=` + `__scene3d*` hooks; a hidden pane pauses rAF ⇒ live
  Playwright with the pane visible is the oracle.** **NEVER `npm run dev`** (kills shared :3002/ComfyUI) —
  fresh harness preview on its own port. **NO paid model call** except the single env-gated Task-4 run.
- **CI never spends.** Every visual test uses `__scene3dRestyleInject` (a LOCAL image → cached texture,
  zero spend). GLSL float-literal source-guard + no live fal in CI.
- Shared files staged **by hunk** — own hunks only, never `git add -A`/`git stash`. Controller commits.

---

## Tasks

### Task 1 · Capture + store the bake projection (no rendering change)
Store the projector metadata so it is reproducible across reload. The stage still renders v1 in this
task (it ignores the new fields), so this task is byte-identical to shipped S7 at render time.

- **`passes.ts`** `renderObjectPasses` (268): it already computes `viewProj` (289) + `rect` (290) and
  discards `viewProj`. Extend the return (270, 347) to also emit `viewProj: number[]` (`.toArray()`),
  `size: [width, height]`, `forward: number[]` (`normalize(target - position)`, world). No bake change.
- **`treatments.ts`**: `AiRestyleTreatment` (303-311) gains `projViewProj/projRect/projSize/projForward`;
  `TREATMENT_DEFAULTS.aiRestyle` (379) defaults each to `[]`; `parseTreatment` (634-651) parses each with
  a `numArrayN(raw, n)` helper (16/4/2/3 finite numbers else `[]`). Round-trip test: all four survive AND
  an absent/short/NaN array collapses to `[]`.
- **`Scene3DStudioSurface.vue`**: `runRestyle` (1991) stamps the four fields from `passes` after the bake;
  `__scene3dRestyleInject` (2129-2141) — which does NOT bake — stamps a projector from the CURRENT live
  camera + `screenRectOfBox` so the zero-spend oracle can project from a known frame.
- **Tests (RED first):** parse round-trip + collapse-to-`[]`; `renderObjectPasses` returns the arrays
  (extend `scene3d-restyle.spec.ts:136`); byte-identity absent unchanged.
- **Acceptance:** fields persist a round-trip; a re-run/inject stamps them; render byte-identical to
  shipped S7 (stage still draws v1); typecheck baseline.

### Task 2 · The projective material injection + REMOVE the stage composite (the seam swap)
The core. Build the material seam and delete the stage path in one task so restyle is never
double-composited.

- **`restyleProjection.ts`** (NEW — three; mirrors `finishes.ts`): `applyRestyleProjection(m, t, tex)`
  (early-out `if (!tex || !t.projViewProj.length) return`; snapshot `baseKey` EAGERLY; chain `prev`;
  inject the two world varyings + the fragment pars/body at `<dithering_fragment>`; hold uniforms on
  `m.userData.restyleUniforms`; set `customProgramCacheKey`), `updateRestyleUniforms(m, t, tex)` (in-place
  `uRestyleMix`; rebuild boundary when the texture/`resultRef`/matrix changes), `restyleProjectionKey(t, tex)`
  (`''` when none, else `|rst:${resultRef}`), and CPU twins `projectRestyleUV`, `restyleFrontFacing`.
  Uniforms: `uRestyleTex, uRestyleProjVP(mat4), uRestyleRect(vec4), uRestyleSize(vec2), uRestyleForward(vec3),
  uRestyleMix(float)` — all constant per material except `uRestyleMix`; **no per-frame camera uniform**.
- **`treatments.ts`**: `objectRestylePlan(obj)` — the first enabled aiRestyle on an object (finishPlan
  analogue), feeding the material builder.
- **`materials.ts`**: thread a restyle spec like `finishes` — `materialFor(..., restyle?)` calls
  `applyRestyleProjection` AFTER `applyFinish` (topmost coat); `updateMaterial(..., restyle?)` calls
  `updateRestyleUniforms` (rebuild on false); `identityKey(..., restyle?)` folds `restyleProjectionKey`.
- **`Scene3DStudioSurface.vue`**: the decoded texture is set `NoColorSpace` (was `SRGBColorSpace` at 2032),
  both in `runRestyle` and the inject hook.
- **`engine.ts`**: pass the restyle spec at the primitive material sites (`objectRestylePlan(obj)` + the
  `restyleTextures.get(obj.id)` tex → `{ t, tex }` or null). **REMOVE the stage restyle path** from
  `runStage`/`render(...)`.
- **`treatmentStage.ts`**: REMOVE `StageContext.restyles`, `RESTYLE_FRAG`, `restyleMat`,
  `restyleComposite`, the `render()` `restylePlan` param + `restyleGroups`/`restyleRoots` + every
  `...restyleRoots` base-hide addition + loop 2e + the `stats.groups` term + `restyleMat` dispose; drop now-
  unused imports (verify `screenRectOfBox`/`fitNearFar` still used elsewhere).
- **Tests (RED first):** CPU-twin units (`projectRestyleUV`, `restyleFrontFacing`);
  `applyRestyleProjection` with empty `projViewProj` leaves the program UNCHANGED (byte-identity, RED
  against an unconditional-inject stub); live Playwright — injected result projects onto the front face at
  `mix:1`, `mix:0` == plain (`.toBe`), background untouched; console-error gate.
- **Acceptance:** an injected restyle paints the FRONT surface; `mix` blends live; absent ⇒ byte-identical;
  stage no longer references restyle (grep clean); typecheck baseline.

### Task 3 · Migrate the Playwright suite + orbit-stability + source guard
- Keep/adapt the existing cases (absent-identity, crop, mix:1 → assert FRONT face, mix:0 `.toBe` plain,
  determinism, mix:0.5 on a front point).
- **Turn the orbit `test.fixme` (414) into a real PASSING test** — the headline acceptance: a surface
  point stays the restyle colour across a camera orbit (inject a magenta/cyan split, snapshot at two
  angles, assert the restyle stays REGISTERED to the surface rather than sliding to base as v1 did).
  Sample by tracking the object's projected centre (`__scene3dCamera`/`screenRectOfBox`), not a hard-coded
  screen coord. Pair every visual assertion with `__scene3dTreatmentStats()`.
- Source-guard unit for the new GLSL (grep built vertex+fragment for a bare-int operand); determinism.
- Fresh preview, pane visible, NOT the shared :3002.
- **Acceptance:** describe green live (no paid call), incl. the orbit-stability test v1 could not pass;
  unit sweep green; typecheck baseline.

### Task 4 · The single live PAID acceptance run + agent/motion/copy sweep + closeout
- The env-gated live run (`scene3d-restyle.spec.ts:447`) now asserts the result PROJECTS onto the surface
  (not the billboard) and reconciles observed cost vs `MODEL_COSTS`. Controller runs it manually with
  `FAL_KEY` + `SCENE3D_RESTYLE_LIVE=1` — **NEEDS JULIEN'S EXPLICIT GO**.
- Agent/motion asserts unchanged; copy sweep (note the honest "holds as you move around the front" caveat
  near the mix hint); dashboard/memory closeout.
- **Acceptance:** one live paid run done + cost reconciled; whole-slice review; copy pass.

---

## Acceptance (whole slice)
- A restyle result is PROJECTED onto the object's surface from the bake camera and **stays registered to
  the surface as the live camera orbits/pans** (orbit-stability Playwright green — the test v1 could not
  pass). `mix` blends live (free); an object with no restyle (or no result yet) is byte-identical to
  shipped S7.
- The stage screen composite is removed; the restyle is a material injection on the S5 finishes model.
- The bake projection survives reload; pixels never enter the doc; the run bills at most once per distinct
  input (`restyleCache.ts` unchanged).
- Live Playwright green (no paid call); one env-gated live PAID run at acceptance; unit sweep green;
  typecheck baseline.

## Follow-ups (owed, non-blocking)
- **Object-motion projector** (fold the bake modelMatrix for a local-space projector when the OBJECT
  animates). **Depth-test occlusion** for concave hosts. **Back/side coverage** (multi-view generation).
  **Grazing-angle stretch** (documented; soft terminator mitigates). **GLB/text hosts** live case.

## Top risks
1. Reproducing the bake projection in-material byte-exactly (crop-square UV + the stored matrix) —
   mitigated by storing the raw matrix and reusing v1's proven crop math with a `projectRestyleUV` CPU twin.
2. Back/grazing bleed from a single-view image with no occlusion — mitigated by the normal+UV gate + soft
   terminator; depth-occlusion deferred (fine for convex hosts).
3. Colour-space double-decode at the display-space anchor — mitigated by `NoColorSpace` + a `mix:1`
   reference check.
