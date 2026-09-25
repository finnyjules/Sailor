# AI in Sailor, stage 5: shader generation and My effects

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI can write shader effects in the product:
- **Remix**, **New effect** and **Make one** give three new effects. Each one is written by Opus 5.5, checked, and shown as a tile in the takes strip as soon as it's ready. Hovering a tile previews it on the target, which is the shader node, the Shader studio preview or Frame's background.
- **Keep** saves the take to **My effects**. My effects is a per-user library that every effect picker lists, and the Recipe offers version chips for each effect.
- A price estimate shows before a request runs.
- Projects keep a copy of the My effects they use, and web exports inline them.
- A shader that hangs the graphics card is dropped, and the renderer recovers.

**Architecture:**
- **The model setting.** `shared/shadergen/model.ts` holds `SHADER_GEN_MODEL = { model: 'claude-opus-5-5', effort: 'medium' }`. It's a dedicated setting (spec §7.2), not a change to `AI_TIERS`. `/api/shader-gen` uses it whenever the client sends no `tier`, and the dev-only model override is removed. The per-token price table moves to `shared/pricing/anthropicTokens.ts` so the client can compute the estimate (`shared/pricing/shaderGenEstimate.ts`) from the same numbers the server settles with.
- **The engine** (stage 1, `app/lib/shadergen/engine.ts`) gains `onTake`/`onFailure` callbacks and an `AbortSignal`. The product request (`productRequest.ts`) sends three takes, the user's picture (512 px or smaller), two fixed quality examples, and no review pass.
- **The session.** `composables/useEffectTakes.ts` runs one request against an `EffectTarget`, which can preview an effect id and apply a kept one. It registers each passing take as a *draft* `EffectDef`, turns them into a stage 3 `TakesSession` for `PromptTakes`, and on Keep saves a My effect (or a new version of one) and applies it. `useCanvasPrompt` and `useStudioPrompt` hand the `new-effect` kind to it.
- **My effects.** `shared/myEffects/record.ts` defines the stored record and its validation. It is served by `/api/my-effects` (list, get, save, rename, delete) from a flat JSON store with Stage 6 owner scoping (`ownedJsonStore`), so it works the same locally and hosted. `app/lib/myEffects/defs.ts` expands a record into ordinary `EffectDef`s: one per code version, with `mine`, `from` and `versions`.
- **One live catalog.** `app/lib/shaderfx/catalog.ts` merges My effects into the catalog it fetches and exposes `useShaderCatalog()` (a shared `shallowRef`) plus `registerEffects` / `unregisterEffects`. Pickers, previews, drafts, project copies and exports all read the same list, so a My effect is referenced by id exactly like a built-in.
- **The gallery.** `ShaderEffectGallery.vue` wraps `CatalogModal` and is used by the four shader pickers. It shows the "Make one ✦" card, "Remix ✦" on every card, the My effects section and filter chip, and it lists through one helper, `shaderGalleryItems`.
- **Safety.** `ShaderFxRenderer` handles `webglcontextlost` / `webglcontextrestored` (`lib/shaderfx/contextWatch.ts`). The session drops a draft that was on screen when the context went, and restores the target.

**Tech stack:** Nuxt 4 (Vue 3 + TypeScript + Tailwind), Nitro server routes (`server/api/**`), WebGL2 via `app/lib/shaderfx/renderer.ts`, Vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom opt-in by docblock), Playwright (`tests/*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md`. This is build stage 5 of §9 ("the engine, the store, gallery entry points, versions, and pickers everywhere"). It covers §7.2 (the model decision and the estimate), §7.3, §7.4 and §7.5. Stage 1's engine plan (`docs/superpowers/plans/2026-09-23-ai-in-sailor-stage1-shader-engine.md`) describes the engine this builds on.

**Mockups:** `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/sailor-ask-prototype.html` (285 KB, so grep it):
- `renderGallery` (~char 255 600): the gallery's My effects section, the "Make one ✦" card and "Remix ✦";
- the Recipe (~char 250 800): the name field, "My effect · from …", the quoted request and version chips;
- Keep (~char 282 300): "Saved to My effects as “…”", "Saved as v2 of “…”. Earlier versions are kept."

The prototype says "four takes"; the product makes three.

**Earlier plans, for format and interfaces (assume they land as written):**
- Stage 3: `docs/superpowers/plans/2026-09-24-ai-in-sailor-stage3-results.md`: `useCanvasPrompt`, `PromptTakes`, `takesSession.ts` (`openTakes`, `hoverTile`, `chooseTile`, `failPending`, `shownTakeId`, `CURRENT`, `TAKES_PER_SET`), `canvasDispatch` (`DISPATCH_MESSAGES.newEffect`), `kindForMode` ('Remix' / 'New effect' → `new-effect`), `sailor:promptMode`. At HEAD `8bd6f7578`, `useCanvasPrompt.ts` had landed; `CanvasPromptHost.vue` had not.
- Stage 4: `docs/superpowers/plans/2026-09-25-ai-in-sailor-stage4-studios.md`: `useStudioPrompt` (`setMode`, `runKind`, `STUDIO_PROMPT_KEY`), `studioDispatch` (`STUDIO_MESSAGES.newEffect`), `StudioPromptHost`, `StudioModalShell`'s new props, `studioActions` (`REMIX_ACTION`, the Shader "New layer from a description…" row with mode "New effect"), Shader's `StudioInspectorHead`. None of it had landed at planning time.

**What the code looks like at HEAD** (verified while planning; line numbers drift, so grep):
- **Engine** (`app/lib/shadergen/engine.ts`, 210 lines): `generateTakes(input, deps)` runs `count` (default 4) takes with `Promise.all` and returns only at the end. There is no `onTake` and no abort. A model error ends a take (`break`). `EngineInput.images` and `examples` are commented as dev-only levers. `TAKE_ANGLES` says "Take 1 of 4" and so on (`prompt.ts`).
- **Client** (`app/lib/shadergen/client.ts`): `makeCallModel(apiKey, tier: 'patch' | 'plan', variant?: { effort?: 'high'; model?: 'opus' })` and `makeReview(apiKey)`.
- **Route** (`server/lib/shaderGenRequest.ts`): the tier defaults to `plan`. `model: 'opus'` maps to `DEV_MODEL_OVERRIDES.opus` (`server/lib/aiModels.ts`), but only with `allowModelOverride` (local dev). The call is metered per call by `meterShaderGenCall` (hold `maxCreditsForCall`, settle real usage ×2).
- **Prices** (`server/utils/anthropicPrices.ts`): `claude-opus-5-5` **is already priced** ($4 / $20 per million tokens, cache read 0.2, cache write 5). `tests/unit/anthropic-prices.unit.spec.ts` loops `AI_TIERS` and `DEV_MODEL_OVERRIDES`. `tests/unit/price-graph.unit.spec.ts` forbids re-implementing a markup outside `shared/pricing/` (it allows `server/utils/anthropicPrices.ts` by name).
- **Meter guard** (`tests/unit/anthropic-meter.unit.spec.ts`): every `server/api/**` file that fetches `api.anthropic.com` must name `meterAssist` or one of `TOKEN_METERED = ['holdForModelCall', 'meterShaderGenCall', 'meterRouterCall']`.
- **Catalog:**
  - `app/lib/shaderfx/catalog.ts`: `fetchShaderFxCatalog()` fetches `/sailor/shader_effects` once per page and pushes it into `catalogStore.ts` (`setShaderFxCatalog`, `addShaderFxEffects` (never replaces), `getEffectSync`, `resolveEffectId`, `effectReadsInput`).
  - Each effect carries its GLSL in `source`.
  - `catalogStore.ts` must stay network-free, because embeds import it.
- **`EffectDef`** (`app/lib/shaderfx/types.ts:50`): `{ id, name, category, animated, passes, centerParam, textures, params, source, generative?, followsShape? }`. `toEffectDef(take, id)` (`app/lib/shadergen/effectDef.ts`) gives `category: 'mine'`.
- **The four pickers** each build their own `CatalogModal` items from their own `catalog` ref:

  | Picker | File | Mount | Stores the choice in |
  |---|---|---|---|
  | Shader studio | `ShaderStudioSurface.vue` | ~L1226, **outside** `StudioModalShell`, with `SHADER_SECTIONS` ~L334 | `config.effects[activeEffect].id` |
  | Shader fill | `widgets/ShaderFillEditor.vue` | ~L490 | `ShaderSpec.effectId` |
  | Frame effect stack | `CompositorModal.vue` | ~L10451; items filtered by `effectReadsInput` ~L2702 | `ShaderPixelEffect.effectId` |
  | Shader node | `ShaderEffectNode.vue` | ~L443 | widget `effect` (`setWidget('effect', id)`, then `params` `'{}'`) |

- **`CatalogModal.vue`:**
  - props `items`, `selectedId`, `filters`, `activeFilterId`, `searchQuery`, `sections`, `sectionOf`;
  - slots `#card` (inside a `<button>`, so no nested button fits there), `#detail`, `#footer-hint`, `#actions`.
- **`ShaderFxRenderer`** (`app/lib/shaderfx/renderer.ts`, singleton `shaderFx`) **does not handle context loss**. Scene3D's pattern (`app/lib/scene3d/engine.ts` ~L804, ~L885) is the model: `preventDefault` on lost, then rebuild on restored.
- **Per-user stores:**
  - Nitro `useStorage` is used once, with no mounts configured.
  - The real per-user pattern is Stage 6's flat JSON store: `server/utils/dataDir.ts` `storeDir(name)`, plus `server/utils/ownedJsonStore.ts` (`listOwned`, `guardMutation`, `claimNew`, `releaseRecord`) and `server/utils/resourceOwners.ts` (`RESOURCE_KINDS`, `ownedIds`, `ownerOf`).
  - `event.context.userId` is set by `server/middleware/auth.ts` in hosted mode.
  - Moodboards, brand kits and frame templates all use this pattern. Route tests: `tests/unit/owned-stores-routes.unit.spec.ts`.
- **Routes:** `server/lib/nitroApiPaths.ts` has `NITRO_API_PATHS` (exact) and `NITRO_API_PREFIXES` (a path and its children).
- **Projects:**
  - `app/lib/projectDoc.ts` `ProjectDoc` (the backend never inspects it);
  - `layouts/default.vue` `snapshotActiveCanvasIntoDoc` (~L1679) builds the saved doc;
  - `loadWorkflowForTab` (~L2294–2355) and the session restore (~L1465) bring docs in.
- **Exports:**
  - Frame: `CompositorModal.vue` ~L5231 uses `cat.effects` from `fetchShaderFxCatalog()` for `catalogIds` and `createAppFrameExportIO({ catalog })`.
  - Shader studio: ~L757 filters `catalog.value.effects`.
- **Canvas node toolbar** (`app/lib/canvas/nodeActions.ts`): lists for image, video and audio only. `landsHint`, `actionHint`, and `priceHint` (a fixed string such as "~$0.04").
- **`SailorPrompt.vue`** has no slot or prop for a price note.

Not in this plan:
- **Promote to library** (dev-only, spec §7.4 "later").
- A code editor for My effects.
- Several jobs at once (spec §3.1 "later").
- **Make one / Remix inside Frame's layer fills and effect stack** (Ruling 10).
- Tune and Vary on the canvas shader node (Ruling 11).

## Rulings made while planning

Julien was asleep, so these calls were made without him. Each one is a line he can overturn.

1. **The model setting is shared and fixed.** `SHADER_GEN_MODEL` lives in `shared/shadergen/model.ts` and `server/lib/aiModels.ts` re-exports it.
   - `/api/shader-gen` with no `tier` uses it: Opus 5.5 at effort `medium`. The eval page's `patch`/`plan` comparisons still work.
   - The client can no longer name a model: `DEV_MODEL_OVERRIDES` and `model: 'opus'` are removed, and the eval page's variants B and E now send no tier. The `effort: 'high'` dev lever stays.
2. **The estimate is a formula** over a per-take token envelope. The envelope reproduces §7.2's 25–40¢: **~$0.24–0.42 locally, ~48–88 credits hosted**.
   - It uses the same price table and per-call ×2 the server settles with. The envelope's four numbers are replaced once the owed paid run measures real usage.
   - **Where it shows:**
     - on the Remix…, New effect… and Make one entry points (the grey hint);
     - in the prompt as a note while a Remix / New effect mode chip is set;
     - in the working label.
   - A request the router sends to `new-effect` without a chip runs straight away, because §7.5 says no gate. Its working label names the estimate.
3. **No visual review in the product.** Tiles appear as they pass. A review would have to pull a tile that is already on screen, and Opus scored the same with and without extras (B = E). The engine keeps the option; the eval page still uses it.
4. **Examples are two fixed spike keepers:** rain take 3 and ink take 4 (`SPIKE_TAKES.rain[2]`, `SPIKE_TAKES.ink[3]`), imported lazily so the 44 KB fixture stays out of the main bundle. There are no "closest existing effects" references for a new effect: the decided setup is image plus two examples (§7.2).
5. **The user's picture** (the target's source image) goes to the model as a JPEG whose long edge is 512 px or less. When there is none (a generative effect with no input), a neutral placeholder is used for the checks and no image is sent.
6. **My effects is a flat JSON store**, not Nitro `useStorage`. It uses `storeDir('my-effects')` (`.data/my-effects` locally, under `SAILOR_DATA_DIR` hosted) and the Stage 6 owner registry (`kind: 'my-effect'`). This is the codebase's per-user store: it covers "Nitro storage locally" and "the hosted per-user store" with one implementation. **Hosted lists are strict:** a user sees only records they own. There are no "curated" unowned records, unlike moodboards.
7. **Versions store the shader body, not the assembled source**, so a future preamble or helper fix reaches old effects. Each **code** version is registered as its own `EffectDef`: the newest under the effect's id, and older ones as `<id>~v<N>` with `versionOf`, hidden from pickers. A version chip therefore switches the target's effect id and dial values; it never mutates a shared definition.
8. **What Keep does:**
   - **Remix of a My effect:** adds a code version to it ("Saved as v2 of “…”. Earlier versions are kept.").
   - **Make one, New effect, or Remix of a built-in:** creates a new My effect, with `from` set to the base effect's name.
   - **Tune takes kept on a My effect in the Shader studio:** add a dial version.
   - Dragging a dial by hand never makes a version.
9. **Unkept effect takes are dropped.** Effect takes have no take history (unlike image takes). "Three more" writes three new ones.
10. **Targets this stage:** a canvas shader effect node, the Shader studio's active layer (or a new layer), and Frame's background fill.
    - Frame's layer fills and its effect-stack shader pass list My effects but show **no** Make one or Remix. Frame's prompt has no per-layer effect target yet, so a Remix there would have nothing to preview on.
    - The gallery shows those entry points only when its host passes `can-make`.
11. **The canvas node toolbar** gets Develop → **Remix…** and **New effect…** on shader effect nodes, each "3 takes · ~$0.24–0.42". The price hint is in dollars, like every existing `priceHint`. Vary and Tune… on shader nodes are out: the canvas has no dial worker for them.
12. **Canvas hover previews on the node itself**, not on nodes downstream of it.
13. **The strip's words stay stage 3's** ("Three takes · hover to preview, Keep one"). `takesSession.ts` is under active edit by another session, and one wording everywhere is simpler.
14. **The working label quotes the request** (standing rule) and adds the estimate: `Working on “rain on a window” · ~$0.24–0.42`. That replaces the spec's "Writing three new effects…".
15. **Version chips** show in the Shader studio's Recipe (the inspector head) and in `ShaderFillEditor`; the canvas node shows the name only. The pressed chip is worked out from the target's effect id and values: the newest version that matches both. Nothing extra is stored on the target.
16. **Rename and Remove** live in the Recipe. Remove uses an inline two-step confirm. Projects that use a removed effect keep rendering from their own copy (Ruling 17).
17. **Projects keep a copy.**
    - **Save:** every snapshot writes the used My effects into `ProjectDoc.myEffects`. The scan runs only when the library is non-empty or the doc already carries copies.
    - **Load:** the copies are registered with the catalog. The library's copy wins when it has at least as many versions.
    - A project copy never writes into anyone's library.
18. **Exports read the live catalog** (`currentShaderEffects()`), so My effects inline exactly like built-ins. Frame's export stops using its stale `fetchShaderFxCatalog()` snapshot.
19. **Context loss:**
    - `ShaderFxRenderer` calls `preventDefault` on loss, drops every GL handle, rebuilds lazily after restore, and notifies subscribers.
    - The node and the Shader studio re-render on restore.
    - A draft that was on screen when the context was lost is dropped with a message ("That take stopped the graphics card, so it was dropped."), and the target is restored.
20. **`/api/my-effects` goes in `NITRO_API_PREFIXES`**, not `NITRO_API_PATHS`, because it has `/:id` children. The reachability guard covers both lists.
21. **No new Anthropic route.** `TOKEN_METERED` is unchanged. Task 1 adds a companion check that the default model is priced and that the route is still token-metered.
22. **Limits:** 500 My effects per user, 50 versions per effect, 60-character names, 300-character notes. A body is at most `LIMITS.maxBodyChars`.
23. **The stage 3/4 "not yet" message** for `new-effect` becomes a pointer to where it works: "New effects are made on a shader effect. Select a shader effect node, or open the Shader studio." Canvas and studios share the wording.
24. **Owed, not run:**
    - the paid cost-and-latency measurement (spec §7.2 says "measure at the start of stage 5"). It needs Julien's OK, so it is listed, not planned as a subagent step;
    - a restart of `:3002` so Nitro registers `/api/my-effects`;
    - a real-mouse pass.

## Global Constraints

- **Work in the main checkout** (`/Users/julien/Documents/GitHub/Sailor`), on `main`. No worktree, no branch, never `git stash`. Other sessions share this checkout: leave files you didn't change alone, even if they look broken.
- **Commit only your own paths, through a private index, in two shell calls:**
  1. `cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- <your paths> && git commit -q -m "<msg>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; echo "rc=$? $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"`
  2. Then, in a separate call: `cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <the same paths>`

  To commit a deleted file, use `git rm --cached -q -- <path>` in place of `git add`, inside the same private-index call. Prove the commit by HEAD moving, not by printing HEAD. When running subagent-driven, implementers report paths and test output, and the **controller** commits.
- **Other sessions' hunks in shared files.** Other sessions often edit:
  - `CompositorModal.vue`, `VueNodeCanvas.vue`, `layouts/default.vue` and `ShaderStudioSurface.vue`;
  - `useCanvasPrompt.ts`, `PromptTakes.vue` and `takesSession.ts` (all three had uncommitted edits from another session when this plan was written).

  For these files:
  - **Before your first edit** to any of them, save its diff: `git diff -- <file> > <scratchpad>/<name>.before.patch`.
  - **At commit time**, if that saved patch was non-empty, don't `git add` the whole file. Instead:
    1. build a patch of only your hunks: `git diff -- <file>`, then drop the foreign hunks by hand into `<scratchpad>/mine.patch`;
    2. inside the private-index call, run `git apply --cached <scratchpad>/mine.patch` in place of `git add`.
  - If that is unclear for a hunk, stop and ask the controller.
- **Never run `npm run dev`, `nuxt dev`, or start or kill any server.** The shared dev server on `:3002` belongs to the controller, and **nobody restarts it for this stage**.
  - Implementers write Playwright specs; the controller runs them against `:3002` with **every route mocked** (`/api/prompt-route`, `/api/shader-gen`, `/api/my-effects*`).
  - The new `/api/my-effects` routes won't answer on `:3002` until a restart. That restart is owed (Task 14).
