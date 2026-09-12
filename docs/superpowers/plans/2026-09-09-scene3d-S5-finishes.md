# Slice S5 · Finishes as treatments  (task-level plan)

> Part of the **3D Studio Treatments & Modifiers Programme**
> (`docs/superpowers/plans/2026-09-09-scene3d-treatments-programme.md`). This is the task-level
> plan for slice S5, written when the slice was reached, executed with
> superpowers:subagent-driven-development as S1–S4 were.

**Scope decision (2026-09-12):** the programme's S5 bundled "finishes as treatments" with a
**light-linking** spike. The spike's question was answered up front by reading the code: in the
installed three.js (0.171) `Light.layers` only gates a light against the **camera** once per
`render()` — every mesh in that call sees the same light set — so true per-object light exclusion
is unreachable without a separate render pass per light-group (the treatment-stage isolate-and-
composite machinery). On that finding the user chose **defer light-linking to its own later slice**
and ship S5 as the three finishes only. Light-linking is NOT in this plan.

**Goal:** three surface **finishes** — **foil shimmer**, **opalescence**, **matcap coat** — that
sit on top of an object's existing material as an overlay, added and tuned as **treatment tree
rows** (the same UX as every S1–S4 treatment): tree, add-menu, breadcrumb inspector, agent and
motion pick them up. Unlike masked/edge/buffer treatments (which are treatment-STAGE passes),
finishes are **material shader injections** built in `materials.ts` on the `applyScreen` /
`applyVaryTint` model, so they cost nothing at the treatment stage and are byte-identical when
absent by construction (no injection ⇒ the material compiles exactly as before).

## Global constraints (from the programme; bind every task)

- **Byte-identical when absent.** An object with no finish treatment builds a material
  byte-for-byte identical to before, proven by (a) a unit assertion on the compiled
  `customProgramCacheKey` / injected shader source being unchanged and (b) a real-canvas A/B on
  `/dev/scene3d-lab` (data-URL equal) — run RED first against a deliberately-injecting stub.
- Dials are motion targets and agent controls by stable id via `iterateTreatmentControls` — which
  is fully derived from `treatmentControls(kind)`, so **no per-kind agent edit** and (per S4) **no
  colour whitelist**: a finish colour is a first-class `color` control kind.
- UI copy sentence case, human names, no dead controls; `layer bits 29–31 reserved` (finishes add
  no layer bits — they are material injections, not stage passes).
- One dev server per checkout; verify through `/dev/scene3d-lab?state=` and the `__scene3d*` hooks;
  a **hidden browser pane pauses the scene3d rAF** (blank `__scene3dSnapshot`, `groups:0`), so the
  live oracle is **headless Playwright**, not an in-pane manual snapshot (S4 lesson).
- `materials.ts` and shared scene3d files are staged **by hunk** (`git diff` → `git apply --cached`,
  private `GIT_INDEX_FILE`) — a concurrent session's foreign hunks live in this checkout; own hunks
  only, never `git add -A`, never `git stash`. NEVER let a subagent run `npm run dev`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## The two GPU lessons S4 recorded (bind every shader task)

- **Never interpolate a JS number into a GLSL float context without a decimal.** `${X}` where X is
  `3.0` stringifies to `"3"`, and `6.28 / 3` is a float÷int that ANGLE (Chromium) rejects at compile
  — the program never links and the injection silently does nothing. Emit float literals
  (`X.toFixed(7)`); add a source-guard unit that greps the built shader for a bare-int operand.
- **The stage/material is linear-HDR before OutputPass** for treatment-stage passes; a finish that
  injects at `<dithering_fragment>` runs AFTER tonemapping+colorspace, i.e. in **display space** —
  choose the space deliberately and remap luminance perceptually if a threshold/pivot is involved
  (S4 halftone flooded to black by pivoting on a linear luminance below 0.5).
- **CPU twins pass over broken GPU shaders.** Every finish ships a CPU twin for its math AND a live
  Playwright case (applied-changes-render + absent-byte-identity). The Playwright gate runs before
  closeout, not after.

---

## Interfaces produced

### `lib/scene3d/treatments.ts`
- `FINISH_TREATMENT_KINDS = ['foilShimmer', 'opalescence', 'matcapCoat'] as const` — a **fourth**
  treatment family beside masked/edge/buffer.
