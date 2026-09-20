# Slice F-cap · Compositor agent vocabulary (the "cap slice")  (task-level plan)

> Part of the **Frame Effects Programme** (`docs/superpowers/plans/2026-09-09-frame-effects-programme.md`).
> Closes the four agent-vocabulary follow-ups owed by F5, F6, F7, F8. Julien approved 2026-09-15
> (raise `COMPOSITOR_HINT_CEILING`, teach the deferred vocab in one pass; "run with it"). Executed
> subagent-driven as F1–F8. All paths under `frontend/`.

## Resolved decisions (Julien "run with it", controller's calls 2026-09-15)
- **Shader/backdrop = curated named-look subset** (mosaic precedent), ~6–8 input-sampling looks by word,
  pinned against `effectReadsInput`. NOT full-catalog (~8KB), NOT picker-only.
- **animateDial IS in this slice** (F8 dial-animation was named in the go).
- **Ceiling: measure then round up to next 50** — no pre-guessed constant.
- **Live-agent verification: owed manual/env-gated smoke** (no real model call in CI), like other agent features.

## Goal
Make the compositor AGENT reach the effects F5–F8 shipped UI-only: F7 recipes (risograph/photocopy/
letterpress), F6 backdrop_luminance_mask + backdrop_shader, F5 shader, and F8 dial-animation
("animate the grain from 0 to 50"). All are rejected today for one mechanical reason and blocked by the
full hint budget.