- **Every new Nitro route is listed.** `/api/my-effects` goes in `frontend/server/lib/nitroApiPaths.ts` `NITRO_API_PREFIXES` (it has `/:id` children). The `api-route-reachability` guard only proves anything in the full suite.
- **Anthropic metering.** This stage adds no route that calls Anthropic. If a task finds it needs one, stop and ask. Any new metering helper must be added to `TOKEN_METERED` in `tests/unit/anthropic-meter.unit.spec.ts`, with a companion test asserting the helper itself takes a `holdForModelCall` hold. Any model `/api/shader-gen` can call must be priced in the shared token table (Task 1's guard).
- **Markups live in `shared/pricing/`.** `tests/unit/price-graph.unit.spec.ts` fails on a markup multiply anywhere else. The estimate is computed in `shared/pricing/shaderGenEstimate.ts`.
- **Unit tests:** run `cd frontend && npx vitest run <spec paths>` for your specs, then `npx vitest run` (the whole suite) once before you report. The guard tests (`api-route-reachability`, `anthropic-meter`, `anthropic-prices`, `price-graph`, `single-instruction-prompt`) only prove anything in the full suite.
- **Typecheck:** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "<your file names>"`. The repo has a large standing baseline, so judge only the lines that name your files. Compare against the base commit before calling any error pre-existing (use `git show <BASE>:<path>` into a scratch copy; never `git stash`).
- **No paid model calls during the build.**
  - Unit tests inject fakes (`callModel`, `generate`, `route`, `fetch`). Canned model replies are the spike's hand-written takes: `JSON.stringify(SPIKE_TAKES.rain[i])` from `app/lib/shadergen/__eval__/spikeTakes.ts`.
  - Every Playwright spec mocks `/api/prompt-route`, `/api/shader-gen` and `/api/my-effects*`.
  - The paid measurement is owed (Task 14).
- **The contract and limits are stage 1's** (`shared/shadergen/contract.ts` `LIMITS`, `staticCheck`, `judgeFrames` thresholds). Don't loosen them.
- **Always three takes** (`TAKES_PER_SET` / `SHADER_GEN_TAKES` = 3), never four.
- **Nodes never move when takes open.** The canvas may pan to reveal a target; it never moves nodes.
- **UI copy:**
  - sentence case, and no internal identifiers or kind names ("new-effect", "mine_", "draft" never appear on screen);
  - labels quote the user's own content (the effect's own name, the node's own title), never a guessed role.
- **Pastel means AI.** Every AI mark is `components/prompt/AiMark.vue` `kind="star"`: never lucide `Sparkles`, and never a grey ✦ glyph. Chips, tiles, cards and buttons are neutral.
- **The prompt's look is fixed by spec §2.1a.** Only `SailorPrompt` draws the prompt; hosts pass props and put cards in its `above` slot.
- **A component's leading template comment goes inside its root element.** A leading comment makes the component a fragment in dev, and a parent reading `$el` breaks.
- **No exports with commas in trailing comments on `export const` lines** in server files. mlly's export scanner splits on them (see `priceBook.ts`).

## File structure

| File | Responsibility |
|---|---|
| `frontend/shared/shadergen/model.ts` | `SHADER_GEN_MODEL`, `SHADER_GEN_TAKES` — the dedicated setting (Task 1) |
| `frontend/shared/pricing/anthropicTokens.ts` | Token price table, `ASSIST_MARKUP`, `anthropicCallCredits` (moved from the server) (Task 1) |
| `frontend/shared/pricing/shaderGenEstimate.ts` | `SHADER_GEN_ENVELOPE`, `estimateShaderGen()` (Task 1) |
| `frontend/app/lib/shadergen/estimate.ts` | `shaderGenEstimateText(hosted)` (Task 1) |
| `frontend/app/lib/shadergen/productRequest.ts` | The product's engine input: picture, examples, base, three takes (Task 2) |
| `frontend/shared/myEffects/record.ts` | `MyEffectRecord`, validation, ids, limits (Task 3) |
| `frontend/app/lib/myEffects/defs.ts` | Record ⇄ `EffectDef`s, versions, active version (Task 3) |
| `frontend/server/utils/myEffectsStore.ts` + `frontend/server/api/my-effects/*` | The per-user store and its five routes (Task 4) |
| `frontend/app/lib/myEffects/client.ts`, `library.ts`; `frontend/app/composables/useMyEffects.ts` | Client calls, the loaded library, save / version / rename / remove / adopt (Task 5) |
| `frontend/app/lib/shaderfx/catalog.ts` (modify), `gallery.ts` | Live catalog with My effects; `shaderGalleryItems` / filters / sections (Task 5) |
| `frontend/app/lib/shaderfx/contextWatch.ts` | Context lost/restored handling for `ShaderFxRenderer` (Task 6) |
| `frontend/app/composables/useEffectTakes.ts` | One shader-gen session against an `EffectTarget` (Task 7) |
| `frontend/app/components/vue-canvas/ShaderEffectGallery.vue` | The shared effect gallery (Task 10) |
| `frontend/app/components/vue-canvas/MyEffectRecipe.vue` | Name, origin, versions, remove (Task 11) |
| `frontend/app/lib/myEffects/projectCopy.ts` | Copies in `ProjectDoc`, adopt on load (Task 12) |
| `frontend/tests/shader-gen.spec.ts` | Playwright, all routes mocked (Task 13) |

---

### Task 1: The shader-generation model setting, and the estimate

**Files:**
- Create: `frontend/shared/shadergen/model.ts`
- Create: `frontend/shared/pricing/anthropicTokens.ts`
- Create: `frontend/shared/pricing/shaderGenEstimate.ts`
- Create: `frontend/app/lib/shadergen/estimate.ts`
- Modify: `frontend/server/utils/anthropicPrices.ts` (import the table, markup and per-call credits from shared; keep every export name)
- Modify: `frontend/server/lib/aiModels.ts` (remove `DEV_MODEL_OVERRIDES`; re-export `SHADER_GEN_MODEL`)
- Modify: `frontend/server/lib/shaderGenRequest.ts`, `frontend/server/api/shader-gen.post.ts`
- Modify: `frontend/app/lib/shadergen/client.ts`, `frontend/app/pages/dev/shader-gen-eval.vue`
- Test: `frontend/tests/unit/shadergen-estimate.unit.spec.ts` (new); update `frontend/tests/unit/shadergen-request.unit.spec.ts`, `frontend/tests/unit/anthropic-prices.unit.spec.ts`

**Interfaces:**
- Produces:
  - `SHADER_GEN_MODEL: { readonly model: 'claude-opus-5-5'; readonly effort: 'medium' }`, `SHADER_GEN_TAKES = 3` (`~~/shared/shadergen/model`)
  - `ANTHROPIC_USD_PER_MTOK`, `AnthropicTokenPrice`, `ASSIST_MARKUP`, `anthropicCallCredits(usd: number): number` (`~~/shared/pricing/anthropicTokens`)
  - `SHADER_GEN_ENVELOPE`, `interface ShaderGenEstimate { usd: [number, number]; credits: [number, number] }`, `estimateShaderGen(takes?: number): ShaderGenEstimate` (`~~/shared/pricing/shaderGenEstimate`)
  - `shaderGenEstimateText(hosted: boolean, e?: ShaderGenEstimate): string` (`~/lib/shadergen/estimate`)
  - `makeCallModel(apiKey: string, tier: 'patch' | 'plan' | 'shader', variant?: { effort?: 'high' }): EngineDeps['callModel']`. `'shader'` sends no tier.
  - `buildShaderGenPayload(body)`, which no longer takes `opts`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/shadergen-estimate.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { SHADER_GEN_MODEL, SHADER_GEN_TAKES } from '~~/shared/shadergen/model'
import { ANTHROPIC_USD_PER_MTOK, anthropicCallCredits } from '~~/shared/pricing/anthropicTokens'
import { estimateShaderGen, SHADER_GEN_ENVELOPE } from '~~/shared/pricing/shaderGenEstimate'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import * as serverPrices from '../../server/utils/anthropicPrices'

describe('shader generation setting', () => {
  it('is Opus 5.5 at medium effort, three takes (spec §7.2)', () => {
    expect(SHADER_GEN_MODEL).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(SHADER_GEN_TAKES).toBe(3)
  })
  it('is priced in the one shared table the server settles with', () => {
    expect(ANTHROPIC_USD_PER_MTOK[SHADER_GEN_MODEL.model]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(serverPrices.ANTHROPIC_USD_PER_MTOK).toBe(ANTHROPIC_USD_PER_MTOK)
    expect(serverPrices.creditsForUsd).toBe(anthropicCallCredits)
  })
})

describe('estimateShaderGen', () => {
  it('reproduces spec §7.2’s 25–40¢ from the token envelope', () => {
    const e = estimateShaderGen()
    expect(e.usd[0]).toBeCloseTo(0.24, 4)   // 3 × (5k in × $4 + 3k out × $20) / 1M
    expect(e.usd[1]).toBeCloseTo(0.4212, 4) // 3 × 1.3 × (7k × $4 + 4k × $20) / 1M
    expect(e.credits).toEqual([48, 88])     // per call ×2, rounded up per call; 4 calls at the top end
  })
  it('scales with the take count', () => {
    expect(estimateShaderGen(1).usd[0]).toBeCloseTo(0.08, 4)
  })
  it('has an envelope of plain numbers (replaced after the owed measurement)', () => {
    expect(SHADER_GEN_ENVELOPE.inputTokens).toEqual([5000, 7000])
    expect(SHADER_GEN_ENVELOPE.outputTokens).toEqual([3000, 4000])
  })
})

describe('shaderGenEstimateText', () => {
  it('dollars locally, credits hosted', () => {
    expect(shaderGenEstimateText(false)).toBe('~$0.24–0.42')
    expect(shaderGenEstimateText(true)).toBe('~48–88 cr')
  })
})
```

In `tests/unit/shadergen-request.unit.spec.ts`:
- replace the `DEV_MODEL_OVERRIDES` / `model: 'opus'` cases with the cases below;
- keep every other case;
- drop the `{ allowModelOverride }` second argument wherever it appears.

```ts
  it('with no tier, uses the shader-generation setting (Opus 5.5, effort medium)', () => {
    const p = buildShaderGenPayload({ prompt: 'x' }) as any
    expect(p.model).toBe(SHADER_GEN_MODEL.model)
    expect(p.output_config.effort).toBe('medium')
  })
  it('an explicit tier still picks that tier (the eval page’s comparisons)', () => {
    expect((buildShaderGenPayload({ prompt: 'x', tier: 'plan' }) as any).model).toBe(AI_TIERS.plan)
    expect((buildShaderGenPayload({ prompt: 'x', tier: 'patch' }) as any).output_config.effort).toBeUndefined()
  })
  it('effort high is the one dev lever, on the shader setting too', () => {
    expect((buildShaderGenPayload({ prompt: 'x', effort: 'high' }) as any).output_config.effort).toBe('high')
  })
  it('a client can never choose a model', () => {
    expect(() => buildShaderGenPayload({ prompt: 'x', model: 'opus' })).toThrowError(/model/)
  })
```

In `tests/unit/anthropic-prices.unit.spec.ts`, change the import and the loop to `[...Object.values(AI_TIERS), SHADER_GEN_MODEL.model]` (import `SHADER_GEN_MODEL` from `../../server/lib/aiModels`).

In `tests/unit/anthropic-meter.unit.spec.ts`, add the companion check (Ruling 21) next to the existing shader-gen cases:

```ts
  it('shader-gen’s default model is the priced shader-generation setting', async () => {
    const { buildShaderGenPayload } = await import('../../server/lib/shaderGenRequest')
    const { maxCreditsForCall } = await import('../../server/utils/anthropicPrices')
    const p = buildShaderGenPayload({ prompt: 'x' }) as any
    expect(maxCreditsForCall(p.model, 1, 1, 10_000)).not.toBeNull()
  })
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/shadergen-estimate.unit.spec.ts tests/unit/shadergen-request.unit.spec.ts tests/unit/anthropic-prices.unit.spec.ts tests/unit/anthropic-meter.unit.spec.ts`
Expected: FAIL (missing modules; `model: 'opus'` still accepted).

- [ ] **Step 3: Implement**

```ts
// frontend/shared/shadergen/model.ts
/** The dedicated shader-generation setting (AI in Sailor spec §7.2, decided
 *  2026-09-24): Opus 5.5 writes the shaders at effort medium, three takes per
 *  request. A setting of its own, NOT an AI_TIERS entry — the `campaign` tier
 *  other features use is unchanged. Shared so the server's payload and the
 *  client's estimate read the same model. */
export const SHADER_GEN_MODEL = { model: 'claude-opus-5-5', effort: 'medium' } as const
export const SHADER_GEN_TAKES = 3
```

```ts
// frontend/shared/pricing/anthropicTokens.ts
/**
 * Per-token prices for Anthropic calls metered from their REAL usage
 * (/api/shader-gen, /api/prompt-route). Moved here from
 * server/utils/anthropicPrices.ts so the client's shader-generation estimate
 * reads the numbers the server settles with. Anthropic list prices (USD per
 * million tokens), cached 2026-06-24; Opus 5.5 at its launch price.
 * `cacheWrite` is the 5-minute ephemeral rate (1.25× input).
 * Policy: 1 credit = $0.01, each call charged at 2× Sailor's cost.
 */
export interface AnthropicTokenPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

export const ANTHROPIC_USD_PER_MTOK: Record<string, AnthropicTokenPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export const ASSIST_MARKUP = 2

/** One call's USD cost → integer credits at the markup. Never zero for a real
 *  call; the epsilon keeps an exact number of cents from rounding up on float noise. */
export function anthropicCallCredits(usd: number): number {
  return Math.max(1, Math.ceil(usd * ASSIST_MARKUP * 100 - 1e-9))
}
```

```ts
// frontend/shared/pricing/shaderGenEstimate.ts
/**
 * The estimate shown BEFORE a shader-generation request runs (spec §7.2).
 * A request is SHADER_GEN_TAKES parallel takes, each one call plus the odd
 * repair; every call is metered on its own (hold, then settle real usage ×2).
 * The envelope is per take and reproduces the spec's 25–40¢ until the stage 5
 * paid measurement (owed) replaces these four numbers with measured ones.
 */
import { SHADER_GEN_MODEL, SHADER_GEN_TAKES } from '../shadergen/model'
import { ANTHROPIC_USD_PER_MTOK, anthropicCallCredits } from './anthropicTokens'

export const SHADER_GEN_ENVELOPE = {
  inputTokens: [5000, 7000],
  outputTokens: [3000, 4000],
  /** calls per take: 1 at best; 1.3 with typical repairs (spec §7.2) */
  callsPerTake: [1, 1.3],
} as const

export interface ShaderGenEstimate { usd: [number, number]; credits: [number, number] }

export function estimateShaderGen(takes: number = SHADER_GEN_TAKES): ShaderGenEstimate {
  const p = ANTHROPIC_USD_PER_MTOK[SHADER_GEN_MODEL.model]!
  const perCall = (i: 0 | 1) => (SHADER_GEN_ENVELOPE.inputTokens[i] * p.input + SHADER_GEN_ENVELOPE.outputTokens[i] * p.output) / 1_000_000
  const calls = (i: 0 | 1) => takes * SHADER_GEN_ENVELOPE.callsPerTake[i]
  return {
    usd: [perCall(0) * calls(0), perCall(1) * calls(1)],
    credits: [Math.ceil(calls(0)) * anthropicCallCredits(perCall(0)), Math.ceil(calls(1)) * anthropicCallCredits(perCall(1))],
  }
}
```

```ts
// frontend/app/lib/shadergen/estimate.ts
import { estimateShaderGen, type ShaderGenEstimate } from '~~/shared/pricing/shaderGenEstimate'

/** "~$0.24–0.42" locally (the operator's own spend), "~48–88 cr" hosted. */
export function shaderGenEstimateText(hosted: boolean, e: ShaderGenEstimate = estimateShaderGen()): string {
  return hosted ? `~${e.credits[0]}–${e.credits[1]} cr` : `~$${e.usd[0].toFixed(2)}–${e.usd[1].toFixed(2)}`
}
```

**`server/utils/anthropicPrices.ts`:**
- delete the local `AnthropicTokenPrice`, `ANTHROPIC_USD_PER_MTOK`, `ASSIST_MARKUP` and `creditsForUsd` definitions;
- replace them with `import { ANTHROPIC_USD_PER_MTOK, ASSIST_MARKUP, anthropicCallCredits, type AnthropicTokenPrice } from '../../shared/pricing/anthropicTokens'` and `export { ANTHROPIC_USD_PER_MTOK, ASSIST_MARKUP, type AnthropicTokenPrice }`, plus `export const creditsForUsd = anthropicCallCredits`;
- keep `usdForUsage` and `maxCreditsForCall`, both now using the imported table and `creditsForUsd`;
- keep the file's `ALLOWED` entry in `price-graph.unit.spec.ts` as it is: it's harmless, and the file no longer multiplies by a markup.

**`server/lib/aiModels.ts`:** delete `DEV_MODEL_OVERRIDES` and its comment. Add `export { SHADER_GEN_MODEL } from '../../shared/shadergen/model'`.

**`server/lib/shaderGenRequest.ts`**, `buildShaderGenPayload(body)` (drop `BuildShaderGenOpts` and the `forbidden` helper):

```ts
  const prompt = requireString(body?.prompt, 'prompt', SHADERGEN_MAX_PROMPT_CHARS)
  // No tier: the product's shader-generation setting. A tier: the eval page's comparisons.
  const tier = optionalTier(body?.tier)
  let model: string = tier ? modelForTier(tier) : SHADER_GEN_MODEL.model
  let effort: AiEffort | undefined = tier ? effortForTier(tier) : SHADER_GEN_MODEL.effort
  if (body?.effort !== undefined && body.effort !== null) {
    if (tier === 'patch') throw badRequest("effort can't be set on the patch tier")
    if (body.effort !== 'high') throw badRequest("effort must be 'high' when set")
    effort = 'high'
  }
  if (body?.model !== undefined && body.model !== null) throw badRequest('model can’t be chosen by the client')
```

Keep the images and return blocks unchanged. Update the doc comment: the product sends no tier.

**`server/api/shader-gen.post.ts`:** call `buildShaderGenPayload(body ?? {})`. Drop the `deployMode` import and the override comment. Update the header comment: "three parallel takes (the shader-generation setting)".

**`app/lib/shadergen/client.ts`:**

```ts
export function makeCallModel(apiKey: string, tier: 'patch' | 'plan' | 'shader', variant?: { effort?: 'high' }): EngineDeps['callModel'] {
  return async (prompt: string, images?: string[], signal?: AbortSignal) => {
    const res = await $fetch<{ text: string; usage: ModelUsage | null; stop_reason?: string | null }>('/api/shader-gen', {
      method: 'POST',
      body: { apiKey, ...(tier === 'shader' ? {} : { tier }), prompt, ...variant, ...(images?.length ? { images } : {}) },
      timeout: 120_000,
      signal,
    })
    return { text: res.text, usage: res.usage ?? undefined, stop_reason: res.stop_reason ?? null }
  }
}
```

The third `signal` parameter is typed in Task 2's `EngineDeps`; until then, TypeScript accepts the extra parameter.

**`pages/dev/shader-gen-eval.vue`:** variants B and E call `makeCallModel(apiKey.value, 'shader', { effort: 'high' })`. Update the variant labels that say "Opus 5.5" so they still read correctly: "Opus 5.5 (the product setting), effort high".

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`. `price-graph`, `anthropic-*`, `shadergen-*` and `aimodels-effort` must be green. Grep for any other `DEV_MODEL_OVERRIDES` or `allowModelOverride` user and fix it.
- Typecheck the touched files.
- Commit the paths.
- Message: `feat(shadergen): a dedicated shader-generation setting (Opus 5.5, effort medium) and a cost estimate from the shared token prices`

---

### Task 2: The engine gives takes one by one, stops, and builds the product request

**Files:**
- Modify: `frontend/app/lib/shadergen/engine.ts`
- Modify: `frontend/app/lib/shadergen/prompt.ts` (`TAKE_ANGLES` wording)
- Create: `frontend/app/lib/shadergen/productRequest.ts`
- Test: `frontend/tests/unit/shadergen-engine-stream.unit.spec.ts`, `frontend/tests/unit/shadergen-product-request.unit.spec.ts` (new); update `frontend/tests/unit/shadergen-prompt.unit.spec.ts` if it pins "of 4"

**Interfaces:**
- Consumes: Task 1 `SHADER_GEN_TAKES`; `GenTake`, `GenParam` (contract); `EffectDef` (types); `SPIKE_TAKES` (lazy).
- Produces:
  - `EngineDeps.callModel(prompt: string, images?: string[], signal?: AbortSignal)`
  - `EngineDeps.onTake?: (t: EngineTake, slot: number) => void`, which fires as each take passes, in arrival order. `slot` is its take angle, 0-based.
  - `EngineDeps.onFailure?: (slot: number) => void`, which fires when a slot gives up.
  - `EngineInput.signal?: AbortSignal`. When aborted, `generateTakes` rejects with `DOMException('Stopped', 'AbortError')`.
  - `isAbortError(e: unknown): boolean`
  - from `productRequest.ts`:
    - `PRODUCT_IMAGE_EDGE = 512`
    - `imageForModel(src: CanvasImageSource | null): string | null`
    - `placeholderSource(): HTMLCanvasElement`
    - `baseFromEffect(def: EffectDef | null): GenBase | null`
    - `productExamples(): Promise<NonNullable<GenRequest['examples']>>`
    - `productEngineInput(o: { request: string; base: EffectDef | null; image: string | null; signal?: AbortSignal }): Promise<EngineInput>`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/shadergen-engine-stream.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { generateTakes, isAbortError, type EngineDeps, type TakeRenderer } from '~/lib/shadergen/engine'
import { TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const renderer: TakeRenderer = { compile: () => null, judge: () => ({ pass: true, flags: [], thumbnail: 'data:thumb' }), sheet: () => 'data:sheet' }
const slotOf = (prompt: string) => TAKE_ANGLES.findIndex(a => prompt.includes(a))
/** The spike's hand-written takes as canned model replies; slot i answers after delays[i] ms. */
function canned(delays: number[]): EngineDeps['callModel'] {
  return vi.fn(async (prompt: string, _images?: string[], signal?: AbortSignal) => {
    const slot = slotOf(prompt)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, delays[slot] ?? 0)
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')) })
    })
    return { text: JSON.stringify(SPIKE_TAKES.rain![slot]), usage: { input_tokens: 5000, output_tokens: 3000 } }
  })
}

describe('generateTakes streams takes as they pass', () => {
  it('calls onTake in arrival order with each take’s slot', async () => {
    const seen: number[] = []
    const r = await generateTakes({ request: 'rain on a window', count: 3 }, {
      callModel: canned([30, 5, 15]), renderer, onTake: (_t, slot) => seen.push(slot),
    })
    expect(seen).toEqual([1, 2, 0])
    expect(r.takes).toHaveLength(3)
  })

  it('a slot that gives up reports onFailure', async () => {
    const fails: number[] = []
    const callModel = vi.fn(async (prompt: string) => (slotOf(prompt) === 2
      ? { text: 'not json' }
      : { text: JSON.stringify(SPIKE_TAKES.rain![slotOf(prompt)]) }))
    const r = await generateTakes({ request: 'x', count: 3 }, { callModel, renderer, onFailure: s => fails.push(s) })
    expect(fails).toEqual([2])
    expect(r.takes).toHaveLength(2)
  })

  it('an aborted request rejects with AbortError and stops calling the model', async () => {
    const ctrl = new AbortController()
    const callModel = canned([50, 50, 50])
    const p = generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })
    setTimeout(() => ctrl.abort(), 10)
    const err = await p.catch(e => e)
    expect(isAbortError(err)).toBe(true)
    expect((callModel as any).mock.calls.length).toBe(3) // no repair calls after the abort
  })

  it('an already-aborted signal never calls the model', async () => {
    const ctrl = new AbortController(); ctrl.abort()
    const callModel = canned([0, 0, 0])
    await expect(generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })).rejects.toSatisfy(isAbortError)
    expect(callModel).not.toHaveBeenCalled()
  })

  it('passes the signal to callModel', async () => {
    const ctrl = new AbortController()
    const callModel = canned([0, 0, 0])
    await generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })
    expect((callModel as any).mock.calls[0][2]).toBe(ctrl.signal)
  })
})

describe('take angles', () => {
  it('don’t say "of 4" (the product asks for three)', () => {
    for (const a of TAKE_ANGLES) expect(a).not.toMatch(/of \d/)
  })
})
```

```ts
// frontend/tests/unit/shadergen-product-request.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { baseFromEffect, productEngineInput, productExamples } from '~/lib/shadergen/productRequest'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import type { EffectDef } from '~/lib/shaderfx/types'

const def = (over: Partial<EffectDef> = {}): EffectDef => ({
  id: 'water_ripple', name: 'Water ripple', category: 'distortion', animated: true, passes: 1, centerParam: null, textures: [],
  source: '#version 300 es\nvoid main(){}', params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, default: 0.5 },
    { uniform: 'u_ramp', label: 'Ramp', type: 'gradient', default: [] as any },
  ], ...over,
})