- `TREATMENT_KINDS = [...MASKED, ...EDGE, ...BUFFER, ...FINISH_TREATMENT_KINDS]` (append finish).
- `type FinishTreatmentKind = typeof FINISH_TREATMENT_KINDS[number]`; folded into `TreatmentKind`.
- `isFinishKind(kind): boolean` (reads the array), beside `isMaskedKind`/`isEdgeKind`/`isBufferKind`.
- Per-kind interfaces (extend `TreatmentBase`), added to the `Treatment` union:
  - `FoilShimmerTreatment { kind:'foilShimmer'; strength; bands; angle; hueShift; gloss }`
  - `OpalescenceTreatment { kind:'opalescence'; strength; frequency; hueShift; angleMix }`
  - `MatcapCoatTreatment { kind:'matcapCoat'; matcap: string; strength }`
- `TREATMENT_LABELS` gains the three (total Record forces it): `foilShimmer:'Foil shimmer'`,
  `opalescence:'Opalescence'`, `matcapCoat:'Matcap coat'`.
- `TREATMENT_DEFAULTS` gains one entry per kind (values below, verbatim).
- `parseTreatment` gains a `case` per kind (clamps below, verbatim).
- **`finishPlan(obj): FinishTreatment[]`** — the enabled, parsed finish treatments on an object in
  stack order (the analogue of `maskedTreatmentPlan` but per-object and material-side, not doc-wide).
- **`canTakeFinish(obj): boolean`** — the ONE eligibility predicate driving both the add-menu
  disable and any guard: `obj.kind === 'primitive'` for S5 (materialFor is the only build path a
  finish is wired through this slice; GLB/text are an explicit follow-up). Mirrors F2's
  `canTakeGeometry` one-predicate rule.

### `lib/scene3d/finishes.ts` (NEW — the finish material injection)
- `export function applyFinish(m: THREE.Material, finishes: FinishTreatment[]): void` — the seam,
  built on the `applyScreen` recipe exactly:
  - early-out if `finishes.length === 0` (⇒ byte-identical: nothing touched);
  - one uniform bag **per finish** held OUTSIDE the closure, stashed on
    `m.userData.finishUniforms = [{ id, kind, u }...]` so `updateFinishUniforms` mutates the same
    objects the compiled program is bound to;
  - snapshot `const baseKey = String(m.customProgramCacheKey())` **eagerly, before** reassigning
    `onBeforeCompile` (the three-cache-key hazard `applyScreen`/`applyVaryTint` document);
  - `const prev = m.onBeforeCompile; m.onBeforeCompile = (shader, r) => { prev.call(m, shader, r);
    for each finish: Object.assign(shader.uniforms, u); prepend PARS/uniform decls to the TOP of the
    fragment string (the varyTint-safe site) and inject each finish BODY at `#include
    <dithering_fragment>` → `FINISH_BODY + '\n#include <dithering_fragment>'` }` — chains `prev`
    first, uses the **terminal** anchor nothing else consumes (base uses `<common>`/
    `<emissivemap_fragment>`, screen uses `<opaque_fragment>`, varyTint uses top-of-string +
    `<color_fragment>`), so a finish composes over ALL of them and over a stacked second finish;
  - a finish reads `gl_FragColor` (display space) plus the built-in varyings `vNormal` /
    `vViewPosition` (present in every lit material; opal already reads exactly these) — **no vertex
    injection, no new varyings**;
  - `m.customProgramCacheKey = () => \`${baseKey}|finish:${finishes.map(f=>f.kind).join(',')}\``.
- `export function updateFinishUniforms(m, finishes): boolean` — returns false (⇒ caller rebuilds)
  when the ordered finish kinds / matcap ids differ from `m.userData.finishUniforms`; otherwise
  writes each finish's uniforms in place and returns true. (matcap id change forces rebuild since it
  swaps the sampled texture — folded into `finishKey`, mirroring `baseIdentityKey`'s matcap case.)
- `finishKey(finishes): string` — `|fin:` + ordered `kind` (+ matcap id for matcapCoat); the rebuild
  boundary, folded into `identityKey`.
- CPU twins (exported, for unit tests): `foilShimmerRGB(...)`, `opalescenceRGB(...)`,
  `matcapCoatUV(normalView) → vec2` mirroring each `_BODY`'s math.