## Mechanism (why rejected today; what unblocks)
`app/lib/agent/surfaces/compositor.ts`: the hint budget is literally the sum of every `CommandSpec.hint`
length (`COMPOSITOR_COMMANDS` :730), measured by the tripwire `compositor-stroke-agent.unit.spec.ts:221`
(`sum ≤ COMPOSITOR_HINT_CEILING`, currently 26250, at ~26,216). `setLayerEffect` dispatch (:1213) gates on
`isEffectKind` (TRUE for all six kinds — they're in EFFECT_ORDER) then falls through the sanitizer ladder
(:1229) to `sanitizePostEffect` (:401), which returns `null` for any kind without a `POST_EFFECT_DEFAULTS`
entry → `{ok:false,'invalid effect'}`. That's why recipes/lum-mask/shader/backdrop are all rejected.
- **Plain-dial unblock (F4 precedent):** F4 pixel styles are agent-drivable because they HAVE
  POST_EFFECT_DEFAULTS (sanitizePostEffect validates them). Recipes + backdrop_luminance_mask are the same
  character; a new schema-driven sanitizer driven by `EFFECT_DIAL_SCHEMA` (`app/lib/compositor/effectDials.ts:51`,
  a TOTAL record with each dial's kind/min/max incl recipe + lum-mask dials) + merge over `createEffect(type)`
  defaults accepts them (number-clamp to [min,max], colour-validate hex, a tiny bool clause for lum-mask.invert).
- **Shader/backdrop (curated looks):** both carry `effectId` (a catalog effect). Precedent: mosaic exposes
  curated "Look" WORDS (mosaicLookNames), not arbitrary ids; Shader Studio's `buildShaderGuidance`
  (`app/lib/shaderstudio/agentControls.ts:319`) enumerates the whole catalog under its own
  `SHADER_GUIDANCE_CEILING=8150` — the expensive full option. We take the curated middle: a small
  `SHADER_LOOK_WORDS: {word,effectId}[]` (new pure `app/lib/compositor/shaderLooks.ts`), each pinned by a
  unit against `effectReadsInput` (`app/lib/shaderfx/catalogStore.ts:50`); speed/seed are plain dials,
  params stay picker-only (the look's catalog defaults show through, like a fresh UI add).
- **Dial-animation (F8 authoring):** a NEW op `animateDial` (NOT a layer-prop extension — motion is a
  frame doc; the F8 reject test pins that setLayerProps refuses a motion patch). Authors into the shipped
  engine via `addDialTrack`+`addKeyframe`+`setTrack` (`app/lib/motion/effectTracks.ts:173/217/254`).

## Global constraints
- **The three tripwires flip together, deliberately** (never loosened to compile): (a)
  `compositor-stroke-agent.unit.spec.ts:221` sum-measure + its F5 shader-reject (:253); (b)
  `agent-compositor-surface.unit.spec.ts:532–550` (F6 backdrop + F7 recipe reject, each asserting `===26250`);
  (c) `effect-tracks-agent-reject.unit.spec.ts:31,34,40` (F8 motion reject + ceiling). Each now-taught kind's
  reject test becomes an ACCEPT test; every `===26250` becomes the new measured constant — same commit as the bump.
- Reuse: `EFFECT_DIAL_SCHEMA`, `addDialTrack`/`addKeyframe`/`setTrack`, `effectReadsInput`. No change to the
  effect kind model, idPath.ts, or the id scheme.
- `CompositorModal.vue` staged BY HUNK via a private `GIT_INDEX_FILE` (ONE bash call; hostile shared index —
  files staged-deleted, foreign boxFit hunks; filter to own hunks, verify owned symbols in HEAD after).
  Most of this slice is the pure `compositor.ts` surface + tests (lower risk); only animateDial's bridge
  touches CompositorModal.vue.
- Hint text is model-facing prose — tight, human, same voice as existing entries. NEVER a subagent dev
  server; controller runs the live gate. Commits end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Tasks
### Task 1 · Recipe + luminance-mask vocabulary (plain-dial, F4 precedent)
`sanitizeSchemaEffect(type,raw,cur)` driven by EFFECT_DIAL_SCHEMA + createEffect defaults (number-clamp,
colour-validate, lum-mask.invert bool clause); wire into the setLayerEffect ladder for risograph/photocopy/
letterpress/backdrop_luminance_mask; extend the setLayerEffect hint (~350 chars). **Tests:** flip the F7
recipe-reject + F6 lum-mask reject to ACCEPT (patch applies, out-of-range clamps to [min,max], colours
validate, unknown fields dropped, in-place edit). **Acceptance:** agent adds/edits all four; reject→accept.

### Task 2 · shader / backdrop_shader curated looks
New pure `shaderLooks.ts` (`SHADER_LOOK_WORDS`, each pinned by a unit against `effectReadsInput`); extend
the sanitizer to accept shader/backdrop_shader with a look word → effectId, speed/seed clamped, params
picker-only; extend the hint (~500–700 chars). **Tests:** flip the F5 shader-reject + F6 backdrop_shader
reject to ACCEPT for a valid look word; an UNKNOWN look stays rejected; a unit asserts every curated word
resolves to an `effectReadsInput`-true id. **Acceptance:** agent adds a shader/backdrop by naming a look;
arbitrary/unknown ids stay rejected.

### Task 3 · The `animateDial` op
Add `motion?: FrameMotion` to `CompositorState` (:55); thread the bridge (getState reads motionDoc.value,
setState persists via setMotion + commitMotionTimeline, CompositorModal.vue :1182/:1192/:3618/:3636). New
`case 'animateDial'`: target=layer id, args {effect,dial,from,to,start?,end?}; resolve effect→instance via
effectStackOf, dial→DialSpec via dialSpecsFor (reject non-animatable), clamp/validate from/to, build the
id-path, author a two-keyframe track (addDialTrack+addKeyframe+setTrack, upsert). New menu entry + hint
(~470 chars). **Tests:** flip effect-tracks-agent-reject — animateDial ACCEPTS → sailor_motion.tracks with
right target + 2 keyframes; setLayerProps/setLayerEffect STILL refuse a smuggled motion patch; unknown/
non-schema dial rejected; "every menu op handled" still passes; author→describe round-trip.
**Acceptance:** "animate the grain from 0 to 50" (as a patch) creates a persisted EffectDialTrack.

### Task 4 · Ceiling bump + flip all three tripwires + whole-slice proofs
MEASURE the new hint sum; set `COMPOSITOR_HINT_CEILING` to it rounded up to next 50; rewrite the constant's
comment (record the raise + that the mosaic hint stays the compression target). Update ALL THREE ceiling
assertions to the new number in this commit. Mocked-plan Playwright (route `/api/agent-plan` like
`agent-fastlane.spec.ts`) applying an animateDial + a recipe plan end-to-end (animateDial round-trips
through save/reload of sailor_motion.tracks). Typecheck baseline; whole-slice unit sweep. **Acceptance:**
units green; the three tripwires flipped together to one new ceiling; mocked-plan Playwright green; owed
live-agent smoke recorded.

## Acceptance (whole slice)
Agent can add/edit F7 recipes + backdrop_luminance_mask by words; shader/backdrop via curated looks;
animateDial authors a track. Ceiling raised once (measured, rounded to next 50); the three tripwires
converted in one commit. Reuses EFFECT_DIAL_SCHEMA / addDialTrack / effectReadsInput.

## Follow-ups (owed)
- The paid/live agent smoke ("make this risograph", "animate the grain 0→50") — manual/env-gated.
- Enum/bool dial animation vocabulary (F8 left stepped dials a follow-up).
- Mosaic hint compression if the raised ceiling runs out.