describe('product request (spec §7.2 decision)', () => {
  it('three takes, the picture, two fixed examples, no review lever', async () => {
    const input = await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,AAA' })
    expect(input.count).toBe(3)
    expect(input.images).toEqual(['data:image/jpeg;base64,AAA'])
    expect(input.examples).toHaveLength(2)
    expect(input.revise).toBeFalsy()
    expect(input.references).toBeUndefined()
  })
  it('no picture → no images', async () => {
    expect((await productEngineInput({ request: 'rain', base: null, image: null })).images).toBeUndefined()
  })
  it('examples are rain take 3 and ink take 4', async () => {
    const ex = await productExamples()
    expect(ex.map(e => e.take)).toEqual([SPIKE_TAKES.rain![2], SPIKE_TAKES.ink![3]])
  })
  it('a remix base keeps only the dial types the contract knows', () => {
    const b = baseFromEffect(def())!
    expect(b.name).toBe('Water ripple')
    expect(b.params.map(p => p.uniform)).toEqual(['u_amount'])
  })
  it('a draft or no effect is no base', () => {
    expect(baseFromEffect(null)).toBeNull()
    expect(baseFromEffect(def({ draft: true } as any))).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/shadergen-engine-stream.unit.spec.ts tests/unit/shadergen-product-request.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`prompt.ts`:** `TAKE_ANGLES` becomes `'Take 1: the most direct, literal reading of the request.'`, `'Take 2: a bolder, more stylised reading.'`, `'Take 3: a restrained reading that keeps the image easy to read.'` and `'Take 4: an unexpected interpretation that still clearly answers the request.'`. Keep four angles, so the eval page's four takes still differ.

**`engine.ts`:**

```ts
export interface EngineDeps {
  callModel(prompt: string, images?: string[], signal?: AbortSignal): Promise<{ text: string; usage?: ModelUsage; stop_reason?: string | null }>
  review?(sheet: string, request: string, count: number): Promise<boolean[]>
  renderer: TakeRenderer
  now?: () => number
  /** A take passed every check — in arrival order; `slot` is its take angle (0-based). */
  onTake?: (t: EngineTake, slot: number) => void
  /** A slot gave up (no take is coming from it). */
  onFailure?: (slot: number) => void
}
// EngineInput gains:
  /** Stop: in-flight calls are aborted and generateTakes rejects with an AbortError. */
  signal?: AbortSignal

export const isAbortError = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError'
const aborted = () => new DOMException('Stopped', 'AbortError')
```

Also:
- Update the doc comments on `images` and `examples`. They are now the product's inputs as well (spec §7.2 decision), not dev-only; `revise` stays dev-only.
- In `runTake`:
  - at the top of the `while` loop: `if (input.signal?.aborted) throw aborted()`;
  - pass the signal: `res = await deps.callModel(prompt, input.images, input.signal)`;
  - in its `catch`, first line: `if (input.signal?.aborted || isAbortError(e)) throw aborted()` (before the `ContextLostError` check).
  - `tryRevise` passes the signal the same way.
- In `generateTakes`:

```ts
  if (input.signal?.aborted) throw aborted()
  const report = (r: EngineTake | EngineFailure, slot: number) => {
    if (isTake(r)) deps.onTake?.(r, slot)
    else deps.onFailure?.(slot)
    return r
  }
  const first = await Promise.all(Array.from({ length: count }, (_, i) => runTake(input, i, deps, usage).then(r => report(r, i))))
```

Replacements after a review are reported the same way, `.then(r => report(r, indexOf.get(t)!))`. The product never passes `review` (Ruling 3). Keep `count` defaulting to 4, for the eval page.

**`productRequest.ts`:**

```ts
/** The product's shader-generation request (spec §7.2, decided 2026-09-24):
 *  three takes, the user's picture, two fixed quality examples, no revise and
 *  (by the caller) no visual review. */
import type { GenParam } from '~~/shared/shadergen/contract'
import { SHADER_GEN_TAKES } from '~~/shared/shadergen/model'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { EngineInput } from './engine'
import type { GenBase, GenRequest } from './prompt'

export const PRODUCT_IMAGE_EDGE = 512
const CONTRACT_TYPES = new Set(['float', 'enum', 'color'])

/** A JPEG data URL of the picture, long edge ≤ 512 px; null when there is none. */
export function imageForModel(src: CanvasImageSource | null): string | null {
  if (!src) return null
  const w = (src as any).naturalWidth ?? (src as any).videoWidth ?? (src as any).width
  const h = (src as any).naturalHeight ?? (src as any).videoHeight ?? (src as any).height
  if (!w || !h) return null
  const k = Math.min(1, PRODUCT_IMAGE_EDGE / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, c.width, c.height)
  try { return c.toDataURL('image/jpeg', 0.85) } catch { return null } // a tainted canvas
}

let placeholder: HTMLCanvasElement | null = null
/** A soft neutral gradient to judge takes on when the target has no picture. */
export function placeholderSource(): HTMLCanvasElement {
  if (placeholder) return placeholder
  const c = document.createElement('canvas'); c.width = 256; c.height = 256
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 256, 256)
    g.addColorStop(0, '#3a4a5c'); g.addColorStop(0.5, '#c9a27a'); g.addColorStop(1, '#1f2a36')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256)
  }
  return (placeholder = c)
}

export function baseFromEffect(def: EffectDef | null): GenBase | null {
  if (!def || (def as any).draft) return null
  return { name: def.name, source: def.source, params: def.params.filter(p => CONTRACT_TYPES.has(p.type)) as unknown as GenParam[] }
}

export async function productExamples(): Promise<NonNullable<GenRequest['examples']>> {
  const [{ SPIKE_TAKES }, { EVAL_REQUESTS }] = await Promise.all([import('./__eval__/spikeTakes'), import('./__eval__/requests')])
  const promptFor = (k: string) => EVAL_REQUESTS.find(r => r.key === k)?.prompt ?? k
  return [
    { name: 'rain', request: promptFor('rain'), take: SPIKE_TAKES.rain![2]! },
    { name: 'ink', request: promptFor('ink'), take: SPIKE_TAKES.ink![3]! },
  ]
}

export async function productEngineInput(o: { request: string; base: EffectDef | null; image: string | null; signal?: AbortSignal }): Promise<EngineInput> {
  return {
    request: o.request,
    base: baseFromEffect(o.base),
    count: SHADER_GEN_TAKES,
    images: o.image ? [o.image] : undefined,
    examples: await productExamples(),
    signal: o.signal,
  }
}
```

`EffectDef.draft` is added in Task 3. The test casts `as any` until then; after Task 3, `(def as any).draft` becomes `def.draft`.

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command plus `npx vitest run tests/unit/shadergen-engine.unit.spec.ts tests/unit/shadergen-prompt.unit.spec.ts`. Expected: PASS. Fix any test that pinned "Take 1 of 4" to the new wording.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck `engine.ts`, `productRequest.ts`, `client.ts` and `shader-gen-eval.vue`.
- Commit.
- Message: `feat(shadergen): takes arrive one by one, Stop aborts the request, and the product request (three takes, picture, two examples)`

---

### Task 3: My effects — the record, versions and definitions (pure)

**Files:**
- Create: `frontend/shared/myEffects/record.ts`
- Create: `frontend/app/lib/myEffects/defs.ts`
- Modify: `frontend/app/lib/shaderfx/types.ts` (`EffectDef` gains optional fields)
- Test: `frontend/tests/unit/my-effects-record.unit.spec.ts`, `frontend/tests/unit/my-effects-defs.unit.spec.ts`

**Interfaces:**
- Consumes: `GenTake`, `GenParam`, `LIMITS`, `assembleSource` (contract); `ParamValue`, `EffectDef`, `EffectParamDef` (types).
- Produces (shared):
  - `MY_EFFECT_ID_RE = /^mine_[a-z0-9]{12}$/`
  - `MY_EFFECT_LIMITS = { maxEffects: 500, maxVersions: 50, maxNameChars: 60, maxNoteChars: 300 }`
  - `type MyEffectValue = number | string`
  - `interface MyEffectVersion { label: string; body?: string; params?: GenParam[]; values: Record<string, MyEffectValue>; note: string; createdAt: string }`
  - `interface MyEffectRecord { id: string; name: string; from: string | null; animated: boolean; generative: boolean; createdAt: string; updatedAt: string; versions: MyEffectVersion[] }`
  - `newMyEffectId(rand?: () => number): string`
  - `validateMyEffect(x: unknown): MyEffectRecord`, which throws `Error` with a plain message
  - `cleanName(s: string): string`
- Produces (app, `~/lib/myEffects/defs`):
  - `codeIndexFor(rec, i): number`, the index of the newest version at or before `i` that has a `body`
  - `effectIdForVersion(rec, i): string`
  - `valuesForVersion(rec, i): Record<string, ParamValue>`
  - `expandMyEffect(rec): EffectDef[]`
  - `myEffectIdOf(effectId: string): string | null`, the record id from `mine_x` or `mine_x~v2`; null otherwise
  - `activeVersionIndex(rec, effectId, values): number | null`
  - `recordFromTake(take: GenTake, o: { id: string; request: string; from: string | null; now: string }): MyEffectRecord`
  - `withCodeVersion(rec, take, o: { request: string; now: string }): MyEffectRecord`
  - `withValuesVersion(rec, values, o: { request: string; now: string }): MyEffectRecord | null`, which is null when nothing changed
  - `isPickable(def: EffectDef): boolean`
- `EffectDef` gains (all optional):
  - `mine?: boolean`
  - `from?: string | null`
  - `versions?: { label: string; note: string; effectId: string; values: Record<string, ParamValue> }[]`
  - `versionOf?: string`
  - `draft?: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/my-effects-record.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { MY_EFFECT_ID_RE, MY_EFFECT_LIMITS, newMyEffectId, validateMyEffect, type MyEffectRecord } from '~~/shared/myEffects/record'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const take = SPIKE_TAKES.rain![2]!
const rec = (over: Partial<MyEffectRecord> = {}): MyEffectRecord => ({
  id: 'mine_abcdefghij12', name: 'Rain on glass', from: null, animated: true, generative: false,
  createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ label: 'v1', body: take.body, params: take.params, values: {}, note: 'rain on a window', createdAt: '2026-09-25T00:00:00.000Z' }],
  ...over,
})

describe('My effect record', () => {
  it('ids look like mine_ + 12 base-36 characters', () => {
    const id = newMyEffectId()
    expect(id).toMatch(MY_EFFECT_ID_RE)
    expect(newMyEffectId(() => 0)).toBe('mine_000000000000')
  })
  it('accepts a valid record and returns a clean copy', () => {
    const r = validateMyEffect({ ...rec(), extra: 'dropped' })
    expect(r).toEqual(rec())
  })
  it('the first version must carry code', () => {
    expect(() => validateMyEffect(rec({ versions: [{ label: 'v1', values: {}, note: '', createdAt: 'x' }] }))).toThrow(/first version/)
  })
  it('rejects a bad id, an empty or long name, too many versions, a long body, a bad dial', () => {
    expect(() => validateMyEffect(rec({ id: 'rain' }))).toThrow(/id/)
    expect(() => validateMyEffect(rec({ name: '  ' }))).toThrow(/name/)
    expect(() => validateMyEffect(rec({ name: 'x'.repeat(MY_EFFECT_LIMITS.maxNameChars + 1) }))).toThrow(/name/)
    const v = rec().versions[0]!
    expect(() => validateMyEffect(rec({ versions: Array.from({ length: MY_EFFECT_LIMITS.maxVersions + 1 }, () => v) }))).toThrow(/versions/)
    expect(() => validateMyEffect(rec({ versions: [{ ...v, body: 'x'.repeat(20_000) }] }))).toThrow(/long/)
    expect(() => validateMyEffect(rec({ versions: [{ ...v, params: [{ uniform: 'u_a', label: 'A', type: 'gradient' as any, default: 0 }] }] }))).toThrow(/dial/)
  })
  it('values are numbers or strings only', () => {
    const v = rec().versions[0]!
    expect(() => validateMyEffect(rec({ versions: [{ ...v, values: { u_a: { x: 1 } as any } }] }))).toThrow(/value/)
  })
})
```

```ts
// frontend/tests/unit/my-effects-defs.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  activeVersionIndex, effectIdForVersion, expandMyEffect, isPickable, myEffectIdOf, recordFromTake,
  valuesForVersion, withCodeVersion, withValuesVersion,
} from '~/lib/myEffects/defs'
import { assembleSource } from '~~/shared/shadergen/contract'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const t1 = SPIKE_TAKES.rain![2]!
const t2 = SPIKE_TAKES.rain![0]!
const now = '2026-09-25T10:00:00.000Z'
const base = () => recordFromTake(t1, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: 'Water ripple', now })

describe('My effects: records and versions (spec §7.4)', () => {
  it('a kept take becomes v1 with its code, dials at their defaults, and the request as the note', () => {
    const r = base()
    expect(r.name).toBe(t1.name)
    expect(r.from).toBe('Water ripple')
    expect(r.versions).toHaveLength(1)
    expect(r.versions[0]).toMatchObject({ label: 'v1', body: t1.body, note: 'rain on a window' })
    expect(r.versions[0]!.values).toEqual(Object.fromEntries(t1.params.map(p => [p.uniform, p.default])))
  })

  it('expands to one EffectDef per CODE version; the newest under the record id', () => {
    const r = withValuesVersion(withCodeVersion(base(), t2, { request: 'heavier', now }), { [t2.params[0]!.uniform]: 0.9 }, { request: 'less', now })!
    const defs = expandMyEffect(r)
    expect(defs.map(d => d.id)).toEqual(['mine_aaaaaaaaaaaa', 'mine_aaaaaaaaaaaa~v1'])
    const [main, old] = defs
    expect(main).toMatchObject({ mine: true, from: 'Water ripple', category: 'mine', source: assembleSource(t2.body) })
    expect(old).toMatchObject({ mine: true, versionOf: 'mine_aaaaaaaaaaaa', source: assembleSource(t1.body) })
    expect(main!.versions!.map(v => [v.label, v.effectId])).toEqual([
      ['v1', 'mine_aaaaaaaaaaaa~v1'], ['v2', 'mine_aaaaaaaaaaaa'], ['v3', 'mine_aaaaaaaaaaaa'],
    ])
    expect(isPickable(main!)).toBe(true)
    expect(isPickable(old!)).toBe(false)
    expect(isPickable({ ...main!, draft: true })).toBe(false)
  })

  it('a dial version keeps its code version’s id and lays its values over that code’s defaults', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(r.versions.map(v => v.label)).toEqual(['v1', 'v2'])
    expect(effectIdForVersion(r, 1)).toBe('mine_aaaaaaaaaaaa')
    expect(valuesForVersion(r, 1)[t1.params[0]!.uniform]).toBe(0.123)
  })

  it('no dial version when nothing changed', () => {
    const r = base()
    expect(withValuesVersion(r, { ...r.versions[0]!.values }, { request: 'same', now })).toBeNull()
  })

  it('the pressed chip is the newest version matching the effect id and the values', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', valuesForVersion(r, 1))).toBe(1)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', valuesForVersion(r, 0))).toBe(0)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', { [t1.params[0]!.uniform]: 0.5555 })).toBeNull()
  })

  it('reads a record id out of an effect id', () => {
    expect(myEffectIdOf('mine_aaaaaaaaaaaa')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('mine_aaaaaaaaaaaa~v3')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('water_ripple')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/my-effects-record.unit.spec.ts tests/unit/my-effects-defs.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`shared/myEffects/record.ts`:

```ts
/**
 * A My effect as stored (AI in Sailor spec §7.4). Versions keep the shader
 * BODY (no preamble/helpers) so a later contract fix reaches old effects; a
 * version with `body` changed the code, one without only changed the dials.
 * Shared by /api/my-effects (validation) and the app (expansion to EffectDefs).
 */
import { LIMITS, type GenParam } from '../shadergen/contract'

export const MY_EFFECT_ID_RE = /^mine_[a-z0-9]{12}$/
export const MY_EFFECT_LIMITS = { maxEffects: 500, maxVersions: 50, maxNameChars: 60, maxNoteChars: 300 } as const

export type MyEffectValue = number | string
export interface MyEffectVersion {
  label: string
  body?: string
  params?: GenParam[]
  values: Record<string, MyEffectValue>
  note: string
  createdAt: string
}
export interface MyEffectRecord {
  id: string
  name: string
  from: string | null
  animated: boolean
  generative: boolean
  createdAt: string
  updatedAt: string
  versions: MyEffectVersion[]
}

export function newMyEffectId(rand: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 12; i++) s += Math.floor(rand() * 36).toString(36)
  return `mine_${s}`
}

export const cleanName = (s: string): string => s.replace(/\s+/g, ' ').trim()

const PARAM_TYPES = new Set(['float', 'enum', 'color'])
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown, what: string, max: number): string => {
  if (typeof x !== 'string') throw new Error(`${what} must be text`)
  if (x.length > max) throw new Error(`${what} is too long`)
  return x
}

function cleanParams(x: unknown): GenParam[] {
  if (!Array.isArray(x) || x.length < LIMITS.minParams || x.length > LIMITS.maxParams) throw new Error(`a code version needs ${LIMITS.minParams}–${LIMITS.maxParams} dials`)
  return x.map((p) => {
    if (!isObj(p) || typeof p.uniform !== 'string' || typeof p.label !== 'string' || !PARAM_TYPES.has(p.type)) throw new Error('a dial is malformed')
    if (typeof p.default !== 'number' && typeof p.default !== 'string') throw new Error('a dial is malformed')
    const out: GenParam = { uniform: p.uniform, label: p.label, type: p.type, default: p.default }
    for (const k of ['min', 'max', 'step'] as const) if (typeof p[k] === 'number') out[k] = p[k]
    if (Array.isArray(p.options)) out.options = p.options.filter((o: any) => isObj(o) && typeof o.label === 'string' && typeof o.value === 'number').map((o: any) => ({ label: o.label, value: o.value }))
    return out
  })
}

function cleanValues(x: unknown): Record<string, MyEffectValue> {
  if (!isObj(x)) throw new Error('values must be an object')
  const out: Record<string, MyEffectValue> = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`value ${k} must be a number or text`)
    out[k] = v
  }
  return out
}