- Matcap coat reuses `getMatcap(id)` / `MATCAP_SPECS` / `MATCAP_IDS` from `materials.ts` (export
  them if not already) as the sampled `uMatcapTex`; the look is a NEW GLSL body (normal→screen-UV
  lookup mixed into `gl_FragColor` at `strength`), because matcap today is a whole separate THREE
  material class with no injectable chunk.

### `lib/scene3d/materials.ts`
- `materialFor(mat, geometry, ownerId, varyStrength?, finishes?: FinishTreatment[])` — new trailing
  param mirroring `varyStrength`; calls `applyFinish(m, finishes ?? [])` **after** `applyVaryTint`
  (finish is the topmost coat). Byte-identical when `finishes` is empty/absent.
- `updateMaterial(m, mat, geometry, varyStrength?, finishes?)` — new trailing param; calls
  `updateFinishUniforms(m, finishes ?? [])` and returns false (rebuild) when it does.
- `identityKey(mat, finishes?)` folds `finishKey(finishes ?? [])`.
- Export `getMatcap` / `MATCAP_IDS` / `MATCAP_SPECS` for the finish shader (matcap coat).

### `lib/scene3d/engine.ts`
- `syncObject`'s three material sites (create ~1108, rebuild ~1221, override ~512 if it applies to
  primitives) pass `finishPlan(obj)` as the new `finishes` arg to `materialFor` / `updateMaterial`.
  A finish add/remove/dial-change flows through the existing update→(rebuild-if-identity-changed)
  path with no new machinery — exactly as a screen dial does.

### `lib/scene3d/treatmentControls.ts`
- `treatmentControls(kind)` gains a `case` per finish kind:
  - `foilShimmer`: sliders strength/bands/angle/hueShift/gloss.
  - `opalescence`: sliders strength/frequency/hueShift/angleMix.
  - `matcapCoat`: a `select` over `MATCAP_IDS` (with `optionLabels` from `MATCAP_SPECS` names —
    sentence case) + a strength slider.
  - Finishes are NOT masked, so the generic trailing `invert` toggle (appended only for
    `isMaskedKind`) is correctly not added.

### `components/vue-canvas/studio/Scene3DTreatmentRow.vue`
- `TREATMENT_ICONS` (total Record — the ONE strict TS2739 guard) gains `foilShimmer`, `opalescence`,
  `matcapCoat` (lucide icons, e.g. `Sparkle`/`Droplet`/`Circle` — implementer picks unused ones).

