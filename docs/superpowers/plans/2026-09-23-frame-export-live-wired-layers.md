# Frame exports: wired Space Type and Gradient play live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Frame web export, an animated wired Space Type or Gradient layer plays as code — that studio's own embed player, nested inside the Frame player — instead of as pre-rendered frames. It stays sharp at any size and costs about one player bundle (≈1 MB for the heaviest Space Type effect) instead of 20–28 MB of frames.

**Architecture:** The export HTML carries every player it needs: each nested studio's bundle, then the Frame bundle, concatenated into the one inline script. A new `live` kind of wired entry holds a studio's embed config. The Frame surface mounts each live entry's player in a detached container at mount, and on each paint sets its time and hands its canvas to the painter as the slot's picture — the same `withWiredContent` provider stills and clips already use. A studio says it can play live through a new optional `embed()` on its `StudioFrameSource`; anything it cannot reproduce faithfully returns `null` and keeps today's pre-rendered route.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, three.js (Space Type), WebGL2 (Gradient), Vite IIFE embed bundles (`scripts/build-embed.mjs` + `vite.embed.config.ts`), Vitest, Playwright.

**Spec:** this plan carries its own design (below) — agreed with Julien in chat on 2026-09-23 ("yes" to: wired Space Type/Shader/Gradient layers carry their studio's live player inside the Frame export; 3D stays pre-rendered until the 3D Phase 2 live route). Background: `docs/superpowers/specs/2026-09-23-scene3d-web-embed-design.md` ("Phase 1 as built") and the Frame web export spec it references.

## Design

**Why.** Phase 1 of the 3D web export made every animated wired layer in a Frame export pre-render into WebP frames at 2× drawn size. That is right for 3D (its engine is too heavy to ship). For Space Type it produced a 28.5 MB file for a 6 s loop, although Space Type, Gradient and Shader already have live embed players. Shader Studio is not a `StudioFrameSource` (it consumes wired inputs, it is never wired INTO a Frame), so the live route covers **Space Type and Gradient**. 3D, Vector Type and Shape Studio keep the pre-rendered route.

**Never a wrong picture.** The live route is only taken when the studio's embed player is proven to draw what the editor draws. Anything uncertain — an effect not on the verified list, an image card, a font that cannot be inlined, a failed font fetch — falls back to the pre-rendered route, which is today's behaviour and already correct. A fallback is not an error and blocks nothing.

**Timing.** A live slot loops on its own duration inside the Frame's loop, exactly as clips do today: `slotPhase01(frameSec, entry.duration)` (`lib/compositor/masterClock.ts`) is the t01 handed to the nested `setTime`.

**Size and sharpness.** A nested player renders at the slot's drawn size in device pixels — the largest box any wired layer on that slot is drawn at, times the Frame's current scale — keeping the source's aspect, long side clamped to [64, 4096]. It is resized in the Frame handle's `setSize` path, never per frame. Space Type's engine takes a same-aspect scale change without a rebuild (`SpaceTypeNode.vue` already relies on this in its frame source).

**The sheet line.** One per live slot: `{label} · plays live · adds {size}`, where size counts the player bundle the first time a bundle appears and the config (font included) every time. A second slot on the same bundle says `{label} · plays live · adds {config size}`.

**Seamless Space Type loops.** The standalone Space Type embed today plays one base loop (`renderFrameAt(t01)`), while the studio's seamless option spans `k` base loops (`loopMultiplier`, `effectiveLoopSeconds`). Both the standalone export and the nested player gain a `loops` field so `setTime(t01)` draws `renderFrameAt(t01 * loops)` over `effectiveLoopSeconds(loopDuration, loops)` seconds. Standalone exports of non-seamless pieces are unchanged (`loops` absent = 1).

## Global Constraints

- Self-contained: the exported HTML makes **zero network requests**. `externalRefs` runs on the whole concatenated HTML; the Playwright network recorders (`tests/frame-embed-network.spec.ts`, `tests/embed-network.spec.ts`) keep their negative controls.
- Failure policy: live route only when faithful; otherwise the pre-rendered route (today's code path, unchanged). A nested player whose mount rejects inside the exported file rejects the Frame's mount — the runtime keeps the poster (a correct still), never a half-drawn Frame.
- The embed contract (`lib/embed/contract.ts`) is unchanged: `mount(container, config)`, sync `setTime(t01)`, `setSize(w, h)` device px, `destroy()`.
- A Frame bundle must never import the app registry (`lib/embed/surfaces.ts` statically imports all 25 Space Type effects). Nested players are resolved by name at runtime.
- Bundle ceilings live in `tests/unit/embed-build-output.unit.spec.ts`; `ceilingFor` throws on unknown names. Rebuild bundles with `npm run build:embed` (from `frontend/`) after changing anything under `lib/embed/`.
- UI copy: sentence case; no internal identifiers in anything a person reads (`plays live`, not `live`/`spacetype-boost`).
- **Never run `npm run dev`** or start/stop any server. Playwright runs against the existing dev server at `http://127.0.0.1:3002`. If it is down, report BLOCKED.
- Commits: work in the main checkout; stage only your own paths using a private index (`GIT_INDEX_FILE` seeded from HEAD with `git read-tree HEAD`, `git add` your exact paths, `git commit`, then `git reset -q -- <same paths>` on the shared index). Never `git stash`. Prove a commit by HEAD moving. Leave files you did not write alone (`VueNodeCanvas.vue`, `layouts/default.vue`, `lib/vectortype/medial.ts`, `pages/dev/morph-lab.vue` are other sessions' work).

---

### Task 1: Nested players in the Frame export

**Files:**
- Create: `frontend/app/lib/embed/nested.ts`
- Modify: `frontend/app/lib/embed/frame/types.ts` (new `WiredEntry` variant)
- Modify: `frontend/app/lib/embed/surfaces/frame.ts` (mount/paint/size/destroy live entries)
- Modify: `frontend/app/lib/embed/surfaces.ts` (`bundleNamesFor`)
- Modify: `frontend/app/lib/embed/export.ts` (fetch and concatenate several bundles)
- Test: `frontend/tests/unit/embed-nested.unit.spec.ts` (new), extend `frontend/tests/unit/embed-frame-surface*.unit.spec.ts` or the nearest existing frame-surface unit spec (find it with `ls tests/unit | grep -i frame`)

**Interfaces:**
- Produces:
  ```ts
  // frame/types.ts
  export type WiredEntry =
    | { kind: 'still'; dataUrl: string }
    | { kind: 'clip'; frames: string[]; fps: number; duration: number }
    | { kind: 'live'; surface: string; bundle: string; config: unknown; width: number; height: number; duration: number }

  // nested.ts — bundle-safe (no app imports)
  export type NestedSurfaceLoader = (bundle: string) => Promise<EmbedSurface | null>
  export function setNestedSurfaceLoader(loader: NestedSurfaceLoader | null): void
  /** globalThis.__SAILOR_NESTED__[bundle] (set by the exported file) first, then the app loader. */
  export async function resolveNestedSurface(bundle: string): Promise<EmbedSurface | null>
  /** The JS appended after a nested bundle in the exported file: files the surface it just
   *  assigned to __SAILOR_SURFACE__ under its bundle name, and clears __SAILOR_SURFACE__. */
  export function nestedRegistrationJs(bundle: string): string
  /** Drawn device size for a nested player: keeps the source aspect, long side in [64, 4096]. */
  export function nestedDeviceSize(drawnLongPx: number, srcW: number, srcH: number): { w: number; h: number }

  // surfaces.ts (app side)
  /** Every bundle an export needs, nested players first, the main bundle last. For a Frame:
   *  one entry per DISTINCT live bundle in `config.wired`, each re-derived with
   *  bundleNameFor(entry.surface, entry.config) — throws if it differs from entry.bundle. */
  export function bundleNamesFor(kind: string, config: unknown): string[]
  ```

- [ ] **Step 1: Failing unit tests for `nested.ts`** — `resolveNestedSurface` prefers the global map, falls back to the loader, returns null when neither has it; `nestedRegistrationJs('spacetype-boost')` evaluated after a stub that sets `globalThis.__SAILOR_SURFACE__` files it under that name and leaves `__SAILOR_SURFACE__` undefined; the bundle name is JSON-encoded (a name containing a quote cannot break out); `nestedDeviceSize(800, 1080, 1920)` → `{ w: 450, h: 800 }`, clamps to 64 and 4096.
- [ ] **Step 2: Failing unit tests for `bundleNamesFor`** — a Frame with no live entries → `['frame-lean']` (or `['frame']` per `needsOutlines`); two live Space Type slots on the same effect plus one Gradient → `['spacetype-<id>', 'gradient', 'frame-lean']` (distinct, in slot order); an entry whose `bundle` disagrees with `bundleNameFor(surface, config)` throws; a non-Frame kind → `[bundleNameFor(kind, config)]`.
- [ ] **Step 3: Implement `nested.ts` and `bundleNamesFor`.** Run the two specs → PASS.
- [ ] **Step 4: `export.ts`** — replace the single fetch with `bundleNamesFor(opts.kind, opts.config)`; fetch every bundle BEFORE the poster bake (same reason as today's comment); the adapter JS handed to `buildEmbedHtml` is `nested_1 + nestedRegistrationJs(name_1) + … + main`. Each piece gets the `</script` check `buildEmbedHtml` already does (it runs on the joined string — keep it). Register the app loader once at module scope: `setNestedSurfaceLoader(name => loadEmbedSurface(name.startsWith('spacetype-') ? 'spacetype' : name))` so the in-app poster bake resolves nested players from the app registry. Existing `tests/unit/embed-export*.unit.spec.ts` must stay green; add one test that a Frame snapshot with a live entry fetches both bundles in order and the HTML contains the registration JS between them.
- [ ] **Step 5: Frame surface** — in `mount`, for each `wired` entry of kind `live`: `resolveNestedSurface(entry.bundle)` (null → throw `embed: a live layer's player is missing`); mount it into a DETACHED `div` (never in the document); read its `canvas`; keep `{ handle, canvas, duration, srcW: entry.width, srcH: entry.height }` per slot. The provider becomes `stills.get(slot) ?? clipFrame(slot) ?? liveCanvas(slot)`. In `paint`, BEFORE `paintLayerStack`, for each live slot call `handle.setTime(slotPhase01(tSec, duration))` — import `slotPhase01` from `~/lib/compositor/masterClock` only if that module is bundle-safe (no Vue); otherwise copy its three lines into `nested.ts` with a comment naming the original. Sizing: compute each live slot's drawn long side in device px from the wired layers on that slot (`layer.w` is a fraction of the Frame width; height is `w * lastAspect` — mirror `plan.ts`'s wired branch) times the fit scale `r.scale`, and call `handle.setSize(nestedDeviceSize(...))` only when that size changes (track the last size per slot; compute it in the paint path but do NOT resize every frame). `destroy()` and the mount's `catch` destroy every nested handle. A nested mount that rejects rejects the Frame mount.
- [ ] **Step 6: Frame surface unit tests** (with a fake nested surface registered via `setNestedSurfaceLoader`): the provider returns the nested canvas for a live slot; `setTime` receives `slotPhase01` of the Frame time (Frame duration 6 s, slot duration 4 s, t01 0.75 → 4.5 s → 0.125); `setSize` is called once for repeated paints at one size and again after the Frame handle's `setSize`; `destroy` destroys the nested handle; a nested mount rejection rejects the Frame mount and destroys any nested player already mounted.
- [ ] **Step 7:** `cd frontend && npm run build:embed`, then `npx vitest run tests/unit/embed-nested.unit.spec.ts tests/unit/embed-build-output.unit.spec.ts` plus the frame-surface and embed-export unit specs → PASS. Record the new `frame.js`/`frame-lean.js` sizes in the report (they should grow by well under 2 KB).
- [ ] **Step 8: Commit** — `feat(frame-embed): nested live players in the Frame export`.

### Task 2: The live route, end to end, with Gradient

**Files:**
- Modify: `frontend/app/lib/studio/frameSource.ts` (optional `embed()`)
- Modify: `frontend/app/lib/gradientfx/frameSource.ts` (`embed()`)
- Modify: `frontend/app/lib/embed/frame/gather.ts` (try live before frames; notice)
- Modify: `frontend/app/lib/embed/frame/appIO.ts` (`wiredEmbed`, `bundleBytes`)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (`buildWebExport` wires `wiredEmbed`)
- Test: `frontend/tests/unit/frame-embed-gather*.unit.spec.ts` (extend the existing gatherer spec), `frontend/tests/unit/gradientfx-frame-source*.unit.spec.ts` (extend or create)

**Interfaces:**
- Consumes: Task 1's `WiredEntry` `live` variant.
- Produces:
  ```ts
  // lib/studio/frameSource.ts
  /** What a wired layer needs to play live in a Frame export: the studio's own embed player
   *  (`surface` = its embed kind, `bundle` = bundleNameFor(surface, config)) and config.
   *  `width`/`height`: the source's native size (the aspect the player keeps). */
  export interface StudioEmbed { surface: string; bundle: string; config: unknown; width: number; height: number; duration: number }
  // StudioFrameSource gains:
  /** Absent, or resolving null: this source cannot play live faithfully right now — export it
   *  as frames. Never rejects for an ordinary reason; a rejection is treated like null. */
  embed?(): Promise<StudioEmbed | null>

  // gather.ts — FrameExportIO gains (both optional; absent = no live route):
  wiredEmbed?(slot: number): Promise<StudioEmbed | null>
  bundleBytes?(bundle: string): Promise<number>
  ```

- [ ] **Step 1: Failing gatherer tests** — for a planned wired clip: `wiredEmbed` resolving an embed → `wired[slot]` is `{ kind: 'live', surface, bundle, config, width, height, duration }`, `wiredFrames` is NOT called, notice `Gradient · plays live · adds {size}` (bundle bytes + config JSON bytes, formatted with `formatBytes`); resolving null or rejecting → today's frames path (frames pulled, `pre-rendered` notice), no block; two live slots on one bundle → the second notice counts only its config; the plan's `duration`/loop logic is unchanged.
- [ ] **Step 2: Implement the gatherer branch** at the top of the `plan.wiredClips` loop. Use the slot's layer label as today (`c.label`).
- [ ] **Step 3: Gradient `embed()`** — in `makeGradientFrameSource`: when the source is animated (`clock().duration > 0`) resolve `{ surface: 'gradient', bundle: 'gradient', config: { cfg: structuredClone(toRaw(cfg)), duration }, width, height, duration }` using the source's own `width`/`height` getters; a still source resolves null. Match `GradientStudioSurface.vue`'s `exportWebEmbed` config exactly (`cfg` + `duration`) — read it first. Unit test: animated config → that object (deep copy, not the same reference); still config → null.
- [ ] **Step 4: App IO + modal** — `createAppFrameExportIO` gains `wiredEmbed?` (passed through from the modal) and `bundleBytes` (fetch `/embed/${bundle}.js` once per bundle per IO, `text().length` in bytes via `new Blob([t]).size`). In `CompositorModal.vue`'s `buildWebExport`, pass `wiredEmbed: slot => layers.value.find(x => x.slot === slot + 1)?.live?.embed?.() ?? Promise.resolve(null)`. Nothing else in the modal changes; the clip cache is only used by the frames path.
- [ ] **Step 5: Browser check (Playwright, existing server)** — extend `tests/frame-embed-network.spec.ts` (read `tests/_frameEmbedHelpers.ts` first; follow the E2E graph wiring recipe used there) with a Frame whose wired layer is an animated Gradient: the export sheet shows `plays live`, the downloaded HTML makes zero network requests under the recorder, and two frozen times (`__SAILOR_FREEZE_T01__` 0 and 0.5) give different pixels in the Gradient's box. Record the file size.
- [ ] **Step 6:** run the gatherer, gradient frame-source, frame-embed unit specs and the Playwright spec → PASS.
- [ ] **Step 7: Commit** — `feat(frame-embed): wired Gradient layers play live in Frame exports`.

### Task 3: Space Type — one embed config, seamless loops, the node's `embed()`

**Files:**
- Create: `frontend/app/lib/spacetype/embedConfig.ts`
- Create: `frontend/app/lib/spacetype/wiredRenderer.ts` (the node's headless frame-source engine, extracted)
- Modify: `frontend/app/lib/embed/surfaces/spacetype.ts` (`loops`)
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` (`exportWebEmbed` uses the shared builder + font helper; seamless duration)
- Modify: `frontend/app/components/vue-canvas/SpaceTypeNode.vue` (uses `wiredRenderer`; frame source gets `embed`)
- Modify: `frontend/app/lib/spacetype/frameSource.ts` (optional `embed` dep passed through)
- Test: `frontend/tests/unit/spacetype-embed-config.unit.spec.ts` (new), extend `frontend/tests/unit/embed-spacetype.unit.spec.ts`

**Interfaces:**
- Consumes: Task 2's `StudioEmbed` and `StudioFrameSource.embed`.
- Produces:
  ```ts
  // embed/surfaces/spacetype.ts — SpaceTypeEmbedConfig gains:
  /** Base loops one pass of the embed spans (the studio's seamless k). Absent = 1.
   *  setTime(t01) draws renderFrameAt(t01 * loops). */
  loops?: number

  // lib/spacetype/embedConfig.ts
  /** The embed config for a saved Space Type state — the ONE builder the studio's own export
   *  and the Frame's live route share. `font` is the inlined face (or null). */
  export function spaceTypeEmbedConfig(state: SpaceTypeState, font: SpaceTypeEmbedConfig['font']): SpaceTypeEmbedConfig
  /** Seconds one pass lasts: effectiveLoopSeconds(loopDuration, loops). */
  export function spaceTypeEmbedDuration(state: SpaceTypeState): number
  /** Why this state cannot play live faithfully, in words for the report/log — or null. */
  export function liveEmbedBlocker(state: SpaceTypeState): string | null
  /** Effects whose embed player was measured to match the editor (Task 4 fills this). */
  export const LIVE_VERIFIED_EFFECTS: ReadonlySet<string>
  /** Fetch and subset the state's font as a data URL (moved from SpaceTypeSurface.vue). */
  export async function spaceTypeEmbedFont(state: SpaceTypeState): Promise<SpaceTypeEmbedConfig['font']>
  /** For the node's frame source: null when blocked or when the font could not be inlined. */
  export async function spaceTypeWiredEmbed(state: SpaceTypeState, size: { width: number; height: number }): Promise<StudioEmbed | null>

  // lib/spacetype/wiredRenderer.ts — exactly the node's current createHeadless/ensureHeadless
  // behaviour, moved, so the node and Task 4's parity harness render through ONE code path.
  export interface WiredSpaceTypeRenderer { render(state: SpaceTypeState, t01: number, w: number, h: number): Promise<HTMLCanvasElement | null>; markDirty(): void; dispose(): void }
  export function createWiredSpaceTypeRenderer(): WiredSpaceTypeRenderer
  ```

- [ ] **Step 1: Read first** — `SpaceTypeSurface.vue` `exportWebEmbed` and its font helpers (`fetchFontDataUrl`, ~line 1750–1870), `SpaceTypeNode.vue` frame source + `createHeadless`/`ensureHeadless` (~line 195–275), `lib/spacetype/state.ts` `texOptsFromState`, `lib/spacetype/loop.ts`, `lib/compositor/loopReconcile.ts`, and `shared/spacetype/state.ts`. Find every way a Space Type state can reference something the embed player cannot carry: Showcase image cards (`isShowcaseEffectId`, `lib/spacetype/imageTextures.ts`), loft word mode (`resolveShape(params) === 'word'` loads an outline font by URL), Boost's fontkit font (`ensureBoostFont`), any fill that names an image or a shader (grep `SpaceTypeSurface.vue` near line 309 and the params types). Each becomes a `liveEmbedBlocker` reason. List them in the report.
- [ ] **Step 2: Failing unit tests** — `spaceTypeEmbedConfig` maps every field the studio export maps today (effectId, params copy, opts width/height/fps/loopDuration/alpha(=transparent)/bgColor/projection/panX/panY, duration, font, gradientStops copy, post copy) plus `loops` = `loopMultiplier(effect.loopRates?.(params) ?? [])` when `state.seamless`, absent otherwise; `spaceTypeEmbedDuration` = `effectiveLoopSeconds`; `liveEmbedBlocker` returns a reason for each Step 1 case and for an effect not in `LIVE_VERIFIED_EFFECTS`, null otherwise; `spaceTypeWiredEmbed` returns null when blocked, null when `spaceTypeEmbedFont` gives null for a non-system family, and `{ surface: 'spacetype', bundle: 'spacetype-<id>', config, width, height, duration }` otherwise. Adapter test: with `loops: 3`, `setTime(0.5)` calls `renderFrameAt(1.5, params)`; absent → `renderFrameAt(0.5, …)` (unchanged).
- [ ] **Step 3: Implement** `embedConfig.ts`, the adapter's `loops`, and `wiredRenderer.ts` (move, don't rewrite: same setters in the same order, same font priming, same `syncImageTextures` handling). `LIVE_VERIFIED_EFFECTS` starts EMPTY — Task 4 measures and fills it; until then every Space Type layer keeps the frames route, which is correct.
- [ ] **Step 4: Rewire** — `SpaceTypeNode.vue` uses `createWiredSpaceTypeRenderer()` for its frame source and passes `embed: () => spaceTypeWiredEmbed(state.value, clock)`; `lib/spacetype/frameSource.ts` exposes it as `embed()` when the dep is given. `SpaceTypeSurface.vue`'s `exportWebEmbed` builds its config with `spaceTypeEmbedConfig(stateFromTheModal, font)` and exports with `duration: spaceTypeEmbedDuration(...)` — build the state object from the modal's refs exactly as its save path does (find the function that writes `sailor_spaceType`). The standalone export's behaviour is unchanged for non-seamless pieces; seamless pieces now loop over their full `k` loops.
- [ ] **Step 5:** `npm run build:embed`; run the new spec, `embed-spacetype.unit.spec.ts`, every `spacetype*` unit spec, `embed-build-output.unit.spec.ts`; `npx vue-tsc --noEmit -p .` filtered to the files you touched (compare against the baseline error count first — see the typecheck baseline note: count errors before and after, report both).
- [ ] **Step 6: Commit** — `feat(spacetype): one embed config, seamless loops in embeds, wired layers can offer a live player`.

### Task 4: Measure which effects play live, then prove the whole route

**Files:**
- Create: `frontend/app/pages/dev/spacetype-live-parity.vue` (dev harness)
- Create: `frontend/tests/spacetype-live-parity.spec.ts`
- Modify: `frontend/app/lib/spacetype/embedConfig.ts` (`LIVE_VERIFIED_EFFECTS`, from the measurement)
- Modify: `frontend/tests/frame-embed-network.spec.ts` (a wired Space Type case)

- [ ] **Step 1: Harness** — for each id in `SPACE_TYPE_EFFECTS`, take the effect's default scene state (`spaceDefaultFor(id)` applied the way a fresh node applies it — read `SpaceTypeNode.vue`'s `applyDefaultScene` path; fall back to `defaultSpaceTypeState()` with that `effectId`), render A through `createWiredSpaceTypeRenderer().render(state, t01, 480, h)` and B through the Space Type embed surface (the app registry's default export) mounted with `spaceTypeEmbedConfig(state, await spaceTypeEmbedFont(state))`, `setSize(480, h)`, `setTime(t01)`, at t01 ∈ {0, 0.37, 0.71}. Compare pixels: mean absolute difference per channel and the share of pixels differing by > 24 (of 255). Expose results on `window.__parity`. Skip (and list) any effect `liveEmbedBlocker` rejects for a reason other than "not verified".
- [ ] **Step 2: Measure** — run the spec; it prints a table: effect, mean diff, share over 24, pass/fail. Pass = mean < 2 AND share < 0.5% at all three times. Record the table in the report. Do NOT loosen the thresholds to make an effect pass; an effect that fails stays on the frames route, and the report names it with its numbers.
- [ ] **Step 3: Fill `LIVE_VERIFIED_EFFECTS`** with exactly the passing ids. The spec then asserts: every verified id passes (a regression fails the test), and it logs any unverified id that now passes.
- [ ] **Step 4: End to end** — in `tests/frame-embed-network.spec.ts`, a Frame with a wired Space Type node on a verified effect (6 s loop, filling the Frame): the export sheet line says `plays live`; the HTML makes zero network requests; frozen t01 0 and 0.5 differ inside the layer's box; the file size is recorded. Compare it in the report with the 28.5 MB pre-rendered figure. Also: a Frame whose Space Type effect is NOT verified still exports as frames (`pre-rendered` line) — the fallback works.
- [ ] **Step 5:** run both Playwright specs plus the Task 1–3 unit specs → PASS.
- [ ] **Step 6: Commit** — `feat(frame-embed): verified Space Type effects play live in Frame exports`.