export function validateMyEffect(x: unknown): MyEffectRecord {
  if (!isObj(x)) throw new Error('not an object')
  if (typeof x.id !== 'string' || !MY_EFFECT_ID_RE.test(x.id)) throw new Error('invalid id')
  const name = cleanName(str(x.name, 'name', 1000))
  if (!name || name.length > MY_EFFECT_LIMITS.maxNameChars) throw new Error(`name must be 1–${MY_EFFECT_LIMITS.maxNameChars} characters`)
  if (!Array.isArray(x.versions) || !x.versions.length || x.versions.length > MY_EFFECT_LIMITS.maxVersions) throw new Error(`versions must be 1–${MY_EFFECT_LIMITS.maxVersions}`)
  const versions: MyEffectVersion[] = x.versions.map((v: unknown, i: number) => {
    if (!isObj(v)) throw new Error('a version is malformed')
    const out: MyEffectVersion = {
      label: str(v.label, 'label', 12),
      values: cleanValues(v.values),
      note: str(v.note ?? '', 'note', MY_EFFECT_LIMITS.maxNoteChars),
      createdAt: str(v.createdAt, 'createdAt', 40),
    }
    if (v.body !== undefined) {
      out.body = str(v.body, 'body', LIMITS.maxBodyChars)
      out.params = cleanParams(v.params)
    } else if (i === 0) throw new Error('the first version must carry code')
    return out
  })
  return {
    id: x.id, name,
    from: x.from == null ? null : str(x.from, 'from', 120),
    animated: !!x.animated, generative: !!x.generative,
    createdAt: str(x.createdAt, 'createdAt', 40), updatedAt: str(x.updatedAt, 'updatedAt', 40),
    versions,
  }
}
```

(Confirm the names of `LIMITS`' dial bounds in `contract.ts` (grep `LIMITS = {`), and use whatever it calls its min/max params and `maxBodyChars`. The test's "long body" uses 20 000 characters, which is above the 12 000 limit.)

`app/lib/myEffects/defs.ts`:

```ts
/** My effect records ⇄ ordinary EffectDefs (spec §7.4, plan rulings 7, 8, 15). */
import { assembleSource, type GenTake } from '~~/shared/shadergen/contract'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import type { EffectDef, EffectParamDef, ParamValue } from '~/lib/shaderfx/types'

const VERSION_SUFFIX = /~v\d+$/
export function myEffectIdOf(effectId: string): string | null {
  const id = effectId.replace(VERSION_SUFFIX, '')
  return /^mine_[a-z0-9]{12}$/.test(id) ? id : null
}

export function codeIndexFor(rec: MyEffectRecord, i: number): number {
  for (let k = Math.min(i, rec.versions.length - 1); k >= 0; k--) if (rec.versions[k]!.body !== undefined) return k
  return 0
}
const latestCode = (rec: MyEffectRecord) => codeIndexFor(rec, rec.versions.length - 1)

export function effectIdForVersion(rec: MyEffectRecord, i: number): string {
  const c = codeIndexFor(rec, i)
  return c === latestCode(rec) ? rec.id : `${rec.id}~v${c + 1}`
}

const defaultsOf = (params: { uniform: string; default: unknown }[]) =>
  Object.fromEntries(params.map(p => [p.uniform, p.default])) as Record<string, ParamValue>

export function valuesForVersion(rec: MyEffectRecord, i: number): Record<string, ParamValue> {
  const code = rec.versions[codeIndexFor(rec, i)]!
  return { ...defaultsOf(code.params ?? []), ...(rec.versions[i]?.values ?? {}) }
}

export function expandMyEffect(rec: MyEffectRecord): EffectDef[] {
  const newest = latestCode(rec)
  const chips = rec.versions.map((v, i) => ({ label: v.label, note: v.note, effectId: effectIdForVersion(rec, i), values: valuesForVersion(rec, i) }))
  const out: EffectDef[] = []
  rec.versions.forEach((v, i) => {
    if (v.body === undefined) return
    const main = i === newest
    out.push({
      id: main ? rec.id : `${rec.id}~v${i + 1}`,
      name: main ? rec.name : `${rec.name} · ${v.label}`,
      category: 'mine', animated: rec.animated, generative: rec.generative, passes: 1, centerParam: null, textures: [],
      source: assembleSource(v.body),
      params: (v.params ?? []).map(p => ({ ...p }) as EffectParamDef),
      mine: true, from: rec.from, versions: chips,
      ...(main ? {} : { versionOf: rec.id }),
    })
  })
  return [out.find(d => d.id === rec.id)!, ...out.filter(d => d.id !== rec.id).reverse()]
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

export function activeVersionIndex(rec: MyEffectRecord, effectId: string, values: Record<string, ParamValue>): number | null {
  for (let i = rec.versions.length - 1; i >= 0; i--) {
    if (effectIdForVersion(rec, i) === effectId && same(valuesForVersion(rec, i), { ...valuesForVersion(rec, i), ...values })) return i
  }
  return null
}

export function recordFromTake(take: GenTake, o: { id: string; request: string; from: string | null; now: string }): MyEffectRecord {
  return {
    id: o.id, name: take.name.trim().slice(0, 60) || 'My effect', from: o.from, animated: take.animated, generative: take.generative,
    createdAt: o.now, updatedAt: o.now,
    versions: [{ label: 'v1', body: take.body, params: take.params, values: defaultsOf(take.params) as Record<string, string | number>, note: o.request.slice(0, 300), createdAt: o.now }],
  }
}

export function withCodeVersion(rec: MyEffectRecord, take: GenTake, o: { request: string; now: string }): MyEffectRecord {
  const label = `v${rec.versions.length + 1}`
  return {
    ...rec, animated: take.animated, generative: take.generative, updatedAt: o.now,
    versions: [...rec.versions, { label, body: take.body, params: take.params, values: defaultsOf(take.params) as Record<string, string | number>, note: o.request.slice(0, 300), createdAt: o.now }],
  }
}

export function withValuesVersion(rec: MyEffectRecord, values: Record<string, ParamValue>, o: { request: string; now: string }): MyEffectRecord | null {
  const last = rec.versions.length - 1
  const cur = valuesForVersion(rec, last)
  const next = { ...cur, ...values }
  if (same(cur, next)) return null
  const plain = Object.fromEntries(Object.entries(next).filter(([, v]) => typeof v === 'number' || typeof v === 'string')) as Record<string, string | number>
  return { ...rec, updatedAt: o.now, versions: [...rec.versions, { label: `v${rec.versions.length + 1}`, values: plain, note: o.request.slice(0, 300), createdAt: o.now }] }
}

export const isPickable = (def: EffectDef): boolean => !def.draft && !def.versionOf
```

In `activeVersionIndex`, `{ ...valuesForVersion(rec, i), ...values }` compares only the keys the target set, over the version's full values, so a target that stores just the changed dials still matches. The test's "no match" value is one no version has.

In `types.ts`, add the five optional fields to `EffectDef`, each with a one-line doc comment ("A My effect", "The base effect's name", "Version chips for the Recipe", "An older code version of this My effect id; hidden from pickers", "A take being previewed; never listed, never saved").

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck `types.ts`, `record.ts` and `defs.ts`.
- Commit.
- Message: `feat(my-effects): the stored record, validation, and versions expanded into ordinary EffectDefs`

---

### Task 4: `/api/my-effects`: a per-user store, locally and hosted

**Files:**
- Create: `frontend/server/utils/myEffectsStore.ts`
- Create: `frontend/server/api/my-effects/index.get.ts`, `[id].get.ts`, `[id].put.ts`, `[id].patch.ts`, `[id].delete.ts`
- Modify: `frontend/server/utils/dataDir.ts` (`StoreName` gains `'my-effects'` → local `['.data', 'my-effects']`)
- Modify: `frontend/server/utils/resourceOwners.ts` (`RESOURCE_KINDS` gains `'my-effect'`)
- Modify: `frontend/server/lib/nitroApiPaths.ts` (`NITRO_API_PREFIXES` gains `'/api/my-effects'`)
- Test: `frontend/tests/unit/my-effects-routes.unit.spec.ts`

**Interfaces:**
- Consumes: Task 3 `validateMyEffect`, `MY_EFFECT_ID_RE`, `MY_EFFECT_LIMITS`, `cleanName`, `MyEffectRecord`; `storeDir`, `guardMutation`, `claimNew`, `releaseRecord`, `ownedIds`, `ownerOf`, `deployMode`.
- Produces (HTTP):
  - `GET /api/my-effects` → `{ effects: MyEffectRecord[] }`, newest `updatedAt` first
  - `GET /api/my-effects/:id` → `MyEffectRecord`, or 404
  - `PUT /api/my-effects/:id` with a full record body (the URL id must match) → the saved record, with `updatedAt` set by the server. It returns 409 at the effect cap.
  - `PATCH /api/my-effects/:id` with `{ name }` → the renamed record
  - `DELETE /api/my-effects/:id` → `{ ok: true, id }`
- Produces (TS), `myEffectsStore.ts`:
  - `myEffectsOpts(): OwnedStoreOpts`, which resolves `storeDir` at call time so tests can set `SAILOR_DATA_DIR` first
  - `listMyEffects(userId: string | null): Promise<MyEffectRecord[]>`
  - `readMyEffect(id: string, userId: string | null): Promise<MyEffectRecord | null>`
  - `writeMyEffect(rec: MyEffectRecord, userId: string | null): Promise<MyEffectRecord>`
  - `renameMyEffect(id: string, name: string, userId: string | null): Promise<MyEffectRecord>`
  - `deleteMyEffect(id: string, userId: string | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

Model it on `tests/unit/owned-stores-routes.unit.spec.ts`: copy its h3 globals stub, its in-memory `resource_owners` fake (`query` handling INSERT, the SELECTs and DELETE), and its `setHosted` / `setLocal` helpers. Import the handlers **dynamically in `beforeAll`**, after `process.env.SAILOR_DATA_DIR` points at a `mkdtempSync` dir.

```ts
// frontend/tests/unit/my-effects-routes.unit.spec.ts
// (header + h3 globals + owners fake + setHosted/setLocal copied from owned-stores-routes.unit.spec.ts)
import { SPIKE_TAKES } from '../../app/lib/shadergen/__eval__/spikeTakes'
import { MY_EFFECT_LIMITS } from '../../shared/myEffects/record'
import { NITRO_API_PREFIXES, isNitroApiPath } from '../../server/lib/nitroApiPaths'

const t = SPIKE_TAKES.rain![2]!
const rec = (id: string, name = 'Rain on glass') => ({
  id, name, from: null, animated: true, generative: false, createdAt: 'x', updatedAt: 'x',
  versions: [{ label: 'v1', body: t.body, params: t.params, values: {}, note: 'rain', createdAt: 'x' }],
})
const A = 'mine_aaaaaaaaaaaa', B = 'mine_bbbbbbbbbbbb'
let list: any, get: any, put: any, patch: any, del: any
// beforeAll: dataDir = mkdtempSync(...); process.env.SAILOR_DATA_DIR = dataDir;
//   list = (await import('../../server/api/my-effects/index.get')).default; get = …/[id].get; put = …/[id].put; patch = …/[id].patch; del = …/[id].delete
// beforeEach: owners.clear(); rmSync(join(dataDir, 'my-effects'), { recursive: true, force: true }); __setResourceOwnersDbForTests({ query } as any); setLocal()

const ev = (o: { id?: string; body?: any; userId?: string | null } = {}) => ({ params: o.id ? { id: o.id } : {}, body: o.body, context: { userId: o.userId ?? null } })

describe('/api/my-effects (local)', () => {
  it('is a Nitro route', () => {
    expect(NITRO_API_PREFIXES).toContain('/api/my-effects')
    expect(isNitroApiPath('/api/my-effects')).toBe(true)
    expect(isNitroApiPath(`/api/my-effects/${A}`)).toBe(true)
  })
  it('save, list, get, rename, delete', async () => {
    const saved = await put(ev({ id: A, body: rec(A) }))
    expect(saved.id).toBe(A)
    expect(saved.updatedAt).not.toBe('x')
    expect((await list(ev())).effects.map((e: any) => e.id)).toEqual([A])
    expect((await get(ev({ id: A }))).name).toBe('Rain on glass')
    expect((await patch(ev({ id: A, body: { name: '  Wet   glass ' } }))).name).toBe('Wet glass')
    expect(await del(ev({ id: A }))).toEqual({ ok: true, id: A })
    await expect(get(ev({ id: A }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('refuses a mismatched id, a bad record, and an unknown id to rename', async () => {
    await expect(put(ev({ id: A, body: rec(B) }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(put(ev({ id: A, body: { ...rec(A), versions: [] } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(put(ev({ id: 'rain', body: rec('rain') }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(patch(ev({ id: A, body: { name: 'x' } }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('stops at the effect cap for a NEW id, never for an update', async () => {
    const dir = join(dataDir, 'my-effects'); mkdirSync(dir, { recursive: true })
    for (let i = 0; i < MY_EFFECT_LIMITS.maxEffects; i++) {
      const id = `mine_${String(i).padStart(12, '0')}`
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec(id)))
    }
    await expect(put(ev({ id: A, body: rec(A) }))).rejects.toMatchObject({ statusCode: 409 })
    await expect(put(ev({ id: 'mine_000000000000', body: rec('mine_000000000000', 'Renamed') }))).resolves.toBeTruthy()
  })
})

describe('/api/my-effects (hosted): strictly your own', () => {
  beforeEach(() => setHosted())
  it('lists and reads only the caller’s effects (no unowned ones)', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    await put(ev({ id: B, body: rec(B), userId: 'u2' }))
    const dir = join(dataDir, 'my-effects')
    writeFileSync(join(dir, 'mine_cccccccccccc.json'), JSON.stringify(rec('mine_cccccccccccc'))) // no owner row
    expect((await list(ev({ userId: 'u1' }))).effects.map((e: any) => e.id)).toEqual([A])
    await expect(get(ev({ id: B, userId: 'u1' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(get(ev({ id: 'mine_cccccccccccc', userId: 'u1' }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('can’t overwrite, rename or delete someone else’s', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    await expect(put(ev({ id: A, body: rec(A, 'Mine now'), userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(patch(ev({ id: A, body: { name: 'x' }, userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(del(ev({ id: A, userId: 'u2' }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('a signed-out request sees nothing', async () => {
    await put(ev({ id: A, body: rec(A), userId: 'u1' }))
    expect((await list(ev({ userId: null }))).effects).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/my-effects-routes.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// frontend/server/utils/myEffectsStore.ts
/**
 * My effects (AI in Sailor spec §7.4, plan ruling 6): one JSON file per effect
 * under storeDir('my-effects'), owner-scoped with the Stage 6 registry. Local:
 * everything, no owner rows. Hosted: STRICTLY the caller's own — unlike the
 * curated stores, an unowned record is never shown to anyone.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createError } from 'h3'
import { cleanName, MY_EFFECT_ID_RE, MY_EFFECT_LIMITS, validateMyEffect, type MyEffectRecord } from '../../shared/myEffects/record'
import { deployMode } from './deployMode'
import { storeDir } from './dataDir'
import { claimNew, guardMutation, releaseRecord, type OwnedStoreOpts } from './ownedJsonStore'
import { ownedIds, ownerOf } from './resourceOwners'

export const myEffectsOpts = (): OwnedStoreOpts => ({ kind: 'my-effect', dir: storeDir('my-effects') })
const fileOf = (id: string) => join(myEffectsOpts().dir, `${id}.json`)
const notFound = () => createError({ statusCode: 404, statusMessage: 'Not found' })
export function assertId(id: unknown): string {
  if (typeof id !== 'string' || !MY_EFFECT_ID_RE.test(id)) throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  return id
}

async function readAll(): Promise<MyEffectRecord[]> {
  let files: string[] = []
  try { files = (await readdir(myEffectsOpts().dir)).filter(f => f.endsWith('.json')) } catch { return [] }
  const out: MyEffectRecord[] = []
  for (const f of files) {
    try {
      const r = validateMyEffect(JSON.parse(await readFile(join(myEffectsOpts().dir, f), 'utf8')))
      if (r.id === basename(f, '.json')) out.push(r)
    } catch { /* skip a corrupt file; never 500 the list */ }
  }
  return out
}

export async function listMyEffects(userId: string | null): Promise<MyEffectRecord[]> {
  let all = await readAll()
  if (deployMode() === 'hosted') {
    if (!userId) return []
    const mine = await ownedIds('my-effect', userId)
    all = all.filter(r => mine.has(r.id))
  }
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readMyEffect(id: string, userId: string | null): Promise<MyEffectRecord | null> {
  if (deployMode() === 'hosted' && (!userId || (await ownerOf('my-effect', id)) !== userId)) return null
  try { return validateMyEffect(JSON.parse(await readFile(fileOf(id), 'utf8'))) } catch { return null }
}

export async function writeMyEffect(input: unknown, userId: string | null): Promise<MyEffectRecord> {
  let rec: MyEffectRecord
  try { rec = validateMyEffect(input) } catch (e) { throw createError({ statusCode: 400, statusMessage: (e as Error).message }) }
  const exists = existsSync(fileOf(rec.id))
  await guardMutation(myEffectsOpts(), userId, rec.id, exists)
  if (!exists && (await listMyEffects(userId)).length >= MY_EFFECT_LIMITS.maxEffects) {
    throw createError({ statusCode: 409, statusMessage: `My effects holds ${MY_EFFECT_LIMITS.maxEffects} effects. Remove one to keep another.` })
  }
  rec.updatedAt = new Date().toISOString()
  await mkdir(myEffectsOpts().dir, { recursive: true })
  await writeFile(fileOf(rec.id), JSON.stringify(rec, null, 2), 'utf8')
  if (!exists) await claimNew(myEffectsOpts(), userId, rec.id)
  return rec
}

export async function renameMyEffect(id: string, name: string, userId: string | null): Promise<MyEffectRecord> {
  const cur = await readMyEffect(id, userId)
  if (!cur) throw notFound()
  return writeMyEffect({ ...cur, name: cleanName(String(name ?? '')) }, userId)
}

export async function deleteMyEffect(id: string, userId: string | null): Promise<void> {
  const exists = existsSync(fileOf(id))
  if (!exists) throw notFound()
  await guardMutation(myEffectsOpts(), userId, id, true)
  await rm(fileOf(id), { force: true })
  await releaseRecord(myEffectsOpts(), id)
}
```

The routes are thin wrappers:
- `index.get.ts` → `{ effects: await listMyEffects(event.context.userId ?? null) }`;
- `[id].get.ts` → `assertId`, then `readMyEffect`, and 404 when it returns null;
- `[id].put.ts` → `assertId`, then `readBody`, then 400 unless `body?.id === id`, then `writeMyEffect(body, userId)`;
- `[id].patch.ts` → `assertId`, then `renameMyEffect(id, body?.name, userId)`;
- `[id].delete.ts` → `assertId`, then `deleteMyEffect`, then `{ ok: true, id }`.

Each opens with a one-line doc comment and imports from `'../../utils/myEffectsStore'`. Use `defineEventHandler`, `readBody`, `getRouterParam` and `createError` as auto-imports, the way the moodboard routes do.

Also:
- `dataDir.ts`: add `'my-effects'` to `StoreName` and `'my-effects': ['.data', 'my-effects']` to `LOCAL_PATHS`.
- `resourceOwners.ts`: append `'my-effect'` to `RESOURCE_KINDS`.
- `nitroApiPaths.ts`: add `'/api/my-effects'` to the end of `NITRO_API_PREFIXES`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/my-effects-routes.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts tests/unit/owned-json-store.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`. `api-route-reachability` must see the new route files, and any test that enumerates `RESOURCE_KINDS` or `StoreName` must still pass.
- Typecheck the new files.
- Commit.
- Message: `feat(my-effects): /api/my-effects — list, get, save, rename, delete — one file per effect, strictly the caller's own when hosted`

---

### Task 5: One live catalog with My effects in it, and the shared picker helper

**Files:**
- Create: `frontend/app/lib/myEffects/client.ts`, `frontend/app/lib/myEffects/library.ts`
- Create: `frontend/app/composables/useMyEffects.ts`
- Create: `frontend/app/lib/shaderfx/gallery.ts`
- Modify: `frontend/app/lib/shaderfx/catalogStore.ts` (add `putShaderFxEffects`, `removeShaderFxEffects`, `currentShaderEffects`)
- Modify: `frontend/app/lib/shaderfx/catalog.ts` (merge My effects; `useShaderCatalog`, `registerEffects`, `unregisterEffects`)
- Modify (catalog ref only): `ShaderStudioSurface.vue`, `widgets/ShaderFillEditor.vue`, `ShaderEffectNode.vue`, and the Frame effect-stack block of `CompositorModal.vue` (~L2684)
- Test: `frontend/tests/unit/shaderfx-live-catalog.unit.spec.ts`, `frontend/tests/unit/use-my-effects.unit.spec.ts`, `frontend/tests/unit/shaderfx-gallery.unit.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`expandMyEffect`, `recordFromTake`, `withCodeVersion`, `withValuesVersion`, `isPickable`, `newMyEffectId`, `cleanName`); Task 4's routes.
- Produces:
  - **`catalogStore.ts`:**
    - `putShaderFxEffects(defs: EffectDef[]): void`, which replaces by id
    - `removeShaderFxEffects(ids: string[]): void`
    - `currentShaderEffects(): EffectDef[]`
  - **`catalog.ts`:**
    - `useShaderCatalog(): Readonly<ShallowRef<ShaderFxCatalog | null>>`, which starts the fetch
    - `registerEffects(defs: EffectDef[]): void`
    - `unregisterEffects(ids: string[]): void`
    - `fetchShaderFxCatalog()` resolves to built-ins plus My effects plus anything registered so far
  - **`client.ts`:**
    - `listMyEffects(): Promise<MyEffectRecord[]>`
    - `putMyEffect(r: MyEffectRecord): Promise<MyEffectRecord>`
    - `renameMyEffect(id: string, name: string): Promise<MyEffectRecord>`
    - `deleteMyEffect(id: string): Promise<void>`
  - **`library.ts`:**
    - `myEffectRecords: ShallowRef<MyEffectRecord[]>`
    - `loadMyEffectRecords(api?): Promise<MyEffectRecord[]>`, which runs once per page unless `force`
    - `myEffectRecordById(id: string): MyEffectRecord | null`
    - `setMyEffectRecord(r: MyEffectRecord | null, id?: string): void`
  - **`useMyEffects(deps?)`** returns:
    - `records`
    - `load()`
    - `saveTake(take: GenTake, o: { request: string; from: string | null }): Promise<MyEffectRecord>`
    - `addCodeVersion(id: string, take: GenTake, request: string): Promise<MyEffectRecord>`
    - `addValuesVersion(id: string, values: Record<string, ParamValue>, request: string): Promise<MyEffectRecord | null>`
    - `rename(id: string, name: string): Promise<MyEffectRecord>`
    - `remove(id: string): Promise<void>`
    - `adopt(recs: MyEffectRecord[]): void`

    `deps`: `{ api?: typeof import('~/lib/myEffects/client'); register?: typeof registerEffects; unregister?: typeof unregisterEffects; now?: () => string; newId?: () => string }`.
  - **`gallery.ts`:**
    - `SHADER_SECTIONS: CatalogSection[]`, moved from `ShaderStudioSurface`
    - `SHADER_GALLERY_SECTIONS`, which is `[{ id: 'mine', label: 'My effects' }, ...SHADER_SECTIONS]`
    - `sectionOfEffect(d: EffectDef): string`
    - `shaderGalleryFilters(effects: EffectDef[], include?: (d: EffectDef) => boolean): { id: string; label: string; count: number }[]`
    - `shaderGalleryItems(effects: EffectDef[], o: { filter: string; query: string; include?: (d: EffectDef) => boolean }): EffectDef[]`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/shaderfx-gallery.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { SHADER_GALLERY_SECTIONS, sectionOfEffect, shaderGalleryFilters, shaderGalleryItems } from '~/lib/shaderfx/gallery'
import type { EffectDef } from '~/lib/shaderfx/types'

const d = (id: string, category: string, over: Partial<EffectDef> = {}): EffectDef => ({ id, name: id.replace(/_/g, ' '), category, animated: false, passes: 1, centerParam: null, textures: [], params: [], source: '', ...over })
const effects = [
  d('glow_soft', 'glow'), d('water_ripple', 'distortion'),
  d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass', from: 'Water ripple' }),
  d('mine_aaaaaaaaaaaa~v1', 'mine', { mine: true, versionOf: 'mine_aaaaaaaaaaaa' }),
  d('draft_1_0', 'mine', { draft: true }),
]

describe('the shared shader gallery helper (spec §7.3, §7.4)', () => {
  it('My effects first, then the built-in sections; drafts and old versions never listed', () => {
    expect(shaderGalleryItems(effects, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple', 'glow_soft'])
    expect(SHADER_GALLERY_SECTIONS[0]).toEqual({ id: 'mine', label: 'My effects' })
    expect(sectionOfEffect(effects[2]!)).toBe('mine')
    expect(sectionOfEffect(effects[0]!)).toBe('glow')
  })
  it('the My effects chip is always there, with its count; categories follow', () => {
    const f = shaderGalleryFilters(effects)
    expect(f[0]).toEqual({ id: 'all', label: 'All', count: 3 })
    expect(f[1]).toEqual({ id: 'mine', label: 'My effects', count: 1 })
    expect(f.map(x => x.id)).toEqual(['all', 'mine', 'distortion', 'glow'])
    expect(shaderGalleryFilters([d('glow_soft', 'glow')])[1]).toEqual({ id: 'mine', label: 'My effects', count: 0 })
  })
  it('filters by chip, by search (name, category, origin), and by the host’s include', () => {
    expect(shaderGalleryItems(effects, { filter: 'mine', query: '' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa'])
    expect(shaderGalleryItems(effects, { filter: 'all', query: 'ripple' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
    expect(shaderGalleryItems(effects, { filter: 'all', query: '', include: e => e.id !== 'glow_soft' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
  })
})
```

```ts
// frontend/tests/unit/shaderfx-live-catalog.unit.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const builtIns = { version: 3, effects: [{ id: 'water_ripple', name: 'Water ripple', category: 'distortion', animated: false, passes: 1, centerParam: null, textures: [], params: [], source: 'x' }] }
;(globalThis as any).$fetch = vi.fn(async (url: string) => {
  if (url === '/sailor/shader_effects') return builtIns
  if (url === '/api/my-effects') return { effects: [] }
  throw new Error(url)
})

describe('one live catalog', () => {
  beforeEach(() => vi.resetModules())

  it('merges My effects into the fetched catalog and the sync store', async () => {
    const { SPIKE_TAKES } = await import('~/lib/shadergen/__eval__/spikeTakes')
    const { recordFromTake } = await import('~/lib/myEffects/defs')
    const rec = recordFromTake(SPIKE_TAKES.rain![2]!, { id: 'mine_aaaaaaaaaaaa', request: 'rain', from: null, now: 'x' })
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [rec] } : builtIns))
    const cat = await (await import('~/lib/shaderfx/catalog')).fetchShaderFxCatalog()
    expect(cat.effects.map(e => e.id)).toEqual(['water_ripple', 'mine_aaaaaaaaaaaa'])
    const store = await import('~/lib/shaderfx/catalogStore')
    expect(store.getEffectSync('mine_aaaaaaaaaaaa')?.mine).toBe(true)
  })

  it('a My effects failure never blocks the built-ins', async () => {
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => { if (url === '/api/my-effects') throw new Error('405'); return builtIns })
    const cat = await (await import('~/lib/shaderfx/catalog')).fetchShaderFxCatalog()
    expect(cat.effects.map(e => e.id)).toEqual(['water_ripple'])
  })

  it('registerEffects replaces by id and publishes a NEW catalog object; unregister removes', async () => {
    ;(globalThis as any).$fetch.mockImplementation(async (url: string) => (url === '/api/my-effects' ? { effects: [] } : builtIns))
    const c = await import('~/lib/shaderfx/catalog')
    const live = c.useShaderCatalog()
    await c.fetchShaderFxCatalog()
    const before = live.value
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'draft_1_0', name: 'Take', draft: true } as any])
    expect(live.value).not.toBe(before)
    expect(live.value!.effects.some(e => e.id === 'draft_1_0')).toBe(true)
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'draft_1_0', name: 'Take (new)', draft: true } as any])
    expect(live.value!.effects.filter(e => e.id === 'draft_1_0').map(e => e.name)).toEqual(['Take (new)'])
    c.unregisterEffects(['draft_1_0'])
    expect((await import('~/lib/shaderfx/catalogStore')).getEffectSync('draft_1_0')).toBeNull()
  })

  it('effects registered before the fetch resolves survive it', async () => {
    const c = await import('~/lib/shaderfx/catalog')
    c.registerEffects([{ ...builtIns.effects[0]!, id: 'mine_bbbbbbbbbbbb', mine: true } as any])
    const cat = await c.fetchShaderFxCatalog()
    expect(cat.effects.some(e => e.id === 'mine_bbbbbbbbbbbb')).toBe(true)
  })
})
```

```ts
// frontend/tests/unit/use-my-effects.unit.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMyEffects } from '~/composables/useMyEffects'
import { myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const t1 = SPIKE_TAKES.rain![2]!, t2 = SPIKE_TAKES.rain![0]!
function setup() {
  const api = {
    listMyEffects: vi.fn(async () => []),
    putMyEffect: vi.fn(async (r: any) => ({ ...r, updatedAt: 'saved' })),
    renameMyEffect: vi.fn(async (id: string, name: string) => ({ ...myEffectRecords.value.find(r => r.id === id)!, name })),
    deleteMyEffect: vi.fn(async () => {}),
  }
  const register = vi.fn(), unregister = vi.fn()
  const my = useMyEffects({ api: api as any, register, unregister, now: () => 'now', newId: () => 'mine_aaaaaaaaaaaa' })
  return { my, api, register, unregister }
}

describe('useMyEffects', () => {
  beforeEach(() => { myEffectRecords.value = [] })

  it('saveTake stores v1 and registers its definitions', async () => {
    const { my, api, register } = setup()
    const r = await my.saveTake(t1, { request: 'rain on a window', from: 'Water ripple' })
    expect(api.putMyEffect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine_aaaaaaaaaaaa', from: 'Water ripple' }))
    expect(r.updatedAt).toBe('saved')
    expect(myEffectRecords.value.map(x => x.id)).toEqual(['mine_aaaaaaaaaaaa'])
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa'])
  })

  it('addCodeVersion appends a version and re-registers both code versions', async () => {
    const { my, register } = setup()
    await my.saveTake(t1, { request: 'rain', from: null })
    const r = await my.addCodeVersion('mine_aaaaaaaaaaaa', t2, 'heavier')
    expect(r.versions.map(v => v.label)).toEqual(['v1', 'v2'])
    expect(register.mock.calls.at(-1)![0].map((d: any) => d.id)).toEqual(['mine_aaaaaaaaaaaa', 'mine_aaaaaaaaaaaa~v1'])
  })

  it('addValuesVersion is a no-op when nothing changed', async () => {
    const { my, api } = setup()
    const r = await my.saveTake(t1, { request: 'rain', from: null })
    api.putMyEffect.mockClear()
    expect(await my.addValuesVersion(r.id, { ...r.versions[0]!.values }, 'same')).toBeNull()
    expect(api.putMyEffect).not.toHaveBeenCalled()
  })

  it('remove deletes on the server and from the library, but leaves the definitions for projects that use it', async () => {
    const { my, api, unregister } = setup()
    await my.saveTake(t1, { request: 'rain', from: null })
    await my.remove('mine_aaaaaaaaaaaa')
    expect(api.deleteMyEffect).toHaveBeenCalledWith('mine_aaaaaaaaaaaa')
    expect(myEffectRecords.value).toEqual([])
    expect(unregister).not.toHaveBeenCalled() // pickers hide it via the library; open projects keep rendering
  })

  it('adopt registers project copies; the library copy wins when it has as many versions', async () => {
    const { my, register } = setup()
    const lib = await my.saveTake(t1, { request: 'rain', from: null })
    register.mockClear()
    my.adopt([{ ...lib, name: 'Old name' }])
    expect(register).not.toHaveBeenCalled()
    my.adopt([{ ...lib, id: 'mine_bbbbbbbbbbbb', name: 'From a shared project' }])
    expect(register.mock.calls[0]![0][0].name).toBe('From a shared project')
    expect(myEffectRecords.value.map(r => r.id)).toEqual(['mine_aaaaaaaaaaaa']) // never written into the library
  })
})
```

"Remove leaves the definitions registered": the gallery must then hide removed effects. `shaderGalleryItems` lists `mine` effects only when `myEffectRecordById(id)` is non-null **or** the def is not `mine`. That's easier than unregistering: an open project that uses the effect keeps rendering it. Add this case to the gallery spec:

```ts
  it('a removed My effect stays registered (projects render it) but is no longer listed', async () => {
    const { setMyEffectRecord } = await import('~/lib/myEffects/library')
    setMyEffectRecord(null, 'mine_aaaaaaaaaaaa')
    // gallery items consult the library for mine effects
    const { shaderGalleryItems } = await import('~/lib/shaderfx/gallery')
    expect(shaderGalleryItems(effects, { filter: 'all', query: '', listed: () => false }).map(e => e.id)).toEqual(['water_ripple', 'glow_soft'])
  })
```

So `shaderGalleryItems` takes an optional `listed?: (id: string) => boolean`, which defaults to `id => !!myEffectRecordById(id)` only when the library has loaded, and to `true` before that. For the earlier gallery cases, pass `listed: () => true`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/shaderfx-gallery.unit.spec.ts tests/unit/shaderfx-live-catalog.unit.spec.ts tests/unit/use-my-effects.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`catalogStore.ts`** (stays network-free):

```ts
/** Replace-or-add by id (My effects change: a rename, a new version, a draft). */
export function putShaderFxEffects(defs: EffectDef[]): void {
  const byId = new Map((cached?.effects ?? []).map(e => [e.id, e]))
  for (const d of defs) byId.set(d.id, d)
  cached = { version: cached?.version ?? 1, effects: [...byId.values()] }
}
export function removeShaderFxEffects(ids: string[]): void {
  if (!cached) return
  const drop = new Set(ids)
  cached = { ...cached, effects: cached.effects.filter(e => !drop.has(e.id)) }
}
/** Every effect the page knows right now: built-ins, My effects, project copies, drafts. */
export function currentShaderEffects(): EffectDef[] { return cached?.effects ?? [] }
```

**`catalog.ts`:**

```ts
import { shallowRef, type ShallowRef } from 'vue'
import { expandMyEffect } from '~/lib/myEffects/defs'
import { loadMyEffectRecords } from '~/lib/myEffects/library'
import { putShaderFxEffects, removeShaderFxEffects, currentShaderEffects } from './catalogStore'

const live = shallowRef<ShaderFxCatalog | null>(null)
/** Registered before the fetch resolved (a project copy, an early draft): merged in at load. */
const early = new Map<string, EffectDef>()

function publish(): void {
  const cat: ShaderFxCatalog = { version: live.value?.version ?? 1, effects: currentShaderEffects() }
  live.value = cat
}

export function fetchShaderFxCatalog(force = false): Promise<ShaderFxCatalog> {
  if (!promise || force) {
    promise = Promise.all([
      $fetch<ShaderFxCatalog>('/sailor/shader_effects'),
      loadMyEffectRecords().catch(() => []), // My effects never block the built-ins
    ]).then(([cat, mine]) => {
      setShaderFxCatalog(cat)
      putShaderFxEffects([...mine.flatMap(expandMyEffect), ...early.values()])
      live.value = { version: cat.version, effects: currentShaderEffects() }
      return live.value
    }).catch((err) => { promise = null; throw err })
  }
  return promise
}

export function useShaderCatalog(): Readonly<ShallowRef<ShaderFxCatalog | null>> {
  void fetchShaderFxCatalog().catch(() => {})
  return live
}
export function registerEffects(defs: EffectDef[]): void {
  if (!defs.length) return
  if (!live.value) for (const d of defs) early.set(d.id, d)
  putShaderFxEffects(defs)
  if (live.value) publish()
}
export function unregisterEffects(ids: string[]): void {
  for (const id of ids) early.delete(id)
  removeShaderFxEffects(ids)
  if (live.value) publish()
}
```

(`getEffect` keeps working through `fetchShaderFxCatalog`. Keep the existing re-exports, the `setShaderFxRefetcher` line and `assetUrl`.)

**`client.ts`:** four `$fetch` wrappers on `/api/my-effects`: `listMyEffects` returns `res.effects`; `putMyEffect` sends `PUT /api/my-effects/${r.id}` with the record; `renameMyEffect` sends `PATCH` with `{ name }`; `deleteMyEffect` sends `DELETE`.

**`library.ts`:**

```ts
import { shallowRef } from 'vue'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from './client'

export const myEffectRecords = shallowRef<MyEffectRecord[]>([])
let loaded: Promise<MyEffectRecord[]> | null = null
export const myEffectsLoaded = shallowRef(false)
export function loadMyEffectRecords(api: Pick<typeof client, 'listMyEffects'> = client, force = false): Promise<MyEffectRecord[]> {
  if (!loaded || force) {
    loaded = api.listMyEffects().then((r) => { myEffectRecords.value = r; myEffectsLoaded.value = true; return r })
      .catch((e) => { loaded = null; throw e })
  }
  return loaded
}
export const myEffectRecordById = (id: string): MyEffectRecord | null => myEffectRecords.value.find(r => r.id === id) ?? null
export function setMyEffectRecord(r: MyEffectRecord | null, id = r?.id): void {
  const rest = myEffectRecords.value.filter(x => x.id !== id)
  myEffectRecords.value = r ? [r, ...rest] : rest
}
```

**`useMyEffects.ts`:**

```ts
/** My effects: save a kept take, add versions, rename, remove, and adopt a
 *  project's copies (spec §7.4; plan rulings 8, 16, 17). Every change is
 *  written through /api/my-effects first, then registered with the live
 *  catalog so every picker and renderer sees it at once. */
import type { GenTake } from '~~/shared/shadergen/contract'
import { cleanName, newMyEffectId, type MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from '~/lib/myEffects/client'
import { expandMyEffect, recordFromTake, withCodeVersion, withValuesVersion } from '~/lib/myEffects/defs'
import { loadMyEffectRecords, myEffectRecordById, myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { registerEffects, unregisterEffects } from '~/lib/shaderfx/catalog'
import type { ParamValue } from '~/lib/shaderfx/types'

export function useMyEffects(deps: { api?: typeof client; register?: typeof registerEffects; unregister?: typeof unregisterEffects; now?: () => string; newId?: () => string } = {}) {
  const api = deps.api ?? client
  const register = deps.register ?? registerEffects
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => newMyEffectId())
  async function commit(r: MyEffectRecord): Promise<MyEffectRecord> {
    const saved = await api.putMyEffect(r)
    setMyEffectRecord(saved)
    register(expandMyEffect(saved))
    return saved
  }
  const need = (id: string) => { const r = myEffectRecordById(id); if (!r) throw new Error('That effect isn’t in My effects any more.'); return r }
  return {
    records: myEffectRecords,
    load: () => loadMyEffectRecords(api, true),
    saveTake: (take: GenTake, o: { request: string; from: string | null }) => commit(recordFromTake(take, { id: newId(), request: o.request, from: o.from, now: now() })),
    addCodeVersion: (id: string, take: GenTake, request: string) => commit(withCodeVersion(need(id), take, { request, now: now() })),
    async addValuesVersion(id: string, values: Record<string, ParamValue>, request: string) {
      const next = withValuesVersion(need(id), values, { request, now: now() })
      return next ? commit(next) : null
    },
    async rename(id: string, name: string) {
      const saved = await api.renameMyEffect(id, cleanName(name))
      setMyEffectRecord(saved); register(expandMyEffect(saved)); return saved
    },
    async remove(id: string) { await api.deleteMyEffect(id); setMyEffectRecord(null, id) },
    adopt(recs: MyEffectRecord[]) {
      const take = recs.filter((r) => { const lib = myEffectRecordById(r.id); return !lib || lib.versions.length < r.versions.length })
      if (take.length) register(take.flatMap(expandMyEffect))
    },
  }
}
```

`deps.unregister` is accepted for symmetry, and so tests can prove it's never called by `remove`.

**`gallery.ts`:** implement it to the test.
- **Order:** mine first (library order, newest first), then each `SHADER_SECTIONS` section in order, then any other category.
- **Always filtered by `isPickable`.** A `mine` def is listed only when `listed(id)` is true.
- **Search** matches `name`, `category` and `from`, case-insensitively.
- **Filter chips:** labels are title case from the category id, and the "Color" label is kept as the Studio picker had it.
- `SHADER_SECTIONS` moves here from `ShaderStudioSurface.vue` (L334).

**Switch the four catalog refs to the live one** (this is what lets drafts and new My effects show up):
- `ShaderStudioSurface.vue`: `const catalog = ref<ShaderFxCatalog | null>(null)` becomes `const catalog = useShaderCatalog()`. Delete the assignment `catalog.value = await fetchShaderFxCatalog()` (~L821), but keep any code after it that needed the catalog, behind a `watch(catalog, …, { immediate: true })` or a `await fetchShaderFxCatalog()` call whose result is ignored.
- Do the same in `ShaderFillEditor.vue` (`loadCatalog`), `ShaderEffectNode.vue` (~L312) and the Frame effect-stack block of `CompositorModal.vue` (~L2684, `loadShaderFxCatalog`). Grep each file for every other `catalog.value =` write first.
- **Don't change their pickers yet** (Task 10).

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command, plus `npx vitest run tests/unit/shaderfill-*.unit.spec.ts tests/unit/shader-agent-vocab.unit.spec.ts`. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`. Any spec that stubs `$fetch` for `/sailor/shader_effects` alone now also sees a `/api/my-effects` call. Make those stubs answer `{ effects: [] }` for it; don't change the behaviour under test.
- Typecheck all touched files. For `CompositorModal.vue`, follow the shared-file protocol.
- Commit.
- Message: `feat(shaderfx): one live catalog with My effects merged in; useMyEffects saves, versions, renames, removes and adopts; one gallery helper for every picker`

---

### Task 6: WebGL context-loss recovery for `ShaderFxRenderer`

**Files:**
- Create: `frontend/app/lib/shaderfx/contextWatch.ts`
- Modify: `frontend/app/lib/shaderfx/renderer.ts`
- Modify: `frontend/app/components/vue-canvas/ShaderEffectNode.vue`, `ShaderStudioSurface.vue` (re-render on restore)
- Test: `frontend/tests/unit/shaderfx-context-watch.unit.spec.ts`

**Interfaces:**
- Produces:
  - `attachContextWatch(target: EventTarget, hooks: { onLost(): void; onRestored(): void }): () => void`
  - `class ShaderFxContextLostError extends Error`
  - `ShaderFxRenderer#isContextLost(): boolean`
  - `ShaderFxRenderer#onContextChange(fn: (state: 'lost' | 'restored') => void): () => void`
  - `render()` throws `ShaderFxContextLostError` while the context is lost

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/shaderfx-context-watch.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { attachContextWatch } from '~/lib/shaderfx/contextWatch'

describe('attachContextWatch', () => {
  it('prevents the default on loss (or the browser never restores) and reports both events', () => {
    const t = new EventTarget()
    const onLost = vi.fn(), onRestored = vi.fn()
    const detach = attachContextWatch(t, { onLost, onRestored })
    const lost = new Event('webglcontextlost', { cancelable: true })
    t.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(onLost).toHaveBeenCalledTimes(1)
    t.dispatchEvent(new Event('webglcontextrestored'))
    expect(onRestored).toHaveBeenCalledTimes(1)
    detach()
    t.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})

describe('ShaderFxRenderer wiring (source guard: the renderer needs real WebGL)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/lib/shaderfx/renderer.ts', import.meta.url)), 'utf8')
  it('watches its canvas when it creates it, and refuses to render while lost', () => {
    expect(src).toMatch(/attachContextWatch\(this\.canvas/)
    expect(src).toMatch(/throw new ShaderFxContextLostError/)
    expect(src).toMatch(/onContextChange\(/)
  })
  it('drops every GL handle on loss so the next render rebuilds them', () => {
    const drop = src.slice(src.indexOf('private dropHandles'), src.indexOf('}', src.indexOf('this.liveTex = new Map')) )
    for (const f of ['programs', 'blit', 'composite', 'mask', 'fboTex', 'fbos', 'holdTex', 'layerSrcTex', 'baseTex', 'extraTexCache', 'liveTex']) expect(drop).toContain(f)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/shaderfx-context-watch.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/shaderfx/contextWatch.ts
/** WebGL context loss (AI in Sailor spec §7.5): a shader that hangs the GPU
 *  makes the browser drop the context. preventDefault on `webglcontextlost` is
 *  what lets `webglcontextrestored` fire at all (Scene3D's engine does the same). */
export function attachContextWatch(target: EventTarget, hooks: { onLost(): void; onRestored(): void }): () => void {
  const lost = (e: Event) => { e.preventDefault(); hooks.onLost() }
  const restored = () => hooks.onRestored()
  target.addEventListener('webglcontextlost', lost)
  target.addEventListener('webglcontextrestored', restored)
  return () => { target.removeEventListener('webglcontextlost', lost); target.removeEventListener('webglcontextrestored', restored) }
}
```

**`renderer.ts`:**
- Export `class ShaderFxContextLostError extends Error { name = 'ShaderFxContextLostError' }`.
- Add fields: `private lost = false`, `private listeners = new Set<(s: 'lost' | 'restored') => void>()` and `private detachWatch: (() => void) | null = null`.
- In `ensure()`, right after the canvas is created: `this.detachWatch = attachContextWatch(this.canvas, { onLost: () => { this.lost = true; this.dropHandles(); this.emit('lost') }, onRestored: () => { this.lost = false; this.emit('restored') } })`.
- Add `private dropHandles()`, which sets every GL handle field to its empty value **without calling `gl.delete*`** (the context is gone):
  - `programs.clear()`;
  - `blit`, `composite` and `mask` to null;
  - `fboTex`, `fbos` to `[null, null]`;
  - `holdTex`, `holdFbo`, `layerSrcTex`, `layerSrcFbo` and `baseTex` to null;
  - `baseSize` and `fboSize` to `[0, 0]`;
  - `extraTexCache` to a new `Map`, and `liveTex` to a new `Map`.

  Keep `this.gl` and `this.canvas`: after a restore the same context object is usable again, and `ensure()` / `program()` rebuild whatever is null. Check how `ensure()` decides to create the FBOs and the blit program. If it only does that inside `if (!this.gl)`, move that setup behind its own null checks (`if (!this.blit) …`, and FBO allocation when `fboSize` doesn't match), so a rebuild happens after restore.
- `render()`: first line `if (this.lost) throw new ShaderFxContextLostError('The graphics context was lost')`.
- `isContextLost() { return this.lost }`.
- `onContextChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }`, with a private `emit(s)` that calls each listener inside `try {} catch {}`.
- `dispose()` calls `this.detachWatch?.()`.

**Re-render on restore:**
- `ShaderEffectNode.vue`: in `onMounted`, `const off = shaderFx.onContextChange(s => { if (s === 'restored') <the node's existing re-render call> })`. Grep for what `onUpstreamChange` or the params watcher calls to redraw. Call `off()` in `onBeforeUnmount`.
- `ShaderStudioSurface.vue`: the same, calling `renderFrame(0)` (or the playing loop's next frame).
- Thumbnails already catch render errors and return `''`, and they aren't cached, so they redraw on the next open.

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/shaderfx-context-watch.unit.spec.ts tests/unit/shaderfx-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck `renderer.ts`, `contextWatch.ts` and the two components.
- Commit.
- Message: `feat(shaderfx): recover from WebGL context loss — preventDefault, drop GL handles, rebuild lazily, re-render on restore`

---

### Task 7: `useEffectTakes` — one shader-generation session against a target

**Files:**
- Create: `frontend/app/composables/useEffectTakes.ts`
- Test: `frontend/tests/unit/use-effect-takes.unit.spec.ts`

**Interfaces:**
- Consumes:
  - Task 2: `generateTakes`, `EngineTake`, `isAbortError`, `ContextLostError`, `productEngineInput`, `imageForModel`, `placeholderSource`;
  - Task 1: `makeCallModel`;
  - `createBrowserTakeRenderer`, `toEffectDef`;
  - Task 5: `registerEffects`, `unregisterEffects`, `useMyEffects`;
  - Task 6: `shaderFx.onContextChange`;
  - stage 3: `openTakes`, `hoverTile`, `chooseTile`, `failPending`, `shownTakeId`, `CURRENT`, `TakesSession`.
- Produces:

```ts
export interface EffectTarget {
  /** Stable key for the thing the takes land on (a node id, 'shader-studio', 'frame-background'). */
  key: string
  /** Its own name, for the strip ("Water ripple", "Background"). */
  label: string
  /** The effect being remixed; null makes a new one. A version def resolves to its My effect. */
  base: EffectDef | null
  /** The picture under the effect; null → a neutral placeholder (and no image to the model). */
  image: () => CanvasImageSource | null
  /** Show a take (a registered draft id) on the target; null restores what was there. */
  preview: (effectId: string | null) => void
  /** Keep: point the target at a saved effect with these dial values. */
  apply: (effectId: string, values: Record<string, ParamValue>) => void
}
export const EFFECT_MESSAGES: { contextLost: string; droppedTake: string; saveFailed: (why: string) => string; savedNew: (name: string) => string; savedVersion: (label: string, name: string) => string }
export function useEffectTakes(deps?: {
  generate?: typeof generateTakes
  callModel?: EngineDeps['callModel']
  renderer?: (src: CanvasImageSource) => TakeRenderer
  input?: typeof productEngineInput
  library?: Pick<ReturnType<typeof useMyEffects>, 'saveTake' | 'addCodeVersion'>
  register?: typeof registerEffects
  unregister?: typeof unregisterEffects
  onContextChange?: (fn: (s: 'lost' | 'restored') => void) => () => void
}): {
  session: ShallowRef<TakesSession | null>
  target: ShallowRef<EffectTarget | null>
  request: Ref<string>
  working: ComputedRef<boolean>
  error: Ref<string>
  notice: Ref<string>
  start(request: string, target: EffectTarget): Promise<void>
  preview(id: string | null): void
  choose(id: string): void
  keep(id: string): Promise<boolean>
  close(): void
  more(): Promise<void>
  stop(): void
  clearMessages(): void
}
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/use-effect-takes.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useEffectTakes, EFFECT_MESSAGES, type EffectTarget } from '~/composables/useEffectTakes'
import { generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'
import { TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { CURRENT } from '~/lib/prompt/takesSession'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })
const renderer: TakeRenderer = { compile: () => null, judge: () => ({ pass: true, flags: [], thumbnail: 'data:thumb' }), sheet: () => '' }
const slotOf = (p: string) => TAKE_ANGLES.findIndex(a => p.includes(a))
/** The spike's takes as canned replies; `gate` lets a test release each slot in turn. */
function cannedModel() {
  const gates = [0, 1, 2].map(() => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } })
  const callModel = vi.fn(async (prompt: string, _i?: string[], signal?: AbortSignal) => {
    const s = slotOf(prompt)
    await Promise.race([gates[s]!.p, new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))])
    return { text: JSON.stringify(SPIKE_TAKES.rain![s]) }
  })
  return { callModel, release: (s: number) => gates[s]!.open() }
}
function target(over: Partial<EffectTarget> = {}): EffectTarget & { preview: any; apply: any } {
  return { key: 'n1', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn(), ...over } as any
}
function setup(extra: Record<string, any> = {}) {
  const { callModel, release } = cannedModel()
  const library = {
    saveTake: vi.fn(async (take: any) => ({ id: 'mine_aaaaaaaaaaaa', name: take.name, versions: [{ label: 'v1', body: take.body, params: take.params, values: {}, note: '', createdAt: '' }] })),
    addCodeVersion: vi.fn(async (id: string, take: any) => ({ id, name: 'Rain', versions: [{ label: 'v1', body: 'a', params: take.params, values: {} }, { label: 'v2', body: take.body, params: take.params, values: {} }] })),
  }
  const register = vi.fn(), unregister = vi.fn()
  let ctxListener: ((s: 'lost' | 'restored') => void) | null = null
  let api!: ReturnType<typeof useEffectTakes>
  mount(defineComponent({ setup() {
    api = useEffectTakes({
      generate: generateTakes, callModel, renderer: () => renderer,
      input: async (o) => ({ request: o.request, count: 3, signal: o.signal }),
      library: library as any, register, unregister,
      onContextChange: (fn) => { ctxListener = fn; return () => {} },
      ...extra,
    })
    return () => h('div')
  } }))
  return { api, release, callModel, library, register, unregister, lose: () => ctxListener?.('lost') }
}
const tick = () => new Promise(r => setTimeout(r, 0))

describe('useEffectTakes', () => {
  it('three pending tiles; each take lands on a tile as it passes, registered as a draft', async () => {
    const { api, release, register } = setup()
    const run = api.start('rain on a window', target())
    await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(api.session.value!.nodeLabel).toBe('Water ripple')
    release(1); await tick(); await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'pending'])
    const first = register.mock.calls[0]![0][0]
    expect(first).toMatchObject({ draft: true, name: SPIKE_TAKES.rain![1]!.name })
    expect(api.session.value!.tiles[0]!.takeId).toBe(first.id)
    expect(api.session.value!.tiles[0]!.thumb).toBe('data:thumb')
    release(0); release(2); await run
    expect(api.session.value!.tiles.every(t => t.state === 'ready')).toBe(true)
    expect(api.session.value!.loopDone).toBe(true)
    expect(api.working.value).toBe(false)
  })

  it('hover previews on the target; leaving goes back; choose sticks', async () => {
    const { api, release } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[1]!.takeId!
    api.preview(id); expect(tg.preview).toHaveBeenLastCalledWith(id)
    api.preview(null); expect(tg.preview).toHaveBeenLastCalledWith(null)
    api.choose(id); api.preview(null); expect(tg.preview).toHaveBeenLastCalledWith(id)
    api.preview(CURRENT); expect(tg.preview).toHaveBeenLastCalledWith(null)
  })

  it('Keep on a new effect saves a My effect, applies it, drops the drafts, and says so', async () => {
    const { api, release, library, unregister } = setup()
    const tg = target({ base: { id: 'water_ripple', name: 'Water ripple' } as any })
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[0]!.takeId!
    expect(await api.keep(id)).toBe(true)
    expect(library.saveTake).toHaveBeenCalledWith(expect.objectContaining({ body: expect.any(String) }), { request: 'rain', from: 'Water ripple' })
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', expect.any(Object))
    expect(unregister).toHaveBeenCalledWith(expect.arrayContaining([id]))
    expect(api.session.value).toBeNull()
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedNew(SPIKE_TAKES.rain![0]!.name))
  })

  it('Keep on a Remix of a My effect adds a version to it (an old-version def resolves to its effect)', async () => {
    const { api, release, library } = setup()
    const tg = target({ base: { id: 'mine_aaaaaaaaaaaa~v1', name: 'Rain · v1', mine: true, versionOf: 'mine_aaaaaaaaaaaa' } as any })
    const run = api.start('heavier', tg); release(0); release(1); release(2); await run
    await api.keep(api.session.value!.tiles[0]!.takeId!)
    expect(library.addCodeVersion).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', expect.any(Object), 'heavier')
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedVersion('v2', 'Rain'))
  })

  it('a failed save keeps the strip open and shows why', async () => {
    const { api, release, library } = setup()
    library.saveTake.mockRejectedValueOnce(new Error('409'))
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(false)
    expect(api.session.value).not.toBeNull()
    expect(api.error.value).toContain('409')
    expect(tg.apply).not.toHaveBeenCalled()
  })

  it('Stop aborts the request, restores the target and clears partial takes', async () => {
    const { api, release } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); await tick(); await tick()
    api.stop(); await run
    expect(api.session.value).toBeNull()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.error.value).toBe('')
  })

  it('× closes: restore, drop drafts', async () => {
    const { api, release, unregister } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    api.close()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(unregister).toHaveBeenCalled()
    expect(api.session.value).toBeNull()
  })

  it('context loss while a take is on screen drops THAT take and restores', async () => {
    const { api, release, lose } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[2]!.takeId!
    api.choose(id)
    lose()
    expect(api.session.value!.tiles[2]!.state).toBe('failed')
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.notice.value).toBe(EFFECT_MESSAGES.droppedTake)
  })

  it('an engine context loss ends the run with a plain message and nothing changed', async () => {
    const { ContextLostError } = await import('~/lib/shadergen/engine')
    const { api } = setup({ generate: vi.fn(async () => { throw new ContextLostError('gone') }) })
    const tg = target()
    await api.start('rain', tg)
    expect(api.session.value).toBeNull()
    expect(api.error.value).toBe(EFFECT_MESSAGES.contextLost)
    expect(tg.apply).not.toHaveBeenCalled()
  })

  it('Three more only once the set is done; it starts a fresh set', async () => {
    const { api, release, callModel } = setup()
    const run = api.start('rain', target()); release(0); release(1); release(2); await run
    const n = callModel.mock.calls.length
    void api.more(); await tick()
    expect(callModel.mock.calls.length).toBe(n + 3)
    expect(api.session.value!.tiles.every(t => t.state === 'pending')).toBe(true)
  })
})
```

In "Three more", the gates are already open, so the new calls resolve at once. The assertion checks that three new calls went out and that the session was reset.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/use-effect-takes.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// frontend/app/composables/useEffectTakes.ts
/**
 * One shader-generation session (AI in Sailor spec §3.1, §7.2–§7.5; stage 5
 * plan). Three takes are written in parallel; each one that passes the checks
 * is registered as a DRAFT EffectDef and lands on the next pending tile of a
 * stage 3 TakesSession, so PromptTakes shows it at once. Hover previews it on
 * the target; Keep saves a My effect (or a new version of the one being
 * remixed) and applies it; × and Stop restore the target and drop the drafts.
 * A lost graphics context drops the take that was on screen.
 */
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef } from 'vue'
import { ContextLostError, generateTakes, isAbortError, type EngineDeps, type EngineTake, type TakeRenderer } from '~/lib/shadergen/engine'
import { createBrowserTakeRenderer } from '~/lib/shadergen/browserRenderer'
import { makeCallModel } from '~/lib/shadergen/client'
import { toEffectDef } from '~/lib/shadergen/effectDef'
import { imageForModel, placeholderSource, productEngineInput } from '~/lib/shadergen/productRequest'
import { valuesForVersion, effectIdForVersion } from '~/lib/myEffects/defs'
import { registerEffects, unregisterEffects } from '~/lib/shaderfx/catalog'
import { shaderFx } from '~/lib/shaderfx/renderer'
import { useMyEffects } from '~/composables/useMyEffects'
import { chooseTile, CURRENT, failPending, hoverTile, openTakes, shownTakeId, type TakesSession } from '~/lib/prompt/takesSession'
import type { EffectDef, ParamValue } from '~/lib/shaderfx/types'

export interface EffectTarget { /* as in Interfaces above */ }

export const EFFECT_MESSAGES = {
  contextLost: 'The graphics card stopped responding while the new effects were being tested. Nothing was changed.',
  droppedTake: 'That take stopped the graphics card, so it was dropped.',
  saveFailed: (why: string) => `Couldn’t save to My effects: ${why}`,
  savedNew: (name: string) => `Saved to My effects as “${name}”.`,
  savedVersion: (label: string, name: string) => `Saved as ${label} of “${name}”. Earlier versions are kept.`,
}

let runs = 0

export function useEffectTakes(deps: { /* as in Interfaces */ } = {}) {
  const generate = deps.generate ?? generateTakes
  const register = deps.register ?? registerEffects
  const unregister = deps.unregister ?? unregisterEffects
  const buildInput = deps.input ?? productEngineInput
  const library = deps.library ?? useMyEffects()
  const apiKey = () => useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey') ?? ''
  const callModel = deps.callModel ?? ((p: string, i?: string[], s?: AbortSignal) => makeCallModel(apiKey(), 'shader')(p, i, s))
  const makeRenderer = deps.renderer ?? createBrowserTakeRenderer

  const session = shallowRef<TakesSession | null>(null)
  const target = shallowRef<EffectTarget | null>(null)
  const request = ref('')
  const running = ref(false)
  const error = ref('')
  const notice = ref('')
  const taken = new Map<string, EngineTake>() // draft id → take
  let ctrl: AbortController | null = null
  let seq = 0

  const working = computed(() => running.value)
  const show = () => { const s = session.value; if (s) target.value?.preview(shownTakeId(s)) }
  function dropDrafts() { if (taken.size) unregister([...taken.keys()]); taken.clear() }
  function end() { target.value?.preview(null); dropDrafts(); session.value = null; running.value = false }
  const clearMessages = () => { error.value = ''; notice.value = '' }

  async function start(text: string, t: EffectTarget) {
    ctrl?.abort()
    if (session.value) end()
    clearMessages()
    const run = ++seq
    const runId = ++runs
    const c = ctrl = new AbortController()
    target.value = t
    request.value = text.trim()
    session.value = { ...openTakes({ nodeId: t.key, nodeLabel: t.label, request: text, takes: [] }), loopDone: false }
    running.value = true
    const src = t.image()
    try {
      const input = await buildInput({ request: request.value, base: t.base, image: imageForModel(src), signal: c.signal })
      const renderer: TakeRenderer = makeRenderer(src ?? placeholderSource())
      const engineDeps: EngineDeps = {
        callModel, renderer,
        onTake: (et, slot) => {
          if (run !== seq || !session.value) return
          const id = `draft_${runId}_${slot}`
          taken.set(id, et)
          register([{ ...toEffectDef(et.take, id), draft: true }])
          const s = session.value
          const i = s.tiles.findIndex(x => x.state === 'pending')
          if (i < 0) return
          const tiles = s.tiles.slice()
          tiles[i] = { state: 'ready', takeId: id, promptId: null, thumb: et.thumbnail }
          session.value = { ...s, tiles }
        },
      }
      await generate(input, engineDeps)
      if (run !== seq || !session.value) return
      session.value = { ...failPending(session.value), loopDone: true }
    } catch (e) {
      if (run !== seq) return
      if (isAbortError(e)) return // Stop already ended the session
      error.value = e instanceof ContextLostError ? EFFECT_MESSAGES.contextLost : String((e as Error)?.message ?? e)
      end()
    } finally {
      if (run === seq) running.value = false
    }
  }

  function preview(id: string | null) { const s = session.value; if (!s) return; session.value = hoverTile(s, id); show() }
  function choose(id: string) { const s = session.value; if (!s) return; session.value = chooseTile(s, id); show() }

  async function keep(id: string): Promise<boolean> {
    const s = session.value, t = target.value, et = taken.get(id)
    if (!s || !t || !et || id === CURRENT) return false
    const base = t.base
    const baseMine = base?.mine ? (base.versionOf ?? base.id) : null
    try {
      const rec = baseMine
        ? await library.addCodeVersion(baseMine, et.take, request.value)
        : await library.saveTake(et.take, { request: request.value, from: base && !base.draft ? base.name : null })
      const last = rec.versions.length - 1
      dropDrafts()
      session.value = null
      t.apply(effectIdForVersion(rec, last), valuesForVersion(rec, last))
      notice.value = baseMine ? EFFECT_MESSAGES.savedVersion(rec.versions[last]!.label, rec.name) : EFFECT_MESSAGES.savedNew(rec.name)
      return true
    } catch (e) {
      error.value = EFFECT_MESSAGES.saveFailed(String((e as Error)?.message ?? e))
      return false
    }
  }

  function close() { ctrl?.abort(); seq++; end() }
  function stop() { close() }
  async function more() {
    const s = session.value, t = target.value
    if (!s || !t || !s.loopDone) return
    const text = request.value
    close()
    await start(text, t)
  }

  // Spec §7.5: a take that hangs the GPU while previewed is dropped, and the target restored.
  const offCtx = (deps.onContextChange ?? ((fn) => shaderFx.onContextChange(fn)))((state) => {
    const s = session.value
    if (state !== 'lost' || !s) return
    const shown = shownTakeId(s)
    if (!shown) return
    target.value?.preview(null)
    unregister([shown]); taken.delete(shown)
    session.value = { ...s, hovered: null, chosen: null, tiles: s.tiles.map(x => (x.takeId === shown ? { ...x, state: 'failed' as const, takeId: null, thumb: null } : x)) }
    notice.value = EFFECT_MESSAGES.droppedTake
  })
  if (getCurrentInstance()) onBeforeUnmount(() => { offCtx(); if (session.value || running.value) close() })

  return { session, target, request, working, error, notice, start, preview, choose, keep, close, more, stop, clearMessages }
}
```

Notes for the implementer:
- **The Keep order is deliberate:** `dropDrafts()` then `apply()`. The target's `apply` replaces the draft id it was previewing with the saved id, so there is never a frame where the target points at an unregistered draft **and** is expected to render it.
- **`useLocalSettings`** is a Nuxt auto-import. The test stubs it on `globalThis`.
- **`base` resolution:** `addCodeVersion` needs the record id, so an old-version def (`versionOf`) resolves to its effect (Ruling 8).

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS (10 tests).

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck `useEffectTakes.ts`.
- Commit.
- Message: `feat(shadergen): useEffectTakes — three effect takes land on tiles one by one, preview on the target, Keep saves to My effects or adds a version, Stop and context loss restore`

---

### Task 8: The canvas — Remix and New effect on shader effect nodes

**Files:**
- Modify: `frontend/app/lib/prompt/canvasDispatch.ts`
- Modify: `frontend/app/composables/useCanvasPrompt.ts` (shared-file protocol)
- Modify: `frontend/app/components/vue-canvas/ShaderEffectNode.vue`
- Modify: `frontend/app/lib/canvas/nodeActions.ts`
- Modify: `frontend/app/components/prompt/SailorPrompt.vue` (a `note` prop)
- Modify: `frontend/app/components/prompt/CanvasPromptHost.vue` (pass `note`; this is stage 3 Task 9's file)
- Test: update `frontend/tests/unit/canvas-dispatch.unit.spec.ts` (stage 3's name; grep for the file that tests `canvasDispatch`); add `frontend/tests/unit/canvas-prompt-effects.unit.spec.ts`, `frontend/tests/unit/node-actions-shader.unit.spec.ts`

**Interfaces:**
- Consumes: Task 7 `useEffectTakes`, `EffectTarget`; Task 1 `shaderGenEstimateText`; `getEffectSync`; `hostedModeEnabled`.
- Produces:
  - `CanvasDispatch` gains `{ worker: 'effect'; nodeId: string }`.
  - `DISPATCH_MESSAGES.newEffect` is `'New effects are made on a shader effect. Select a shader effect node, or open the Shader studio.'`.
  - `PromptMode` gains `effectId: string | null`, the gallery's Remix base. `sailor:promptMode` detail gains an optional `effectId`.
  - `useCanvasPrompt(canvas, deps?: { route?; effects?: ReturnType<typeof useEffectTakes> })` additionally returns `modeNote: ComputedRef<string | null>`. The returned `takes` is the effect session when one is open.
  - Window events handled by `ShaderEffectNode`:
    - `sailor:shaderEffectTarget` `{ nodeId, reply(o: { image: CanvasImageSource | null; effectId: string; title: string }) }`, synchronous;
    - `sailor:shaderEffectPreview` `{ nodeId, effectId: string | null }`;
    - `sailor:shaderEffectApply` `{ nodeId, effectId, values }`.
  - `SailorPrompt` prop `note?: string | null` (testid `prompt-note`).
  - `SHADER_GEN_ACTION_HINT` is `shaderGenEstimateText(false)`. `nodeActions` for type `shader-effect` returns `remix-effect` and `new-effect`.

- [ ] **Step 1: Write the failing tests**

```ts
// in the canvasDispatch spec — replace the stage 3 'new-effect has no canvas worker yet' case:
  it('new-effect runs on a selected shader effect node, and points elsewhere otherwise', () => {
    expect(canvasDispatch('new-effect', 'rain', { nodeId: 's1', type: 'shader-effect', hasImages: false, hasUpstream: true, label: 'Water ripple' }))
      .toEqual({ worker: 'effect', nodeId: 's1' })
    expect(canvasDispatch('new-effect', 'rain', img())).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(canvasDispatch('new-effect', 'rain', null)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
  })
```

```ts
// frontend/tests/unit/node-actions-shader.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { actionHint, actionPrice, actionsFor } from '~/lib/canvas/nodeActions'

describe('shader effect node actions (spec §7.3)', () => {
  const ctx = { nodeId: 's1', type: 'shader-effect', hasImages: false, hasUpstream: true } as any
  it('Develop has Remix… and New effect…, both three takes with the estimate', () => {
    const { edit, develop } = actionsFor(ctx)
    expect(edit).toEqual([])
    expect(develop.map(a => a.label)).toEqual(['Remix…', 'New effect…'])
    for (const a of develop) expect(actionHint(a, actionPrice(a, null, false))).toBe('3 takes · ~$0.24–0.42')
  })
  it('each sets a mode chip on the node, with no request sent', () => {
    const seen: any[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('sailor:promptMode', on)
    for (const a of actionsFor(ctx).develop) a.run(ctx)
    window.removeEventListener('sailor:promptMode', on)
    expect(seen).toEqual([{ label: 'Remix', kind: 'new-effect', nodeId: 's1' }, { label: 'New effect', kind: 'new-effect', nodeId: 's1' }])
  })
})
```

(Give this spec `// @vitest-environment happy-dom` if `window` is needed. Check how stage 2's node-action spec does it.)

```ts
// frontend/tests/unit/canvas-prompt-effects.unit.spec.ts
// @vitest-environment happy-dom
// useCanvasPrompt hands new-effect to the effect session with a target built from
// the shader node; the takes card, working label, Stop and Keep all go through it.
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick, shallowRef, ref, computed } from 'vue'
import { mount } from '@vue/test-utils'
;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })
;(globalThis as any).useRuntimeConfig = () => ({ public: { hostedMode: false } })
import { useCanvasPrompt } from '~/composables/useCanvasPrompt'

function fakeEffects() {
  const session = shallowRef<any>(null)
  return {
    session, target: shallowRef(null), request: ref(''), working: computed(() => false), error: ref(''), notice: ref(''),
    start: vi.fn(async (_r: string, t: any) => { session.value = { nodeId: t.key, nodeLabel: t.label, request: _r, tiles: [], known: [], hovered: null, chosen: null, currentThumb: null } }),
    preview: vi.fn(), choose: vi.fn(), keep: vi.fn(async () => true), close: vi.fn(() => { session.value = null }), more: vi.fn(), stop: vi.fn(), clearMessages: vi.fn(),
  }
}
function fakeCanvas() {
  const node = { id: 's1', type: 'shader-effect', data: { title: 'Water ripple' } }
  return {
    agentSnapshot: vi.fn(), agentPreview: vi.fn(), agentSelection: [{ id: 's1', title: 'Water ripple', type: 'shader-effect', hasImages: false }],
    getNodes: () => [node], getEdges: () => [],
  }
}

describe('useCanvasPrompt: new effects on a shader node', () => {
  it('a Remix chip runs the effect session against the node, without the router', async () => {
    const effects = fakeEffects()
    const route = vi.fn()
    const replies: any[] = []
    window.addEventListener('sailor:shaderEffectTarget', (e: any) => e.detail.reply({ image: null, effectId: 'water_ripple', title: 'Water ripple' }))
    window.addEventListener('sailor:shaderEffectPreview', (e: any) => replies.push(['preview', e.detail]))
    let api!: ReturnType<typeof useCanvasPrompt>
    const c = fakeCanvas()
    mount(defineComponent({ setup() { api = useCanvasPrompt(() => c, { route, effects: effects as any }); return () => h('div') } }))
    window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label: 'Remix', kind: 'new-effect', nodeId: 's1' } }))
    expect(api.modeNote.value).toBe('~$0.24–0.42')
    await api.submit('rain on a window')
    expect(route).not.toHaveBeenCalled() // the chip decides the kind (spec §4)
    expect(effects.start).toHaveBeenCalledWith('rain on a window', expect.objectContaining({ key: 's1', label: 'Water ripple' }))
    const t = effects.start.mock.calls[0]![1]
    t.preview('draft_1_0')
    expect(replies.at(-1)).toEqual(['preview', { nodeId: 's1', effectId: 'draft_1_0' }])
    expect(api.card.value).toBe('takes')
    expect(api.takes.value!.nodeId).toBe('s1')
    api.previewTake('draft_1_0'); expect(effects.preview).toHaveBeenCalledWith('draft_1_0')
    await api.keepTake('draft_1_0'); expect(effects.keep).toHaveBeenCalledWith('draft_1_0')
    api.stop(); expect(effects.stop).toHaveBeenCalled()
  })
  it('a gallery Remix of ANOTHER effect uses that effect as the base', async () => {
    // same set-up; dispatch sailor:promptMode with effectId: 'glow_soft'; stub getEffectSync via vi.mock('~/lib/shaderfx/catalogStore', …) to return { id: 'glow_soft', name: 'Soft glow' }
    // expect effects.start's target.base.id === 'glow_soft'
  })
})
```

Write the second case out fully. Mock `~/lib/shaderfx/catalogStore`'s `getEffectSync` with `vi.mock` at the top of the file (`vi.mock('~/lib/shaderfx/catalogStore', async (orig) => ({ ...(await orig()), getEffectSync: (id: string) => ({ id, name: id === 'glow_soft' ? 'Soft glow' : 'Water ripple', params: [], source: '' }) }))`).

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/node-actions-shader.unit.spec.ts tests/unit/canvas-prompt-effects.unit.spec.ts <the canvasDispatch spec>`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`canvasDispatch.ts`:**
- Add `| { worker: 'effect'; nodeId: string }` to `CanvasDispatch`.
- Add `export const SHADER_NODE_TYPES = new Set(['shader-effect'])`.
- Change the `new-effect` case to: `if (target && SHADER_NODE_TYPES.has(target.type)) return { worker: 'effect', nodeId: target.nodeId }`, and otherwise the message.
- Reword `DISPATCH_MESSAGES.newEffect` (Ruling 23).

**`nodeActions.ts`:**

```ts
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
/** Remix / New effect cost (spec §7.2 estimate), shown like every other fixed priceHint. */
export const SHADER_GEN_ACTION_HINT = shaderGenEstimateText(false)
const mode = (c: NodeActionCtx, label: string) => fire('sailor:promptMode', { label, kind: 'new-effect', nodeId: c.nodeId })
const SHADER: NodeAction[] = [
  { id: 'remix-effect', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', priceHint: SHADER_GEN_ACTION_HINT, run: c => mode(c, 'Remix') },
  { id: 'new-effect', label: 'New effect…', group: 'develop', ai: true, lands: 'takes', priceHint: SHADER_GEN_ACTION_HINT, run: c => mode(c, 'New effect') },
]
// listFor: if (type === 'shader-effect') return SHADER
```

`actionsFor` already hides `FIX` for a node without images; `SHADER` doesn't include it.

**`SailorPrompt.vue`:**
- Add the prop `note?: string | null` (default null).
- Render it inside the row, right-aligned just before the send button, only when `note && !working`: `<span v-if="note && !working" data-testid="prompt-note" class="shrink-0 text-[11px] tabular-nums text-white/40">{{ note }}</span>`.
- It's neutral grey, never pastel.
- Add a one-line comment: "The price of what the mode chip will do (spec §7.2), shown before anything runs."

**`ShaderEffectNode.vue`:**

```ts
// Shader generation (stage 5): the prompt asks this node for its picture and
// effect, previews takes on it, and applies the kept one.
const previewEffectId = ref<string | null>(null)
// effectId computed becomes: previewEffectId.value ?? String(widgetVal('effect') ?? '')
function onEffectTarget(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id) return
  d.reply({ image: baseImage.value ?? null, effectId: String(widgetVal('effect') ?? ''), title: <the node's shown title> })
}
function onEffectPreview(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id) return
  previewEffectId.value = d.effectId ?? null
  <the node's existing re-render call>
}
function onEffectApply(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id) return
  previewEffectId.value = null
  setWidget('effect', d.effectId)
  setWidget('params', JSON.stringify(d.values ?? {}))
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
}
// register in onMounted / remove in onBeforeUnmount alongside sailor:shaderfx-changed
```

- Find the name of the node's base-image ref (`baseImage`) and its re-render function by grepping `renderThumb`, `onUpstreamChange` and `baseImage`.
- While `previewEffectId` is set, the params the node renders with are `{}` (defaults): make the params computed read `previewEffectId.value ? '{}' : widgetVal('params')`.

**`useCanvasPrompt.ts`** (follow the shared-file protocol; it has uncommitted foreign hunks):
- `deps` gains `effects?: ReturnType<typeof useEffectTakes>`, and `const fx = deps.effects ?? useEffectTakes()`.
- `PromptMode` gains `effectId: string | null`. `onPromptMode` stores `d.effectId != null ? String(d.effectId) : null`.
- Build the node target:

```ts
function effectTargetFor(nodeId: string, baseEffectId: string | null): EffectTarget | null {
  let info: { image: CanvasImageSource | null; effectId: string; title: string } | null = null
  window.dispatchEvent(new CustomEvent('sailor:shaderEffectTarget', { detail: { nodeId, reply: (o: any) => { info = o } } }))
  if (!info) return null
  const i = info as { image: CanvasImageSource | null; effectId: string; title: string }
  const fire = (name: string, detail: object) => window.dispatchEvent(new CustomEvent(name, { detail: { nodeId, ...detail } }))
  return {
    key: nodeId,
    label: targetFor(nodeId)?.label || i.title,
    base: getEffectSync(baseEffectId ?? i.effectId),
    image: () => i.image,
    preview: effectId => fire('sailor:shaderEffectPreview', { effectId }),
    apply: (effectId, values) => fire('sailor:shaderEffectApply', { effectId, values }),
  }
}
```

  **Which base:** the chip "New effect" makes a new effect, so `base` is null. "Remix" remixes the gallery's `effectId`, or the node's own effect. A routed `new-effect` (no chip) is a Remix of the node's effect. In code: `const base = m?.label === 'New effect' ? null : (m?.effectId ?? null)`, and pass `baseEffectId: base` / `newEffect: m?.label === 'New effect'` through `run`.
- **`run()`:** handle `if (d.worker === 'effect') { const t = effectTargetFor(d.nodeId, o.effectId ?? null); if (!t) { notice.value = DISPATCH_MESSAGES.newEffect; return } if (o.newEffect) t.base = null; void fx.start(text, t); return }`. Add `effectId?: string | null; newEffect?: boolean` to `run`'s options, passed from `submit` (the mode) and from `onPromptKind`.
- **In `submit`:** when the mode is `new-effect`, skip the router, because the mode decides the kind (spec §4). The route call already passes `mode` to the router, which returns `new-effect` for 'Remix'. Skip the call to save the credit and the latency: `if (m?.kind === 'new-effect') { run('new-effect', p, { nodeId: m.nodeId, effectId: m.effectId, newEffect: m.label === 'New effect' }); return }`. Put this before the sketch fast path check. A mode never takes the fast path anyway (`!m`), but the early return makes the order explicit.
- **Takes:** the returned `takes` becomes `computed(() => fx.session.value ?? takes.value)`. Keep the internal `takes` ref unchanged.
  - `card`: `if (fx.session.value || takes.value) return 'takes'`.
  - `previewTake`, `chooseTake`, `keepTake`, `closeTakes`, `moreTakes` each start with `if (fx.session.value) return fx.<same>(…)`.
  - `stop()` starts with `if (fx.working.value || fx.session.value) { fx.stop(); return }`, after the routing check.
- **`working`** adds `|| fx.working.value`.
- **`workingLabel`:** when `fx.working.value`, return `` `${promptWorkingLabel({ request: fx.request.value })} · ${shaderGenEstimateText(hosted)}` `` (Ruling 14). `hosted = hostedModeEnabled(useRuntimeConfig().public)`.
- **`answerCard`:** an `fx.error` shows as an error card and an `fx.notice` as a notice card, checked before the agent's. `dismissAnswer` also calls `fx.clearMessages()`.
- **`modeNote`:** `computed(() => mode.value?.kind === 'new-effect' ? shaderGenEstimateText(hosted) : null)`.
- **`jobBusy`** includes `fx.working.value`.
- **`clearResults()`** calls `fx.close()` when `fx.session.value`, and `fx.clearMessages()`.

**`CanvasPromptHost.vue`:** pass `:note="modeNote"` to `SailorPrompt`. If the file isn't there yet (stage 3 Task 9 not landed), stop and tell the controller. Don't create it.

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command, plus the stage 3 `use-canvas-prompt` spec and `sailor-prompt` unit spec. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck the touched files.
- Commit, using the shared-file protocol for `useCanvasPrompt.ts`.
- Message: `feat(canvas): Remix… and New effect… on shader effect nodes — three effect takes above the prompt, previewed on the node, with the price on the chip`

---

### Task 9: Studios — the Shader studio's layer and Frame's background

**Files:**
- Modify: `frontend/app/lib/prompt/studioDispatch.ts` (stage 4)
- Modify: `frontend/app/composables/useStudioPrompt.ts` (stage 4)
- Modify: `frontend/app/lib/studio/studioActions.ts` (stage 4: `StudioActionRun` mode options; Frame background rows)
- Modify: `frontend/app/components/vue-canvas/StudioModalShell.vue` (props `effectTarget`, `afterTakeKeep`; `defineExpose({ prompt })`)
- Modify: `frontend/app/components/prompt/StudioPromptHost.vue` (pass `note`)
- Modify: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (shared-file protocol)
- Test: update `frontend/tests/unit/studio-dispatch.unit.spec.ts`, `frontend/tests/unit/use-studio-prompt.unit.spec.ts`, `frontend/tests/unit/studio-actions.unit.spec.ts`; add `frontend/tests/unit/studio-effect-targets.unit.spec.ts`

**Interfaces:**
- Consumes: Task 7 `useEffectTakes`, `EffectTarget`; Task 1 `shaderGenEstimateText`; Task 5 `useMyEffects`, `myEffectIdOf`.
- Produces:
  - `studioDispatch(kind, text, o: { …; hasEffectTarget?: boolean })` returns `{ worker: 'effect'; text: string }` for `new-effect` when `hasEffectTarget`. `STUDIO_MESSAGES.newEffect === DISPATCH_MESSAGES.newEffect` (the new wording).
  - `StudioPromptMode` gains `effectId?: string | null; add?: boolean`.
  - `setMode(label: string, o?: { effectId?: string | null; add?: boolean })`.
  - `useStudioPrompt` options gain:
    - `effectTarget?: (m: { effectId: string | null; add: boolean; fresh: boolean } | null) => EffectTarget | null`. `fresh` is true for "New effect"; the argument is null for a routed request with no mode.
    - `afterKeep?: (request: string) => void`, called after a worker take is kept.
  - `deps.effects?`.
  - Returns additionally `modeNote`.
  - `StudioActionRun` gains `{ mode: string; add?: boolean }`.
  - `StudioModalShell` props: `effectTarget?`, `afterTakeKeep?`; `defineExpose({ prompt })`.
  - `ShaderStudioSurface`: `shaderStudioEffectTarget(o: { add: boolean; base: EffectDef | null; fresh: boolean }): EffectTarget` (local).
  - `CompositorModal`: `frameBackgroundTarget(base: EffectDef | null): EffectTarget` (local).

- [ ] **Step 1: Write the failing tests**

In `studio-dispatch.unit.spec.ts`, replace the stage 4 "new-effect is stage 5" case with:

```ts
  it('new-effect runs the effect session where the studio has a target, and points elsewhere otherwise', () => {
    expect(studioDispatch('new-effect', 'rain', { ...studio, hasEffectTarget: true })).toEqual({ worker: 'effect', text: 'rain' })
    expect(studioDispatch('new-effect', 'rain', studio)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(studioDispatch('new-effect', 'rain', { place: 'frame', hasWorker: true, canTakes: false, hasEffectTarget: true })).toEqual({ worker: 'effect', text: 'rain' })
    expect(STUDIO_MESSAGES.newEffect).toBe(DISPATCH_MESSAGES.newEffect)
  })
```

Add to `use-studio-prompt.unit.spec.ts` (give `setup` an `effectTarget` and a fake `effects`, the same shape as Task 8's `fakeEffects`):

```ts
  it('Remix sets a chip with its price; sending runs the effect session with the studio’s target, no router', async () => {
    const effects = fakeEffects()
    const targetFn = vi.fn(() => ({ key: 'shader-studio', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() }))
    const { api, route } = setup({ effectTarget: targetFn, effects })
    api.setMode('Remix')
    expect(api.modeNote.value).toBe('~$0.24–0.42')
    await api.submit('rain on a window')
    expect(route).not.toHaveBeenCalled()
    expect(targetFn).toHaveBeenCalledWith({ effectId: null, add: false, fresh: false })
    expect(effects.start).toHaveBeenCalledWith('rain on a window', expect.objectContaining({ key: 'shader-studio' }))
    expect(api.card.value).toBe('takes')
  })
  it('New layer from a description: add, fresh', async () => {
    const effects = fakeEffects(); const targetFn = vi.fn(() => null as any)
    const { api } = setup({ effectTarget: targetFn, effects })
    api.setMode('New effect', { add: true })
    await api.submit('rain')
    expect(targetFn).toHaveBeenCalledWith({ effectId: null, add: true, fresh: true })
  })
  it('a routed new-effect (no chip) asks for the default target', async () => {
    const effects = fakeEffects(); const targetFn = vi.fn(() => ({ key: 'k', label: 'x', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() }))
    const { api } = setup({ effectTarget: targetFn, effects, route: vi.fn(async () => ({ kind: 'new-effect', followUps: [], routed: true })) })
    await api.submit('make it rain')
    expect(targetFn).toHaveBeenCalledWith(null)
    expect(effects.start).toHaveBeenCalled()
  })
  it('keeping a worker take calls afterKeep with the request', async () => {
    const afterKeep = vi.fn()
    const { api, worker } = setup({ afterKeep })
    await api.submit('warmer')
    ;(worker!.takes as any).value = [{ label: 'a' }]
    api.keepTake('take-0')
    expect(afterKeep).toHaveBeenCalledWith('warmer')
  })
  it('effect takes own the strip, Stop and the working label while they run', async () => { /* start via setMode('Remix') + submit; set effects.working true; expect api.working true, api.workingLabel contains '“rain”' and '~$0.24–0.42'; api.stop() → effects.stop called */ })
```

Write the last case out fully.

```ts
// frontend/tests/unit/studio-effect-targets.unit.spec.ts
// Source-level wiring guard: the two studio targets are wired where the studio
// owns its state. Behaviour is proven by Playwright (Task 13).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const src = (p: string) => readFileSync(fileURLToPath(new URL(`../../app/${p}`, import.meta.url)), 'utf8')

describe('studio effect targets', () => {
  it('the Shader studio passes a target and records Tune versions on My effects', () => {
    const s = src('components/vue-canvas/ShaderStudioSurface.vue')
    expect(s).toContain(':effect-target=')
    expect(s).toContain(':after-take-keep=')
    expect(s).toMatch(/addValuesVersion\(/)
  })
  it('Frame passes a background target to its own prompt', () => {
    const s = src('components/vue-canvas/CompositorModal.vue')
    expect(s).toMatch(/frameBackgroundTarget\(/)
    expect(s).toMatch(/effectTarget:\s*/)
  })
  it('the shell forwards both and exposes its prompt', () => {
    const s = src('components/vue-canvas/StudioModalShell.vue')
    expect(s).toMatch(/effectTarget/)
    expect(s).toMatch(/afterTakeKeep/)
    expect(s).toMatch(/defineExpose\(\{[^}]*prompt/)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/studio-dispatch.unit.spec.ts tests/unit/use-studio-prompt.unit.spec.ts tests/unit/studio-effect-targets.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`studioDispatch.ts`:**
- Add `| { worker: 'effect'; text: string }` to `StudioDispatch`.
- Add `hasEffectTarget?: boolean` to the options.
- The `new-effect` line becomes `if (kind === 'new-effect') return o.hasEffectTarget ? { worker: 'effect', text } : { worker: 'message', message: STUDIO_MESSAGES.newEffect }`.
- `STUDIO_MESSAGES.newEffect` stays `DISPATCH_MESSAGES.newEffect` (reworded in Task 8).

**`useStudioPrompt.ts`:**
- **Options and state:** `o` gains `effectTarget` and `afterKeep`, `deps` gains `effects`, and `const fx = deps.effects ?? useEffectTakes()`.
- **`setMode(label, m = {})`:** `const kind = kindForMode(label); mode.value = kind ? { label, kind, effectId: m.effectId ?? null, add: !!m.add } : null`.
- **`submit`:** when `m?.kind === 'new-effect'`, skip the router: `beginRun(t); lastKind = 'new-effect'; await dispatch('new-effect', t, false, m); return`.
- **`dispatch(kind, text, fromMenu, m?)`:**
  1. Resolve the target: `const target = kind === 'new-effect' ? o.effectTarget?.(m ? { effectId: m.effectId ?? null, add: !!m.add, fresh: m.label === 'New effect' } : null) ?? null : null`.
  2. Pass `hasEffectTarget: !!target` to `studioDispatch`.
  3. On `{ worker: 'effect' }`, call `worker()?.abandonTakes?.()`, then `void fx.start(d.text, target!)`, then return.
- **Cards and state:**
  - `takes` computed: `fx.session.value ?? <the worker adapter>`.
  - `card`: `if (fx.session.value) return 'takes'` first.
  - `working`: add `|| fx.working.value`.
  - `workingLabel`: when `fx.working.value`, return `` `${promptWorkingLabel({ request: fx.request.value })} · ${shaderGenEstimateText(hosted)}` ``.
  - `answerCard`: make it a computed over the existing ref. An `fx.error` becomes an `error` card and an `fx.notice` a `notice` card, both taking precedence. `dismissAnswer` also calls `fx.clearMessages()`.
- **Delegation:** `previewTake`, `chooseTake`, `keepTake`, `moreTakes` and `closeTakes` each start with `if (fx.session.value) { fx.<x>(id); return }`. `stop()` calls `fx.stop()` when `fx.working.value || fx.session.value`.
- **`keepTake` for worker takes:** after `w.keepTake?.()`, call `o.afterKeep?.(request.value)`.
- **`modeNote`:** as in the canvas.
- **Unmount:** `onBeforeUnmount` also calls `fx.close()`.

**`studioActions.ts`:**
- `StudioActionRun` becomes `{ mode: string; add?: boolean } | …`.
- `runStudioAction` calls `prompt.setMode(r.mode, { add: r.add })`.
- The Shader row `new-layer` gets `run: { mode: 'New effect', add: true }`.
- The price hint: stage 4 rows show `landsHint` only. Give AI rows whose run is a `new-effect` mode the hint `3 takes · ~$0.24–0.42` through a `priceHint` field on `StudioAction` (the same idea as `NodeAction.priceHint`), rendered after the lands hint by `StudioActionRows`.
- `REMIX_ACTION` gets that hint too.
- New Frame rows (`place: 'frame'`), in Develop:
  - `{ id: 'new-background', label: 'New background from a description…', group: 'develop', ai: true, lands: 'takes', priceHint, run: { mode: 'New effect' } }`
  - `{ id: 'remix-background', label: 'Remix background…', group: 'develop', ai: true, lands: 'takes', priceHint, run: { mode: 'Remix' } }`

  `studioActions` shows Remix background only when `o.backgroundIsShader` (a new optional option) is true.
- Update `studio-actions.unit.spec.ts`'s expected id lists to include them.

**`StudioModalShell.vue`:**
- Props `effectTarget?: (m: …) => EffectTarget | null` and `afterTakeKeep?: (request: string) => void`, passed into `useStudioPrompt({ …, effectTarget: props.effectTarget, afterKeep: props.afterTakeKeep })`.
- `defineExpose({ prompt })`, where `prompt` is the `useStudioPrompt` return. The surface needs it for the gallery's Make one and Remix, because its `CatalogModal` sits outside the shell (Task 10).

**`StudioPromptHost.vue`:** pass `:note="prompt.modeNote.value"` (or the unwrapped form the host already uses) to `SailorPrompt`.

**`ShaderStudioSurface.vue`:**

```ts
// Shader generation (stage 5 plan, Ruling 10): takes preview on the active layer,
// or on a temporary new layer at the END of the stack (so motion tracks, which
// address effects by index, never shift).
function shaderStudioEffectTarget(o: { add: boolean; base: EffectDef | null; fresh: boolean }): EffectTarget {
  const index = activeEffect.value
  const original = { ...config.value.effects[index]! }
  let tempIndex: number | null = null
  const set = (id: string, params: Record<string, any>) => {
    if (o.add) {
      if (tempIndex == null) { config.value.effects.push({ layerId: newLayerId(), id, params, enabled: true, blend: 'normal', opacity: 1 }); tempIndex = config.value.effects.length - 1 }
      else config.value.effects[tempIndex] = { ...config.value.effects[tempIndex]!, id, params }
    } else config.value.effects[index] = { ...original, id, params, customChars: '' }
    renderFrame(0)
  }
  return {
    key: 'shader-studio',
    label: o.add ? 'New layer' : (o.base?.name ?? effectDef.value?.name ?? 'Shader'),
    base: o.fresh ? null : (o.base ?? effectDef.value),
    image: () => <the source image renderFrame renders on; see below>,
    preview: (id) => {
      if (id) return set(id, {})
      if (o.add) { if (tempIndex != null) { config.value.effects.splice(tempIndex, 1); tempIndex = null } }
      else config.value.effects[index] = original
      renderFrame(0)
    },
    apply: (id, values) => { set(id, { ...values }); if (o.add) activeEffect.value = tempIndex!; tempIndex = null },
  }
}
```

- **Image:** grep `renderFrame` (~L218) for the base it passes to `shaderFx.render` (the loaded source image, or `GENERATIVE_BASE`). Return the loaded source, and null when the source is generative-only.
- **Shell props:**
  - `:effect-target="(m) => shaderStudioEffectTarget({ add: !!m?.add, fresh: !!m?.fresh, base: m?.effectId ? getEffectSync(m.effectId) : null })"`
  - `:after-take-keep="onTuneKept"`, where:

```ts
// Ruling 8: a kept Tune take on a My effect becomes a dial version.
const myEffects = useMyEffects()
function onTuneKept(request: string) {
  const id = myEffectIdOf(activeEffectCfg.value.id)
  if (!id) return
  void myEffects.addValuesVersion(id, { ...activeEffectCfg.value.params }, request).catch(() => {})
}
```

**`CompositorModal.vue`** (shared-file protocol):
- Find where Frame calls `useStudioPrompt` (stage 4 Task 9).
- Add `effectTarget: (m) => frameBackgroundTarget(m?.fresh ? null : (m?.effectId ? getEffectSync(m.effectId) : backgroundShaderDef()))`, where:

```ts
// Frame's background is the shader-generation target in Frame (stage 5, Ruling 10).
const backgroundShaderDef = () => (background.value?.type === 'shader' ? getEffectSync(background.value.shader.effectId) : null)
function frameBackgroundTarget(base: EffectDef | null): EffectTarget {
  const original = background.value
  const asShader = (effectId: string, params: Record<string, any>) => (
    original?.type === 'shader' ? { ...original, shader: { ...original.shader, effectId, params } } : shaderFill({ effectId, params }))
  return {
    key: 'frame-background', label: 'Background', base,
    image: () => <the artboard's current composited canvas, or null>,
    preview: (id) => writeBackgroundQuiet(id ? asShader(id, {}) : original),
    apply: (id, values) => { recordHistory(); setBackground(asShader(id, { ...values })) },
  }
}
```

- **`shaderFill`:** `app/lib/compositor/mosaic.ts` ~L182 builds a shader `Fill` from a `ShaderSpec` (`{ ...DEFAULT_FILL, type: 'shader', shader: spec }`). Use whatever it exports, or build `{ ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, effectId, params } }` from the same module's defaults. Read `ShaderSpec` (`lib/spacetype/fillTile.ts:59`) for the required fields (`anchor`, `speed`, `seed`, `input`).
- **`writeBackgroundQuiet`:** a background write that **does not** record history. Read `setBackground` (from `useCompositorLayers`, ~L890). If it records history, write through the underlying `editor.writeBackground` (as ~L1917 does) for previews. Keep's `apply` records one history entry, so a single undo restores the old background.
- Pass `backgroundIsShader: background.value?.type === 'shader'` to Frame's `studioActions` call.
- A routed `new-effect` in Frame (no mode) remixes the current shader background, or makes a new one when the background isn't a shader.

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command, plus `tests/unit/studio-actions.unit.spec.ts` and `tests/unit/studio-prompt-host*.unit.spec.ts`. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck all touched files.
- Commit, using the protocol for `CompositorModal.vue` and `ShaderStudioSurface.vue`.
- Message: `feat(studio): new effects in the Shader studio (the layer, or a new layer) and on Frame's background; kept Tune takes on a My effect become versions`

---

### Task 10: The effect gallery — Make one, Remix, and My effects at every picker

**Files:**
- Create: `frontend/app/components/vue-canvas/ShaderEffectGallery.vue`
- Modify: `frontend/app/components/CatalogModal.vue` (slots `#lead`, `#card-overlay`; prop `leadIn`)
- Modify: the four pickers: `ShaderStudioSurface.vue`, `widgets/ShaderFillEditor.vue`, `CompositorModal.vue` (effect stack), `ShaderEffectNode.vue`
- Test: `frontend/tests/unit/shader-effect-gallery.unit.spec.ts`, `frontend/tests/unit/catalog-modal-lead.unit.spec.ts`

**Interfaces:**
- Consumes: Task 5 `shaderGalleryItems`, `shaderGalleryFilters`, `SHADER_GALLERY_SECTIONS`, `sectionOfEffect`; `CatalogModal`; `AiMark`; `shaderGenEstimateText`.
- Produces:
  - **`CatalogModal`:**
    - `leadIn?: string`: the section id whose grid shows the `#lead` slot first. With no sections, the slot is first in the flat grid. The section is shown even when it has no items.
    - `#card-overlay="{ item }"`: rendered over each card, **outside** the card's `<button>`.
    - The empty message only shows when there are no items **and** no lead.
  - **`ShaderEffectGallery.vue`:**
    - props: `open: boolean`, `effects: EffectDef[]`, `selectedId: string | null`, `thumbs: Record<string, string>`, `include?: (d: EffectDef) => boolean`, `canMake?: boolean`, `title?: string` (default 'Shader effects'), `subtitle?: string`, `confirmLabel?: string` (default 'Use effect')
    - emits `close`, `confirm: [id: string]`, `make: []`, `remix: [def: EffectDef]`, `visible: [defs: EffectDef[]]` (so hosts render thumbs for what's shown)
    - testids `effect-gallery`, `effect-gallery-make`, `effect-gallery-remix`, `effect-gallery-card` (with `data-effect-id`)

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/catalog-modal-lead.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CatalogModal from '~/components/CatalogModal.vue'

const items = [{ id: 'a', s: 'x' }, { id: 'b', s: 'y' }]
describe('CatalogModal lead card and overlays', () => {
  it('the lead card is first in its section, and the section shows even with no items', () => {
    const w = mount(CatalogModal as any, {
      props: { open: true, title: 't', items, selectedId: null, sections: [{ id: 'mine', label: 'My effects' }, { id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], sectionOf: (i: any) => i.s, leadIn: 'mine' },
      slots: { lead: '<button data-testid="lead">Make one</button>', card: '<span>card</span>', 'card-overlay': '<button data-testid="ov">Remix</button>' },
      attachTo: document.body,
    })
    const sections = w.findAll('section')
    expect(sections[0]!.text()).toContain('My effects')
    expect(sections[0]!.find('[data-testid="lead"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="ov"]')).toHaveLength(2)
    // overlays are not nested inside the card buttons
    for (const ov of w.findAll('[data-testid="ov"]')) expect(ov.element.parentElement!.closest('button')).toBeNull()
  })
  it('no items but a lead: no empty message', () => {
    const w = mount(CatalogModal as any, { props: { open: true, title: 't', items: [], selectedId: null, leadIn: 'mine', emptyMessage: 'Nothing' }, slots: { lead: '<button data-testid="lead">Make one</button>' }, attachTo: document.body })
    expect(w.text()).not.toContain('Nothing')
    expect(w.find('[data-testid="lead"]').exists()).toBe(true)
  })
})
```

(`CatalogModal` may teleport. If it renders into `document.body`, query `document.body` rather than `w`. Check an existing CatalogModal spec (`grep -l CatalogModal tests/unit`) for how it mounts.)

```ts
// frontend/tests/unit/shader-effect-gallery.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ShaderEffectGallery from '~/components/vue-canvas/ShaderEffectGallery.vue'
import { setMyEffectRecord } from '~/lib/myEffects/library'
import type { EffectDef } from '~/lib/shaderfx/types'

const d = (id: string, category: string, over: Partial<EffectDef> = {}): EffectDef => ({ id, name: id, category, animated: false, passes: 1, centerParam: null, textures: [], params: [], source: '', ...over })
const effects = [d('water_ripple', 'distortion'), d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass' })]
setMyEffectRecord({ id: 'mine_aaaaaaaaaaaa' } as any)

describe('ShaderEffectGallery (spec §7.3)', () => {
  it('Make one ✦ first, Remix ✦ on every card, a My effects section and chip', async () => {
    const w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {}, canMake: true }, attachTo: document.body })
    const body = document.body
    const make = body.querySelector('[data-testid="effect-gallery-make"]')!
    expect(make.textContent).toContain('Make one')
    expect(make.textContent).toContain('~$0.24–0.42')
    expect(body.querySelectorAll('[data-testid="effect-gallery-remix"]')).toHaveLength(2)
    expect(body.textContent).toContain('My effects')
    ;(make as HTMLElement).click(); await w.vm.$nextTick()
    expect(w.emitted('make')).toHaveLength(1)
    ;(body.querySelector('[data-testid="effect-gallery-remix"]') as HTMLElement).click()
    expect(w.emitted('remix')![0]![0]).toMatchObject({ id: 'mine_aaaaaaaaaaaa' })
    expect(w.emitted('confirm')).toBeUndefined() // Remix doesn't pick the effect
    w.unmount()
  })
  it('without canMake: My effects are listed, but no Make one and no Remix', () => {
    const w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {} }, attachTo: document.body })
    expect(document.body.querySelector('[data-testid="effect-gallery-make"]')).toBeNull()
    expect(document.body.querySelectorAll('[data-testid="effect-gallery-remix"]')).toHaveLength(0)
    expect(document.body.querySelector('[data-effect-id="mine_aaaaaaaaaaaa"]')).not.toBeNull()
    w.unmount()
  })
  it('a My effect card says where it came from, never an id', () => {
    const w = mount(ShaderEffectGallery, { props: { open: true, effects: [d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass', from: 'Water ripple' })], selectedId: null, thumbs: {} }, attachTo: document.body })
    const card = document.body.querySelector('[data-effect-id="mine_aaaaaaaaaaaa"]')!
    expect(card.textContent).toContain('Rain on glass')
    expect(card.textContent).toContain('Mine · from Water ripple')
    expect(card.textContent).not.toMatch(/mine_/)
    w.unmount()
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/catalog-modal-lead.unit.spec.ts tests/unit/shader-effect-gallery.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`CatalogModal.vue`:**
- Add the `leadIn?: string` prop.
- `grouped` computed: when `leadIn` is set and `sections` doesn't produce a group with that id, insert `{ id: leadIn, label: <that section's label>, items: [] }` at its declared position. With no sections, the lead goes first in the flat grid.
- In the section template, render `<slot name="lead" />` as the first grid child when `g.id === leadIn`.
- Wrap each card `<button>` in `<div class="relative">` and add `<slot name="card-overlay" :item="item" />` after the button, inside the wrapper. Keep the button's classes and handlers unchanged.
- The empty-state `v-if` becomes `items.length === 0 && !$slots.lead`.
- Update the reuse list in the header comment.

**`ShaderEffectGallery.vue`:**

```vue
<script setup lang="ts">
// The effect gallery at every shader picker (AI in Sailor spec §7.3, §7.4):
// My effects first (with Make one ✦ when the host can make one), then the
// built-in shelves; Remix ✦ on every card. Lists through the one shared helper.
import { computed, ref, watch } from 'vue'
import CatalogModal from '~/components/CatalogModal.vue'
import AiMark from '~/components/prompt/AiMark.vue'
import { SHADER_GALLERY_SECTIONS, sectionOfEffect, shaderGalleryFilters, shaderGalleryItems } from '~/lib/shaderfx/gallery'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import { hostedModeEnabled } from '~/lib/hostedMode'
import type { EffectDef } from '~/lib/shaderfx/types'

const props = withDefaults(defineProps<{
  open: boolean; effects: EffectDef[]; selectedId: string | null; thumbs: Record<string, string>
  include?: (d: EffectDef) => boolean; canMake?: boolean; title?: string; subtitle?: string; confirmLabel?: string
}>(), { canMake: false, title: 'Shader effects', subtitle: 'Pick an effect to apply', confirmLabel: 'Use effect' })
const emit = defineEmits<{ close: []; confirm: [id: string]; make: []; remix: [def: EffectDef]; visible: [defs: EffectDef[]] }>()

const filter = ref('all')
const query = ref('')
watch(() => props.open, (o) => { if (o) { filter.value = 'all'; query.value = '' } })
const items = computed(() => shaderGalleryItems(props.effects, { filter: filter.value, query: query.value, include: props.include }))
const filters = computed(() => shaderGalleryFilters(props.effects, props.include))
watch(items, v => emit('visible', v), { immediate: true })
const showLead = computed(() => props.canMake && (filter.value === 'all' || filter.value === 'mine') && !query.value.trim())
let hosted = false
try { hosted = hostedModeEnabled(useRuntimeConfig().public) } catch { /* unit tests */ }
const estimate = shaderGenEstimateText(hosted)
const subtitleOf = (d: EffectDef) => (d.mine ? (d.from ? `Mine · from ${d.from}` : 'Mine') : d.category)
</script>

<template>
  <CatalogModal
    data-testid="effect-gallery" :open="open" :title="title" :subtitle="subtitle" :items="items" :selected-id="selectedId"
    :filters="filters" :active-filter-id="filter" :search-query="query" search-placeholder="Search effects…"
    :confirm-label="confirmLabel" empty-message="No effects match your search."
    :sections="SHADER_GALLERY_SECTIONS" :section-of="sectionOfEffect" :lead-in="showLead ? 'mine' : undefined"
    @close="emit('close')" @confirm="emit('confirm', ($event as EffectDef).id)"
    @update:active-filter-id="filter = $event" @update:search-query="query = $event"
  >
    <template v-if="showLead" #lead>
      <button type="button" data-testid="effect-gallery-make"
        class="flex min-h-[150px] flex-col items-start justify-end gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-3 text-left transition hover:border-white/30"
        @click="emit('make')">
        <span class="flex items-center gap-1.5 text-[13px] text-white/90">Make one <AiMark kind="star" class="size-3.5" /></span>
        <span class="text-[11px] text-white/45">Describe an effect and get three takes</span>
        <span class="text-[10px] tabular-nums text-white/35">{{ estimate }}</span>
      </button>
    </template>
    <template #card="{ item }">
      <div :data-effect-id="(item as EffectDef).id" data-testid="effect-gallery-card">
        <div class="aspect-video overflow-hidden bg-black/20">
          <img v-if="thumbs[(item as EffectDef).id]" :src="thumbs[(item as EffectDef).id]" alt="" class="h-full w-full object-cover" />
        </div>
        <div class="px-2 py-1.5">
          <div class="truncate text-[11px] text-white/85">{{ (item as EffectDef).name }}</div>
          <div class="truncate text-[10px] text-white/35" :class="{ capitalize: !(item as EffectDef).mine }">{{ subtitleOf(item as EffectDef) }}</div>
        </div>
      </div>
    </template>
    <template v-if="canMake" #card-overlay="{ item }">
      <button type="button" data-testid="effect-gallery-remix"
        class="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full border border-white/15 bg-[#1e1f23]/90 px-2 py-0.5 text-[11px] text-white/80 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-white [div:hover>&]:opacity-100"
        @click.stop="emit('remix', item as EffectDef)">
        Remix <AiMark kind="star" class="size-3" />
      </button>
    </template>
  </CatalogModal>
</template>
```

The Remix button shows on the card wrapper's hover and on keyboard focus. Keep it reachable by keyboard; it is a real button. Check how `AiMark` takes a size (prop or class) and match that.

**The four pickers.** Replace each `CatalogModal` block and its local filter/search/items state with `ShaderEffectGallery`. Keep each site's thumbnail renderer: on `@visible`, call its `ensureThumb` for each def shown (Studio and node already have `ensureThumb`; the fill editor and Frame have their own).
- **Shader studio:**
  - `:effects="catalog?.effects ?? []"`, `:can-make="true"`, `:selected-id="activeEffectCfg.id"`, `@confirm="pickEffect"`.
  - `@make`: `pickerOpen = false; shellRef.value?.prompt.setMode('New effect')`.
  - `@remix`: `(d) => { pickerOpen = false; shellRef.value?.prompt.setMode('Remix', { effectId: d.id }) }`.
  - Add `ref="shellRef"` to `StudioModalShell`.
  - Delete the moved `SHADER_SECTIONS`, `pickerFilters` and `pickerItems`. Import `SHADER_SECTIONS` from `~/lib/shaderfx/gallery` if something else in the file still needs it.
- **ShaderEffectNode:**
  - `:can-make="true"`;
  - `@make`: dispatch `sailor:promptMode` with `{ label: 'New effect', kind: 'new-effect', nodeId: props.id }` and close;
  - `@remix`: the same with `label: 'Remix'` and `effectId: d.id`.
- **ShaderFillEditor:** `:can-make="false"` (Ruling 10). Everything else is as before.
- **Frame effect stack:** `:include="(e) => effectReadsInput(e.id)"` and `:can-make="false"`. The old `shaderFxAllItems` filter moves into `include`.

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command, plus any existing picker specs (`grep -l "CatalogModal\|pickerItems" tests/unit`). Expected: PASS. Update specs that asserted the old local `pickerItems` to use the helper's order.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck all touched files.
- Commit, using the protocol for the shared files.
- Message: `feat(gallery): one effect gallery at every shader picker — My effects first, Make one ✦ and Remix ✦ where a new effect can land`

---

### Task 11: The Recipe — name, origin, versions and remove

**Files:**
- Create: `frontend/app/components/vue-canvas/MyEffectRecipe.vue`
- Modify: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue` (inside the stage 4 `StudioInspectorHead` slot)
- Modify: `frontend/app/components/vue-canvas/widgets/ShaderFillEditor.vue` (under its effect button)
- Test: `frontend/tests/unit/my-effect-recipe.unit.spec.ts`

**Interfaces:**
- Consumes: Task 3 `activeVersionIndex`, `myEffectIdOf`; Task 5 `useMyEffects`, `myEffectRecordById`.
- Produces: `MyEffectRecipe.vue`:
  - props `effectId: string`, `values: Record<string, ParamValue>`;
  - emits `pick-version: [{ effectId: string; values: Record<string, ParamValue> }]`;
  - renders nothing unless `myEffectIdOf(effectId)` is in the library;
  - testids `my-effect-recipe`, `my-effect-name` (an input, aria-label "Effect name"), `my-effect-from`, `my-effect-note`, `my-effect-version` (with `data-version`, `aria-pressed`), `my-effect-remove`, `my-effect-remove-confirm`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/my-effect-recipe.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { recordFromTake, withValuesVersion, valuesForVersion } from '~/lib/myEffects/defs'
import { myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rename = vi.fn(async () => ({})), remove = vi.fn(async () => {})
vi.mock('~/composables/useMyEffects', () => ({ useMyEffects: () => ({ rename, remove }) }))
import MyEffectRecipe from '~/components/vue-canvas/MyEffectRecipe.vue'

const t = SPIKE_TAKES.rain![2]!
const u = t.params[0]!.uniform
const rec = withValuesVersion(recordFromTake(t, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: 'Water ripple', now: 'x' }), { [u]: 0.123 }, { request: 'softer', now: 'x' })!

describe('MyEffectRecipe (spec §7.4)', () => {
  beforeEach(() => { myEffectRecords.value = []; setMyEffectRecord(rec); rename.mockClear(); remove.mockClear() })

  it('shows the name, where it came from, the first request and one chip per version', () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 1) } })
    expect((w.get('[data-testid="my-effect-name"]').element as HTMLInputElement).value).toBe(t.name)
    expect(w.get('[data-testid="my-effect-from"]').text()).toBe('My effect · from Water ripple')
    expect(w.get('[data-testid="my-effect-note"]').text()).toBe('“rain on a window”')
    const chips = w.findAll('[data-testid="my-effect-version"]')
    expect(chips.map(c => c.text())).toEqual(['v1', 'v2'])
    expect(chips.map(c => c.attributes('aria-pressed'))).toEqual(['false', 'true'])
  })
  it('a chip switches the target to that version', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 1) } })
    await w.findAll('[data-testid="my-effect-version"]')[0]!.trigger('click')
    expect(w.emitted('pick-version')![0]![0]).toEqual({ effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 0) })
  })
  it('renames on change (trimmed), never to empty', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    const input = w.get('[data-testid="my-effect-name"]')
    await input.setValue('  Wet glass '); await input.trigger('change')
    expect(rename).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', 'Wet glass')
    await input.setValue('   '); await input.trigger('change')
    expect(rename).toHaveBeenCalledTimes(1)
  })
  it('remove asks first', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    await w.get('[data-testid="my-effect-remove"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(w.get('[data-testid="my-effect-remove-confirm"]').text()).toContain(`Remove “${t.name}” from My effects?`)
    await w.get('[data-testid="my-effect-remove-confirm"] button').trigger('click')
    expect(remove).toHaveBeenCalledWith('mine_aaaaaaaaaaaa')
  })
  it('a built-in effect has no recipe', () => {
    expect(mount(MyEffectRecipe, { props: { effectId: 'water_ripple', values: {} } }).html()).toBe('<!--v-if-->')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/my-effect-recipe.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`MyEffectRecipe.vue`:
- **Root:** `<div v-if="rec" data-testid="my-effect-recipe" class="flex flex-col gap-2">`, where `rec = computed(() => { const id = myEffectIdOf(props.effectId); return id ? myEffectRecordById(id) : null })`.
- **Name:** `<input data-testid="my-effect-name" aria-label="Effect name" :value="rec.name" @change="onRename" class="…">`. `onRename` trims and collapses the value. If it's empty it resets the input to `rec.name`; otherwise it calls `rename`.
- **Origin:** `<p data-testid="my-effect-from" class="text-[11px] text-white/45">{{ rec.from ? `My effect · from ${rec.from}` : 'My effect' }}</p>`.
- **Note:** `<p data-testid="my-effect-note" class="text-[12px] text-white/70">“{{ rec.versions[0].note }}”</p>`, shown only when the note is non-empty.
- **Versions:** a row labelled "Versions", then chips: `<button v-for="(v, i) in rec.versions" data-testid="my-effect-version" :data-version="v.label" :aria-pressed="String(i === active)" :title="v.note" @click="emit('pick-version', { effectId: effectIdForVersion(rec, i), values: valuesForVersion(rec, i) })">{{ v.label }}</button>`.
  - `active = computed(() => activeVersionIndex(rec.value, props.effectId, props.values))`.
  - A pressed chip gets a white border, which is neutral; no pastel.
- **Remove:** a quiet text button, "Remove from My effects…". It toggles an inline confirm `<div data-testid="my-effect-remove-confirm">Remove “{{ rec.name }}” from My effects? <button>Remove</button> <button>Keep it</button></div>`. After removal, show nothing: the record is gone.
- **Styling:** neutral, the same as `StudioInspectorHead`'s body text. Sentence case.

**Mount it:**
- **Shader studio:** inside Shader's `StudioInspectorHead` slot, under Change effect and Remix: `<MyEffectRecipe :effect-id="activeEffectCfg.id" :values="activeEffectCfg.params" @pick-version="(v) => { config.effects[activeEffect] = { ...activeEffectCfg, id: v.effectId, params: { ...v.values }, customChars: '' }; renderFrame(0) }" />`.
- **Head title:** for a My effect, the stage 4 head's title is its name. The recipe's input edits it, so the head's static title and the input show the same name. That's acceptable; the input is the editable form.
- **ShaderFillEditor:** under the effect picker button: `<MyEffectRecipe :effect-id="modelValue.effectId" :values="modelValue.params" @pick-version="(v) => patch({ effectId: v.effectId, params: { ...v.values } })" />`.

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck.
- Commit.
- Message: `feat(my-effects): the Recipe — rename, where it came from, version chips that switch the effect, and remove with a confirm`

---

### Task 12: Projects keep a copy, and exports inline My effects

**Files:**
- Create: `frontend/app/lib/myEffects/projectCopy.ts`
- Modify: `frontend/app/lib/projectDoc.ts` (`ProjectDoc.myEffects?`)
- Modify: `frontend/app/layouts/default.vue` (shared-file protocol: the snapshot and the load paths)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (Frame web export reads the live catalog)
- Test: `frontend/tests/unit/my-effects-project-copy.unit.spec.ts`, `frontend/tests/unit/my-effects-export.unit.spec.ts`

**Interfaces:**
- Consumes: Task 3 `myEffectIdOf`, `expandMyEffect`; Task 5 `myEffectRecordById`, `myEffectRecords`, `useMyEffects().adopt`, `currentShaderEffects`, `registerEffects`; `planFrameExport`, `createAppFrameExportIO`.
- Produces:
  - `MY_EFFECT_REF_RE: RegExp`
  - `myEffectIdsIn(x: unknown): string[]`, unique and sorted
  - `attachMyEffects(doc: ProjectDoc, lookup: (id: string) => MyEffectRecord | null, o?: { libraryEmpty?: boolean }): void`, which mutates `doc.myEffects`
  - `adoptMyEffects(doc: ProjectDoc | null | undefined, adopt: (recs: MyEffectRecord[]) => void): void`
  - `ProjectDoc.myEffects?: MyEffectRecord[]`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/my-effects-project-copy.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { adoptMyEffects, attachMyEffects, myEffectIdsIn } from '~/lib/myEffects/projectCopy'
import { recordFromTake } from '~/lib/myEffects/defs'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rec = (id: string) => recordFromTake(SPIKE_TAKES.rain![2]!, { id, request: 'rain', from: null, now: 'x' })
const A = 'mine_aaaaaaaaaaaa', B = 'mine_bbbbbbbbbbbb'
const doc = (widgets: unknown[]) => ({ canvases: [{ id: 'c', name: 'Canvas 1', workflow: { nodes: [{ type: 'shader-effect', widgets_values: widgets }] } }], activeCanvasId: 'c' }) as any

describe('projects keep a copy of the My effects they use (spec §7.4)', () => {
  it('finds My effect ids anywhere in the doc, version ids included', () => {
    expect(myEffectIdsIn(doc([A, { fill: { shader: { effectId: `${B}~v2` } } }, 'water_ripple']))).toEqual([A, B])
  })
  it('attach writes the used records, and removes the field when none are used', () => {
    const d = doc([A])
    attachMyEffects(d, id => (id === A ? rec(A) : null))
    expect(d.myEffects.map((r: any) => r.id)).toEqual([A])
    const plain = doc(['water_ripple']); plain.myEffects = [rec(A)]
    attachMyEffects(plain, () => null)
    expect(plain.myEffects).toBeUndefined()
  })
  it('an effect removed from the library keeps its existing project copy', () => {
    const d = doc([A]); d.myEffects = [rec(A)]
    attachMyEffects(d, () => null)
    expect(d.myEffects.map((r: any) => r.id)).toEqual([A])
  })
  it('skips the scan entirely when the library is empty and the doc has no copies', () => {
    const d = doc([A]); const lookup = vi.fn(() => null)
    attachMyEffects(d, lookup, { libraryEmpty: true })
    expect(lookup).not.toHaveBeenCalled()
    expect(d.myEffects).toBeUndefined()
  })
  it('adopt hands the copies over (and ignores a doc without any)', () => {
    const adopt = vi.fn()
    adoptMyEffects({ ...doc([A]), myEffects: [rec(A)] }, adopt)
    expect(adopt).toHaveBeenCalledWith([expect.objectContaining({ id: A })])
    adoptMyEffects(doc([]), adopt); adoptMyEffects(null, adopt)
    expect(adopt).toHaveBeenCalledTimes(1)
  })
})
```

```ts
// frontend/tests/unit/my-effects-export.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { currentShaderEffects, putShaderFxEffects, setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { expandMyEffect, recordFromTake } from '~/lib/myEffects/defs'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

describe('exports inline My effects like built-ins (spec §7.4)', () => {
  it('the live effect list carries a registered My effect with its full source', () => {
    setShaderFxCatalog({ version: 1, effects: [] })
    putShaderFxEffects(expandMyEffect(recordFromTake(SPIKE_TAKES.rain![2]!, { id: 'mine_aaaaaaaaaaaa', request: 'r', from: null, now: 'x' })))
    const d = currentShaderEffects().find(e => e.id === 'mine_aaaaaaaaaaaa')!
    expect(d.source).toContain('void main')
  })
  it('Frame’s web export reads the live list, not a stale fetch', () => {
    const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')
    const block = s.slice(s.indexOf('catalogIds:') - 400, s.indexOf('createAppFrameExportIO({') + 400)
    expect(block).toMatch(/currentShaderEffects\(\)/)
  })
})
```

If `planFrameExport` is easy to call with a minimal doc (read `lib/embed/frame/plan.ts`'s input type), add a third case: a doc whose background fill uses `mine_aaaaaaaaaaaa` gives `shaderIds` containing it when `catalogIds` comes from `currentShaderEffects()`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/my-effects-project-copy.unit.spec.ts tests/unit/my-effects-export.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/myEffects/projectCopy.ts
/** Projects keep a copy of every My effect they use, so a shared project renders
 *  without the owner's library (spec §7.4; plan ruling 17). */
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import type { ProjectDoc } from '~/lib/projectDoc'

export const MY_EFFECT_REF_RE = /mine_[a-z0-9]{12}(?:~v\d+)?/g

export function myEffectIdsIn(x: unknown): string[] {
  const ids = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') { for (const m of v.matchAll(MY_EFFECT_REF_RE)) ids.add(m[0].replace(/~v\d+$/, '')); return }
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    if (v && typeof v === 'object') for (const [k, e] of Object.entries(v)) { if (k !== 'myEffects') walk(e) }
  }
  walk(x)
  return [...ids].sort()
}

export function attachMyEffects(doc: ProjectDoc, lookup: (id: string) => MyEffectRecord | null, o: { libraryEmpty?: boolean } = {}): void {
  if (o.libraryEmpty && !doc.myEffects?.length) return
  const prior = new Map((doc.myEffects ?? []).map(r => [r.id, r]))
  const used = myEffectIdsIn(doc.canvases).map(id => lookup(id) ?? prior.get(id) ?? null).filter((r): r is MyEffectRecord => !!r)
  if (used.length) doc.myEffects = used
  else delete doc.myEffects
}

export function adoptMyEffects(doc: ProjectDoc | null | undefined, adopt: (recs: MyEffectRecord[]) => void): void {
  if (doc?.myEffects?.length) adopt(doc.myEffects)
}
```

`walk` goes through object values. Data URLs are long strings, but the regex scan is linear. The `libraryEmpty` skip covers the common case of no My effects at all.

**`projectDoc.ts`:** add `/** Copies of the My effects this project uses (stage 5). Absent ⇒ none. */ myEffects?: import('~~/shared/myEffects/record').MyEffectRecord[]`.

**`layouts/default.vue`** (shared-file protocol; save the before-patch first):
- In `snapshotActiveCanvasIntoDoc`, just before `stampDocForSave(...)`: `attachMyEffects(toRaw(doc), myEffectRecordById, { libraryEmpty: myEffectRecords.value.length === 0 })`.
- **On load**, wherever a doc from storage enters `savedWorkflows`, call `adoptMyEffects(<that doc>, myEffectsApi.adopt)` right after the assignment, where `const myEffectsApi = useMyEffects()` is created once in setup. The places are:
  - the session restore (~L1465, per key);
  - `savedWorkflows[tab.id] = toProjectDoc(body)` (~L2328);
  - the durable swap (~L2350).
- Import `attachMyEffects`, `adoptMyEffects`, `myEffectRecordById`, `myEffectRecords` and `useMyEffects`.

**`CompositorModal.vue`** `buildWebExport` (~L5231): replace `new Set(cat.effects.map(e => e.id))` with `new Set(currentShaderEffects().map(e => e.id))`, and pass `catalog: currentShaderEffects()` to `createAppFrameExportIO`. Keep the `await fetchShaderFxCatalog()` before it, so the built-ins are loaded. Import `currentShaderEffects` from `~/lib/shaderfx/catalogStore`.

**Shader studio export:** after Task 5 it already reads the live `catalog.value.effects`. Add nothing, but check that it now includes My effects. The unit test above covers the store.

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command, plus `npx vitest run tests/unit/project-doc*.unit.spec.ts tests/unit/frame-export*.unit.spec.ts`. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**
- Run `cd frontend && npx vitest run`.
- Typecheck.
- Commit, using the protocol for `default.vue` and `CompositorModal.vue`.
- Message: `feat(my-effects): projects keep a copy of the My effects they use; Frame and Shader studio exports inline them`

---

### Task 13: Playwright — shader generation end to end, with every route mocked

**Files:**
- Create: `frontend/tests/shader-gen.spec.ts`. The implementer writes it; the controller runs it.

**Interfaces:**
- Uses:
  - `dropNode`, `openBlankWorkflow`, `waitForBackend` from `./_helpers`;
  - `sailor:openShaderStudio` with `{ nodeId }` (check the handler's detail shape in `VueNodeCanvas.vue`);
  - `SPIKE_TAKES` (type-only imports inside it are erased, so the Node runner can load it).
- Test ids:
  - `prompt-takes`, `prompt-take-tile`, `prompt-mode-chip`, `prompt-note`, `prompt-stop`, `prompt-answer`, `studio-prompt`, `studio-action-row`;
  - `effect-gallery`, `effect-gallery-make`, `effect-gallery-remix`, `effect-gallery-card`;
  - `my-effect-recipe`, `my-effect-version`, `my-effect-name`.

- [ ] **Step 1: Write the spec**

```ts
// frontend/tests/shader-gen.spec.ts
import { expect, test, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, waitForBackend } from './_helpers'
import { SPIKE_TAKES } from '../app/lib/shadergen/__eval__/spikeTakes'

/**
 * AI in Sailor stage 5: shader generation and My effects, end to end, spending
 * nothing. /api/shader-gen answers with the spike's hand-written takes (the
 * same ones the real renderer compiled 24/24), /api/my-effects is an in-memory
 * store, and /api/prompt-route is mocked. The takes still go through the REAL
 * engine checks and the REAL renderer in the browser. Hover preview by a real
 * mouse is owed separately (plan Task 14).
 */

const ANGLE = /Take (\d):/
async function mockShaderGen(page: Page, delays = [300, 900, 1500]) {
  const calls: any[] = []
  await page.route('**/api/shader-gen', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const slot = Number(ANGLE.exec(body.prompt)?.[1] ?? 1) - 1
    await new Promise(res => setTimeout(res, delays[slot] ?? 0))
    await r.fulfill({ json: { text: JSON.stringify(SPIKE_TAKES.rain![slot]), usage: { input_tokens: 5000, output_tokens: 3000 }, stop_reason: 'end_turn', credits: null } })
  })
  return calls
}
async function mockMyEffects(page: Page) {
  const store = new Map<string, any>()
  await page.route('**/api/my-effects**', async (r) => {
    const url = new URL(r.request().url()); const id = url.pathname.split('/').pop()!
    const m = r.request().method()
    if (m === 'GET' && url.pathname.endsWith('/my-effects')) return r.fulfill({ json: { effects: [...store.values()] } })
    if (m === 'PUT') { const rec = { ...r.request().postDataJSON(), updatedAt: new Date().toISOString() }; store.set(id, rec); return r.fulfill({ json: rec }) }
    if (m === 'PATCH') { const rec = { ...store.get(id), name: r.request().postDataJSON().name }; store.set(id, rec); return r.fulfill({ json: rec }) }
    if (m === 'DELETE') { store.delete(id); return r.fulfill({ json: { ok: true, id } }) }
    return r.fulfill({ json: store.get(id) ?? {}, status: store.has(id) ? 200 : 404 })
  })
  return store
}
async function mockRouter(page: Page, kind = 'new-effect') {
  const calls: any[] = []
  await page.route('**/api/prompt-route', async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ json: { kind, followUps: [], credits: null } }) })
  return calls
}
async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-shadergen') } catch {} })
}
async function openShaderStudio(page: Page) {
  await openBlankWorkflow(page); await waitForBackend(page)
  await dropNode(page, 'ShaderEffectNode') // check _helpers for the right node type name for a shader effect node
  const id = await page.locator('.vue-flow__node').last().getAttribute('data-id')
  await page.evaluate((nodeId) => window.dispatchEvent(new CustomEvent('sailor:openShaderStudio', { detail: { nodeId } })), id)
  await expect(page.getByTestId('studio-prompt')).toBeVisible({ timeout: 15_000 })
}
const prompt = (page: Page) => page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })

test.describe('shader generation (stage 5)', () => {
  test.beforeEach(async ({ page }) => { await seedKey(page) })

  test('Shader studio: Remix shows its price, three effects land one by one, hover previews, Keep saves to My effects', async ({ page }) => {
    const gen = await mockShaderGen(page); const store = await mockMyEffects(page); const routed = await mockRouter(page)
    await openShaderStudio(page)
    await page.getByTestId('studio-inspector-head').getByTestId('studio-action-row').filter({ hasText: 'Remix' }).click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
    await expect(page.getByTestId('prompt-note')).toHaveText(/^~\$0\.24–0\.42$/)
    await prompt(page).fill('rain on a window'); await prompt(page).press('Enter')
    expect(routed).toHaveLength(0) // the chip decided the kind
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible()
    const ready = strip.getByTestId('prompt-take-tile').locator('img')
    await expect(ready).toHaveCount(1, { timeout: 10_000 })   // the 300 ms take first…
    await expect(ready).toHaveCount(3, { timeout: 15_000 })   // …then the rest
    expect(gen.every(b => !('tier' in b) && !('model' in b))).toBe(true) // the shader-generation setting
    expect(gen[0].images?.length ?? 0).toBeLessThanOrEqual(1)
    await strip.getByTestId('prompt-take-tile').nth(1).hover()
    await page.getByTestId('prompt-take-tile').nth(1).getByRole('button', { name: 'Keep' }).click() // check PromptTakes for how Keep is exposed per tile
    await expect(page.getByTestId('prompt-answer')).toContainText('Saved to My effects as')
    expect(store.size).toBe(1)
    await expect(page.getByTestId('my-effect-recipe')).toBeVisible()
    await expect(page.getByTestId('my-effect-version')).toHaveText(['v1'])
  })

  test('Stop mid-run clears partial takes and restores', async ({ page }) => {
    await mockShaderGen(page, [200, 20_000, 20_000]); await mockMyEffects(page); await mockRouter(page)
    await openShaderStudio(page)
    await page.getByTestId('studio-actions').getByTestId('studio-action-row').filter({ hasText: 'New layer from a description' }).click()
    await prompt(page).fill('ink on paper'); await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-take-tile').locator('img')).toHaveCount(1, { timeout: 10_000 })
    await page.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
  })

  test('the gallery: My effects section and chip, Make one sets the chip, Remix on a card', async ({ page }) => {
    await mockShaderGen(page); const store = await mockMyEffects(page); await mockRouter(page)
    // seed one My effect before the page loads
    store.set('mine_aaaaaaaaaaaa', { id: 'mine_aaaaaaaaaaaa', name: 'Rain on glass', from: 'Water ripple', animated: true, generative: false, createdAt: 'x', updatedAt: 'x',
      versions: [{ label: 'v1', body: SPIKE_TAKES.rain![2]!.body, params: SPIKE_TAKES.rain![2]!.params, values: {}, note: 'rain on a window', createdAt: 'x' }] })
    await openShaderStudio(page)
    await page.getByRole('button', { name: 'Change effect' }).click()
    const gallery = page.getByTestId('effect-gallery')
    await expect(gallery.getByText('My effects').first()).toBeVisible()
    await expect(gallery.locator('[data-effect-id="mine_aaaaaaaaaaaa"]')).toContainText('Mine · from Water ripple')
    await gallery.getByTestId('effect-gallery-make').click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await page.getByRole('button', { name: 'Change effect' }).click()
    await page.locator('[data-effect-id="water_ripple"]').hover()
    await page.locator('[data-effect-id="water_ripple"]').locator('..').locator('..').getByTestId('effect-gallery-remix').click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
  })

  test('canvas: a shader node offers Remix… and New effect… with the price, and takes preview on the node', async ({ page }) => {
    await mockShaderGen(page, [100, 200, 300]); await mockMyEffects(page); await mockRouter(page)
    await openBlankWorkflow(page); await waitForBackend(page)
    await dropNode(page, 'ShaderEffectNode')
    await page.locator('.vue-flow__node').last().click()
    await page.getByRole('button', { name: /Develop/ }).click()
    await expect(page.getByText('3 takes · ~$0.24–0.42').first()).toBeVisible()
    await page.getByRole('menuitem', { name: /Remix…/ }).click()
    await page.getByRole('textbox', { name: 'Ask Sailor' }).fill('rain on a window')
    await page.getByRole('textbox', { name: 'Ask Sailor' }).press('Enter')
    await expect(page.getByTestId('prompt-take-tile').locator('img')).toHaveCount(3, { timeout: 15_000 })
    await expect(page.getByTestId('prompt-takes')).toContainText('Water ripple') // the target is named
  })

  test('a routed new-effect with no chip shows the price in the working label', async ({ page }) => {
    await mockShaderGen(page, [3000, 3000, 3000]); await mockMyEffects(page); await mockRouter(page, 'new-effect')
    await openShaderStudio(page)
    await prompt(page).fill('make it rain'); await prompt(page).press('Enter')
    await expect(page.getByTestId('studio-prompt')).toContainText('Working on “make it rain” · ~$0.24–0.42')
  })
})
```

Before finalising, read these and adjust the selectors (keep the assertions):
- `_helpers.ts`: the node-type string `dropNode` takes for a shader effect node;
- stage 3's `PromptTakes.vue`: how a tile exposes Keep (a per-tile button, or a strip-level Keep after choosing);
- stage 2's node toolbar: the Develop menu's role and names.

- [ ] **Step 2: Hand it to the controller**

Implementers never run Playwright against `:3002`. Report the file path; the controller runs it in Task 14.

- [ ] **Step 3: Commit**
- Commit the spec file.
- Message: `test(e2e): shader generation end to end — spike takes as canned replies, My effects in memory, every route mocked`

---

### Task 14: Verification (controller-run, not a subagent)

- [ ] **Step 1: Health first.**
  - Run `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then `lsof -a -p <pid> -d cwd`, to find the main checkout's server on `:3002`.
  - **Don't restart it** (this stage's rule).
  - If it's broken (a Nuxt 500, or esbuild's "The service is no longer running"), say so, and offer Julien a restart **on :3002** only. Then check `curl -s http://127.0.0.1:8188/system_stats`.
- [ ] **Step 2: Unit suite and typecheck.**
  - Run `cd frontend && npx vitest run`. It should be green, with counts compared to BASE (memory: vitest counts lie under load, so rerun a timed-out file alone).
  - Confirm that `api-route-reachability`, `anthropic-meter`, `anthropic-prices` and `price-graph` all ran and passed.
  - Run `npx vue-tsc --noEmit` and filter to this stage's files.
- [ ] **Step 3: Playwright, one spec at a time** (every route mocked, so no restart is needed):

  ```bash
  cd frontend && npx playwright test tests/shader-gen.spec.ts
  cd frontend && npx playwright test tests/studio-prompt.spec.ts tests/prompt-results.spec.ts tests/shader-gen-eval.spec.ts
  ```

  Rerun a spec that times out on its own before calling it broken.
- [ ] **Step 4: A real-mouse pass in the browser pane** (synthetic events prove nothing).
  - Click by ref, screenshot each check, and mock `/api/shader-gen` and `/api/my-effects` through the pane's network tools.
  - **Hover and focus:** hovering each tile previews the take:
    - in the Shader studio: on the preview;
    - on the canvas: on the node's own picture;
    - in Frame: on the artboard's background.

    Leaving the strip goes back; clicking a tile keeps it showing; Keep applies it and the Recipe shows v1.
  - **The gallery:** Make one is first; Remix shows on card hover and on keyboard focus; the My effects chip filters.
  - **Versions:** Tune a My effect in the Shader studio and Keep: a v2 chip appears. Click v1: the dials and the effect go back.
  - **Undo in Frame:** after Keep on the background, one undo restores the old background. The hovered takes never enter history.
  - **Context loss:** in devtools, run `shaderFx`'s canvas `getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()` while a take is previewed. The tile turns failed, the message shows, and after `restoreContext()` the preview renders again.
  - **Owed until then:** if the pane is hidden (a hidden pane pauses rAF), record the real-mouse pass as **owed**.
- [ ] **Step 5: Owed, and not run without Julien's OK.** Write these into STATE.md:
  - **The paid measurement** (spec §7.2: "Measure the real figure at the start of stage 5 by running one request"):
    - What: one real Remix of a studio photo in the Shader studio. The request is three Opus 5.5 takes with the picture and two examples, **about 25–40¢**.
    - Record: input, output and cache tokens per call; calls per take; wall time to the first tile and to the third; credits settled (hosted) or the cost (local).
    - Then replace `SHADER_GEN_ENVELOPE`'s four numbers with the measured figures, and correct §7.2's estimate and latency lines.
  - **A restart of `:3002`**, so Nitro registers `/api/my-effects`. Until then the proxy answers **405**, and saving a take fails with "Couldn’t save to My effects".
    - After it: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/my-effects` should give **200**.
    - The same restart makes the running server pick up `/api/shader-gen`'s new default model (Opus 5.5). Before it, a request without a tier may still reach the old code, which defaults to Sonnet.
  - **One live end-to-end check after the restart:** a real Keep writes `.data/my-effects/<id>.json`, and a reload shows the effect under My effects in all four pickers.
- [ ] **Step 6: Record it.**
  - Mark the spec's §9 stage 5 as built, with the commit range and the owed items.
  - Note in §7.2 that the setting lives in `shared/shadergen/model.ts`, and that the estimate is a formula until measured.
  - Update `docs/STATE.md`.
  - Update the memory file `ai-surface-rethink-and-shader-gen.md`: stage 5 built; the rulings Julien should confirm (especially 3, 6, 8, 10, 13 and 17); the owed measurement and restart.
  - Update the build dashboard (standing rule: update it on every commit).