### `components/vue-canvas/studio/Scene3DObjectRow.vue`
- The "add treatment" menu already iterates `TREATMENT_KINDS`; add a **disabled** state + reason
  title for finish kinds when `!canTakeFinish(obj)` (F2's disabled-entry pattern), so a finish is
  never a dead control on a GLB/text host.

---

## Tasks

### Task 1 · The finish family + `applyFinish` seam + opalescence (the reference finish)
Opalescence is the cleanest port (fragment-only, view/normal driven, reads only built-ins), so it
proves the whole seam.
- `treatments.ts`: `FINISH_TREATMENT_KINDS`, append to `TREATMENT_KINDS`, `FinishTreatmentKind`,
  `isFinishKind`, `OpalescenceTreatment` interface + union, `TREATMENT_LABELS.opalescence`,
  `TREATMENT_DEFAULTS.opalescence`, `parseTreatment` case, `finishPlan`, `canTakeFinish`. (Add the
  `foilShimmer`/`matcapCoat` LABELS/DEFAULTS/interfaces too if the total-Record compile requires all
  three present at once — otherwise Tasks 2/3 add them; implementer resolves against the compiler.)
- `finishes.ts` (new): `applyFinish`, `updateFinishUniforms`, `finishKey`, `OPAL_FINISH_BODY` +
  `opalescenceRGB` CPU twin. Opalescence body ported from `OPAL_FRAG_DECL/BODY` but reading
  `gl_FragColor` at `<dithering_fragment>` and mixing toward the ramp by `strength`.
- `materials.ts`: thread `finishes` through `materialFor` / `updateMaterial` / `identityKey`; call
  `applyFinish` after `applyVaryTint`.
- `engine.ts`: pass `finishPlan(obj)` at the material sites.
- `treatmentControls.ts`: `opalescence` case. `Scene3DTreatmentRow.vue`: opalescence icon.
  `Scene3DObjectRow.vue`: `canTakeFinish` disable.
- **Tests:** CPU-twin unit for `opalescenceRGB`; a unit asserting `applyFinish(m, [])` leaves
  `customProgramCacheKey()` and the injected `onBeforeCompile` source **unchanged** (byte-identity,
  RED first against a stub that injects unconditionally); a source-guard unit (no bare-int GLSL
  operand); a real-canvas A/B on the lab page — an object with no finish is data-URL-equal before/
  after the branch, and adding opalescence changes it.
- **Acceptance:** opalescence renders on a standard-material sphere via `/dev/scene3d-lab?state=`;
  absent ⇒ byte-identical (unit + lab A/B); the row/inspector/add-menu show it; a dial is a motion
  target and agent control by id (assert via `iterateTreatmentControls`).

### Task 2 · Foil shimmer finish
- Registration rhythm for `foilShimmer` (interface/label/default/parse/controls/icon).
- `FOIL_FINISH_BODY` + `foilShimmerRGB` CPU twin, ported from `HOLO_FRAG_DECL/BODY`'s diffraction
  grating but as an ADDITIVE display-space overlay reading `vNormal`/`vViewPosition` and the sun
  (`directionalLights[0]` is index 0 — the engine sun; guard for its presence). It does NOT force
  metalness/roughness (that stays the host material's — the difference from the holographic
  material type; note it for the by-eye pass).
- **Tests:** CPU twin; source-guard; Playwright applied-changes-render (measure changed-pixels vs
  plain, S4's honest metric — NOT a gradient-energy metric) + absent byte-identity; determinism
  (same params identical).
- **Acceptance:** foil shimmer renders and sweeps with camera orbit on a non-metal base; absent ⇒
  byte-identical.

### Task 3 · Matcap coat finish
- Registration rhythm for `matcapCoat` (interface/label/default/parse; controls = matcap-id
  `select` with `optionLabels` + strength; icon).
- Export `getMatcap`/`MATCAP_IDS`/`MATCAP_SPECS` from `materials.ts`; `MATCAP_FINISH_BODY` samples
  `uMatcapTex` at the screen-space UV from `vNormal`/`vViewPosition` (the standard matcap UV) and
  mixes into `gl_FragColor` by `strength`; `matcapCoatUV` CPU twin. matcap id folded into
  `finishKey` (id change rebuilds — swaps the texture uniform).
- **Tests:** CPU-twin UV unit; source-guard; Playwright applied-changes-render + absent
  byte-identity; a matcap-id change actually changes the render (rebuild path).
- **Acceptance:** matcap coat renders over an arbitrary base material; changing the matcap id
  changes it; absent ⇒ byte-identical.

### Task 4 · Whole-slice proofs + copy + agent/motion sweep
- Playwright suite `frontend/tests/scene3d-finishes.spec.ts`: per finish — applied-changes-render,
  absent byte-identity, determinism; a stacked case (opalescence + foil on one object composes);
  the add-menu disables finishes on a GLB host; the tree/breadcrumb flow.
- Unit sweep across the touched specs green; typecheck at baseline.
- Copy sweep: labels/hints sentence case, human names, `optionLabels` on the matcap select;
  `canTakeFinish` reason string on the disabled menu entries.
- Agent/motion: assert `iterateTreatmentControls` emits each finish dial by
  `objects.<id>.treatments.<tid>.<field>` and that the agent needs no colour whitelist (a finish
  colour, if any, is a first-class `color` control).
- **Acceptance:** full finishes Playwright describe green live (fresh harness preview,
  `PW_BASE_URL=http://127.0.0.1:<port>`, NOT the stale shared :3002); whole-slice unit sweep green.

---

## Acceptance (whole slice)
- The three finishes add as treatment rows, render as overlays on a primitive's existing material,
  and are byte-identical when absent (unit cache-key/source assertions + lab real-canvas A/B).
- Every finish dial is a motion target and agent control by stable id.
- Live Playwright describe green against a fresh harness preview; whole-slice unit sweep green;
  typecheck at baseline.
- Light-linking is explicitly OUT (deferred to its own later slice).

## Follow-ups (owed, non-blocking)
- Finishes on GLB / text / SVG hosts (widen `canTakeFinish` + a `syncGlbMaterials` finish path).
- By-eye pass: foil shimmer streak width/fall-off on a non-metal base; opalescence overlay vs the
  pre-lighting material version (display-space overlay reads differently); matcap coat strength.
- Whether foil shimmer should optionally carry metalness/roughness like the holographic material.
