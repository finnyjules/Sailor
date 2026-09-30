# Relight stage 2: MoGe-2 surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a photo gets Relight, Sailor reads its surfaces with MoGe-2 once (priced, metered, cached per photo), shows the price while it works, and the live lighting switches from the local depth estimate to the model's surfaces when they arrive.

**Architecture:** A real server route `POST /api/depth/surfaces` replaces the dev-only `moge-normals` route. It calls fal through the existing metered `runFal` with a price-book row, checks file ownership when hosted, and caches the normal map by content hash. On the client, a `surfacesRegistry` (a mirror of `depthRegistry`) fetches and caches the image. The Frame editor asks for surfaces for every Relight layer in the open Frame; paints only *use* surfaces that are already there. `GpuPost` gains one optional extra texture, and the relight shader uses it when present.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Nitro server, fal via `server/utils/falRun.ts`, WebGL2 via `GpuPost`, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md` ("Shape maps", "Money and hosting", "Decided in review"). Stage 1 is landed: `a44abbda0`..`f0d1f7da1` (see `docs/STATE.md`, "Frame Relight").

## Global Constraints

- MoGe-2 call, exactly: fal app `fal-ai/moge-2`, input `{ image_url, model: 'vitl-normal', apply_mask: false, export_glb: false, export_ply: false }`. Use the output's `normal_map.url`. The normal PNG is **red = right, green = UP, blue = toward the camera**.
- Price: **$0.0125 per call** (estimate: about 10 s of compute at $0.00125/s), confidence `'estimate'` until the paid check in Task 5 sets it from the real bill. Credits come from `creditsForUsd` (`shared/pricing/markup.ts`), which gives **3 credits**. The number lives in one place (`shared/pricing/relightSurfaces.ts`); the price book and the client both read it.
- **Surfaces show their price every time a photo gets Relight** (user decision 2026-09-30): while surfaces are being read for a photo, the Relight panel's status line reads `Reading shape · <price>`. A photo whose surfaces are already cached costs nothing and shows no price. The price is shown, never asked for (no confirmation dialog, which matches the cost gate's $1 threshold).
- **The effect never waits on surfaces.** Relight lights from local depth at once and swaps in the surfaces whenever they land, cold starts included (measured 203 s cold, 7.7 s warm). No timeout gives up on the user's side. The server polls for up to 300 s.
- **Paints never make paid calls.** Only the Frame editor requests surfaces, for Relight layers in the open Frame. Cards, layout tiles and exports use surfaces only if they are already cached.
- Cache: `input/sailor_depth/moge_<depthCacheKey(bytes)>.png`, the same name the dev route used, so the three photos already read are free.
- Hosted: the route requires the caller to own the input file (the `moodboards/refs.post.ts` pattern), is rate-limited, and is metered by `runFal` (the ledger hold is released on failure). A cache hit is free and unmetered.
- Kill switch: env `NUXT_RELIGHT_SURFACES=off` makes the route answer 503 `{ off: true }`. The client then stays on local depth quietly. The default is on.
- The web-export build must not contain the route literal: the new client request module is swapped out in `vite.embed.config.ts` exactly as `depthRequest.ts` is.
- UI copy: sentence case; explanations only as tooltips.
- Commits: the private-index recipe and the CompositorModal.vue recipe, identical to stage 1 (the SDD workspace carries `global-constraints.md`). Type check: `cd frontend && npx vue-tsc --noEmit`, with no new errors against the recorded baseline. **Never start, stop or restart the dev server on :3002.**

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `frontend/shared/pricing/relightSurfaces.ts` | create | `SURFACES_APP`, `SURFACES_USD`, `surfacesCredits()` |
| `frontend/server/utils/priceBook.ts` | modify | the `fal-ai/moge-2` row, from the shared constant |
| `frontend/server/utils/inputOwnership.ts` | create | `assertInputOwned(event, type, subfolder, filename)` for hosted mode |
| `frontend/server/api/depth/surfaces.post.ts` | create | the priced route |
| `frontend/server/api/depth/estimate.post.ts` | modify | ownership check (same helper) |
| `frontend/server/api/depth/moge-normals.post.ts` | delete | the dev route (never committed; delete the file) |
| `frontend/app/lib/compositor/surfacesRequest.ts` | create | the one network call (swapped out in embed builds) |
| `frontend/app/lib/compositor/surfacesRegistry.ts` | create | client cache + status + change events |
| `frontend/vite.embed.config.ts` | modify | swap `surfacesRequest.ts` for a stand-in |
| `frontend/app/lib/compositor/gpuPost.ts` | modify | optional extra texture `uNormals` (TEXTURE2), uploaded once per image |
| `frontend/app/lib/relight/relightPass.ts` | modify | the shader's surfaces path; `applyRelight(..., normals?)` |
| `frontend/app/composables/useCompositorLayers.ts` | modify | paints pass cached surfaces to `applyRelight` |
| `frontend/app/components/vue-canvas/compositor/RelightControls.vue` | modify | status line with price; Retry |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | modify | request surfaces for Relight layers in the open Frame; repaint on arrival |
| tests | create/modify | listed per task |

---

### Task 1: The priced route

**Files:**
- Create: `frontend/shared/pricing/relightSurfaces.ts`, `frontend/server/utils/inputOwnership.ts`, `frontend/server/api/depth/surfaces.post.ts`
- Modify: `frontend/server/utils/priceBook.ts` (add a row under `// — segmentation / utility —`, ~L705), `frontend/server/api/depth/estimate.post.ts`
- Delete: `frontend/server/api/depth/moge-normals.post.ts` (untracked; `rm`)
- Test: `frontend/tests/unit/relight-surfaces-route.unit.spec.ts` (create); `price-book.unit.spec.ts` must still pass (its coverage test now sees `'fal-ai/moge-2'`); `bypass-route-meter.unit.spec.ts` must pass (the route goes through `runFal`, with no raw fal host)

**Interfaces:**
- Produces:
  - `SURFACES_APP = 'fal-ai/moge-2'`, `SURFACES_USD = 0.0125`, `surfacesCredits(): number` (= `creditsForUsd(SURFACES_USD)` = 3)
  - `assertInputOwned(event: H3Event, type: 'input'|'output'|'temp', subfolder: string, filename: string): Promise<void>`: throws 404 when hosted and the file's recorded owner is someone else
  - `POST /api/depth/surfaces` body `{ filename, subfolder?, type? }`, which returns one of:
    - `{ normalsFilename, subfolder: 'sailor_depth', cached: boolean }`
    - 503 `{ off: true }` when switched off
    - 4xx/5xx `{ message }`

- [ ] **Step 1: Write the failing test**

Mock fal the way `chokepoint-meter.unit.spec.ts` does (`vi.stubGlobal('fetch', …)` serving `queue.fal.run/fal-ai/moge-2`, its status, and its result with `normal_map.url`, plus the PNG download). Use a temp directory for the input root: factor the route's roots into a small exported `surfacesPaths(root)` if needed, so the test can point it at `os.tmpdir()`. Cover:

```ts
// frontend/tests/unit/relight-surfaces-route.unit.spec.ts — cases (write each as its own it())
// 1. cache miss: calls runFal once with EXACTLY { image_url: 'data:image/png;base64,…', model: 'vitl-normal',
//    apply_mask: false, export_glb: false, export_ply: false }, writes moge_<hash>.png, returns { cached: false }
// 2. cache hit (file already there): no fetch at all, returns { cached: true }
// 3. NUXT_RELIGHT_SURFACES=off → 503 with { off: true }, no fetch
// 4. unsafe filename ('../x.png') → 400, no fetch
// 5. hosted (NUXT_CLERK_SECRET_KEY set, context userId 'u1'), file owned by 'u2' → 404, no fetch
// 6. fal result without normal_map → 502, and (hosted) the meter hold is released (use __setLedgerForTests as request-meter.unit.spec.ts does)
// 7. price: costForModel('fal-ai/moge-2') → { usd: 0.0125, credits: 3 }
```

- [ ] **Step 2: Run it to verify it fails**

`cd frontend && pnpm vitest run tests/unit/relight-surfaces-route.unit.spec.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`shared/pricing/relightSurfaces.ts`:
```ts
/** MoGe-2 surfaces for Relight (spec 2026-09-30, stage 2). One call per new photo, cached by content. */
import { creditsForUsd } from './markup'
export const SURFACES_APP = 'fal-ai/moge-2'
/** Estimate: ~10 s compute at fal's $0.00125/s. Set from the real bill after the stage 2 paid check. */
export const SURFACES_USD = 0.0125
export const surfacesCredits = (): number => creditsForUsd(SURFACES_USD)
```

The price-book row, using the constant (import from `#shared/pricing/relightSurfaces` or the path priceBook already uses for shared modules):
```ts
  [SURFACES_APP]: { usd: SURFACES_USD, credits: surfacesCredits(), confidence: 'estimate', note: 'Relight surfaces — MoGe-2 normals, ~$0.00125/s compute, ~10 s; cold starts ~200 s (billing of the wait unverified)' },
```
If the coverage regex in `price-book.unit.spec.ts` needs the literal slug as a key, write the key as the literal `'fal-ai/moge-2'` and keep the value from the constants.

`server/utils/inputOwnership.ts`: follow `server/api/moodboards/refs.post.ts:46-63`. When `isHosted()`, look up `uploadOwner(canonicalUploadKey(type, subfolder, filename))`. Throw 404 `'not found'` when the owner is non-null and differs from `event.context.userId`. For `type === 'output'`, use the same helper the graph uses (`ownedOutputKeys` / `viewGateDecision`) if it is directly usable; otherwise refuse `output`/`temp` sources when hosted, with 404. Local mode: no check.

`server/api/depth/surfaces.post.ts`: the flow is the dev route's (read it before deleting). Change these things:
- Gate: kill switch (`process.env.NUXT_RELIGHT_SURFACES === 'off'` → 503 `{ off: true }`), then `assertRateLimit(event, 'depth-surfaces', 20)`, then path safety (`assetType`, `safeAssetRelPath`), then `assertInputOwned`.
- Cache check before any fal call.
- `runFal<{ normal_map?: { url?: string } }>(SURFACES_APP, input, { pollDeadlineMs: 300_000 })`.
- Download `normal_map.url` with a 60 s timeout, write the file, return.

Errors: 502 with a plain `message`. `estimate.post.ts`: add `await assertInputOwned(event, root, body?.subfolder ?? '', …)` after its path checks, using the same arguments the route already resolves.

Then `rm frontend/server/api/depth/moge-normals.post.ts`. The uncommitted prototype `app/pages/dev/relight.vue` calls that route. Change its one `$fetch('/api/depth/moge-normals', …)` to `/api/depth/surfaces` (response key `normalsFilename` is unchanged). The prototype stays uncommitted; don't commit it.

- [ ] **Step 4: Run the tests**

`cd frontend && pnpm vitest run tests/unit/relight-surfaces-route.unit.spec.ts tests/unit/price-book.unit.spec.ts tests/unit/bypass-route-meter.unit.spec.ts tests/unit/request-meter.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts tests/unit/depth-cache.unit.spec.ts`. Expected: PASS. Then run the type check.

- [ ] **Step 5: Commit** (private-index recipe) with the new and modified files. The deleted dev route was never tracked, so it needs no git step. Message: `feat(relight): priced, metered MoGe-2 surfaces route with hosted ownership checks (stage 2)`.

---

### Task 2: Client request and registry

**Files:**
- Create: `frontend/app/lib/compositor/surfacesRequest.ts`, `frontend/app/lib/compositor/surfacesRegistry.ts`
- Modify: `frontend/vite.embed.config.ts` (swap `surfacesRequest.ts` exactly as `depthRequest.ts` is swapped; read how, and make the stand-in return `{ ok: false, message: 'not available in exports' }`)
- Test: `frontend/tests/unit/surfaces-registry.unit.spec.ts` (model it on `depth-registry.unit.spec.ts`)

**Interfaces:**
- Consumes: `DepthRef`, `DepthSource`, `depthKey` from `depthRegistry.ts`.
- Produces:
  - `requestSurfacesRead(src): Promise<SurfacesResult>` where `SurfacesResult = { ok: true; normalsFilename: string; subfolder: string; cached: boolean } | { ok: false; off?: boolean; message: string }`
  - Registry:
    - `surfacesStatusFor(ref): 'idle'|'loading'|'ready'|'error'|'off'`
    - `surfacesImageFor(ref): HTMLImageElement | null` (sync, paint-safe)
    - `surfacesMessageFor(ref): string | null`
    - `surfacesWasPaidFor(ref): boolean` (true while a request that is not a cache hit is in flight; drives the price line)
    - `onSurfacesChange(cb): () => void`
    - `requestSurfaces(ref): void`
    - `retrySurfaces(ref): void`
    - `__resetSurfacesRegistry(): void`

- [ ] **Step 1: Write the failing tests.** Copy the depth-registry spec's structure and fake-image approach. Cases:
  - one request per key while in flight;
  - `ready` loads the image and notifies;
  - a server `off` → status `'off'`, not retried automatically, and `retrySurfaces` does not call again while off;
  - `error` → status `'error'` with the message, and `retrySurfaces` calls again;
  - `requestSurfaces` on a `ready` key does nothing.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** by mirroring `depthRegistry.ts` (same keying via `depthKey`, same notify pattern, same `/view` URL building for the returned file). Keep status `loading` until the image has decoded.

  Price display: the route only tells whether it was a cache hit when it answers. So `surfacesWasPaidFor` is true from request start until the answer, and false if the answer is `cached: true`. The panel shows the price only while it is true. A cached photo therefore shows the price for the few milliseconds of the round trip at most. That is acceptable: the price tells the truth ("may cost"), and the line disappears at once on a hit.
- [ ] **Step 4: Run tests** (`surfaces-registry`, `depth-registry`, `embed-*` specs that assert swapped modules if any exist: `grep -l depthRequest tests/unit`). Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(relight): client surfaces registry, swapped out of web exports (stage 2)`.

---

### Task 3: The shader uses surfaces

**Files:**
- Modify: `frontend/app/lib/compositor/gpuPost.ts`, `frontend/app/lib/relight/relightPass.ts`
- Test: `frontend/tests/unit/relight-pass.unit.spec.ts`, `frontend/tests/unit/gpu-post-uniforms.unit.spec.ts` (extend)

**Interfaces:**
- Produces:
  - `GpuPost.render(color, depth, w, h, uniforms, extra?: { normals?: CanvasImageSource })`. When `extra.normals` is given, it is bound on TEXTURE2 as sampler `uNormals`, uploaded with FLIP_Y **on** like the colour image, and only re-uploaded when the image object differs from the last one uploaded (and after a drop / context loss).
  - `applyRelight(color, depth, fx, w, h, rect?, normals?: CanvasImageSource | null)`. Keep the existing parameter order; append `normals`.
  - The shader gains `uniform sampler2D uNormals; uniform float uHasNormals;`.

- [ ] **Step 1: Failing tests.** In `relight-pass.unit.spec.ts`, assert that `RELIGHT_FRAG` declares `uNormals` and `uHasNormals`; that the normals branch flips green (`m.y = -m.y`); and that it samples normals through the same depth-rect mapping the depth lookup uses (assert the shared helper's name appears in both lookups). In `gpu-post-uniforms.unit.spec.ts`, test a pure helper `needsUpload(last, next)`: same object → false, different → true, null last → true.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**

  In the shader, factor the depth lookup's coordinate mapping into one function (e.g. `vec2 fieldUv(vec2 p)` returning the GL-space uv for box point `p` through `uDepthRect`), used by `H(p)` and by the normals lookup. In `normalAt(p)`, when `uHasNormals > 0.5`:
  ```glsl
  vec3 m = texture(uNormals, fieldUv(p)).rgb * 2.0 - 1.0;
  m.y = -m.y;                                   // model map: green = up; lighting space: y down
  vec3 N = normalize(vec3(m.xy * (uRelief / 4.0), m.z) + vec3(-detailSlope * 0.5, 0.0));
  return N;
  ```
  `detailSlope` is the existing photo-texture slope term (the `(lx, ly) * uDetail` part), computed before this branch. `uRelief / 4.0` makes the Depth slider's default (4) mean the model's own surfaces, as in the approved mockup. The shadow march and `P.z` keep using the depth field.

  In `gpuPost.ts`, add a lazily created third texture and `lastNormals` identity, cleared in `drop()` and `init()`, with the same TEXTURE params as `mkTex()`. Bind `uNormals` to unit 2 whenever the program has that uniform. When no normals are given, set `uHasNormals` to 0 through the uniforms (`applyRelight` sends `uHasNormals: normals ? 1 : 0`) and still bind a 1×1 dummy on unit 2, so the sampler is never unbound.
- [ ] **Step 4: Run tests** (`relight-pass`, `gpu-post-uniforms`, `gpu-post-robustness`, `dof-pass`, `finish-pass`) and the type check.
- [ ] **Step 5: Commit.** Message: `feat(relight): light from MoGe-2 surfaces when present; GpuPost gains an extra texture (stage 2)`.

---

### Task 4: Wire it in — request, repaint, panel price

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`gpuContent`: pass `surfacesImageFor(ref)` to `applyRelight`; wired paths likewise; never call `requestSurfaces` here), `frontend/app/components/vue-canvas/CompositorModal.vue`, `frontend/app/components/vue-canvas/compositor/RelightControls.vue`
- Test: `frontend/tests/unit/relight-controls.unit.spec.ts` (extend); `frontend/tests/unit/relight-surfaces-request.unit.spec.ts` (create) for the pure "which layers need surfaces" helper

**Interfaces:**
- Produces:
  - `relightSurfaceRefs(layers): DepthRef[]` in `lib/relight/` (pure): the depth refs of layers carrying a **visible** Relight effect that have a depth source. Image layers use the filename; wired layers use the ref `depthSourceFromViewUrl` returns. It mirrors `localDepthSource`.
  - `RelightControls` new props: `surfacesStatus: 'idle'|'loading'|'ready'|'error'|'off'`, `surfacesPrice: string | null`. New emit: `retry-surfaces`.

- [ ] **Step 1: Failing tests.**
  - The helper: hidden effect → excluded; text layer → excluded; two layers of one photo → one ref (dedupe by `depthKey`).
  - The panel:
    - `loading` + price `'3 credits'` → text contains `Reading shape · 3 credits`;
    - `loading` + null price → `Reading shape`;
    - `error` → a Retry button that emits `retry-surfaces`;
    - `off` and `ready` → no status line.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
  - `CompositorModal.vue`:
    - Watch the open Frame's layers (deep enough to see effect stacks) and call `requestSurfaces(ref)` for each ref from `relightSurfaceRefs`. The registry dedupes.
    - Subscribe `onSurfacesChange(() => { surfacesTick.value++; renderStack() })` next to the existing `onDepthChange` subscription, and unsubscribe on unmount.
    - For the Relight inspector block, pass:
      - `surfacesStatus` from `surfacesStatusFor(activeEffectDepth)` (via the tick, like `activeEffectDepthStatus`);
      - `surfacesPrice`: when `surfacesWasPaidFor(ref)`, `hosted ? \`${surfacesCredits()} credits\` : formatUsd(SURFACES_USD)` using the app's existing price-text helpers in `app/lib/pricing.ts`, with the hosted flag from `hostedModeEnabled(useRuntimeConfig().public)` as `useLayerAnimate.ts` does; else `null`;
      - `@retry-surfaces` → `retrySurfaces(ref)`.
  - Status line copy in `RelightControls.vue` (sentence case, in the existing status slot, replacing the depth `Reading shape…` line when surfaces are loading):
    - loading: `Reading shape · <price>` (or `Reading shape` without a price);
    - error: `Couldn't read this photo's shape` plus a small `Retry` button.
    - Tooltip on the status line: `Worked out once per photo`.
  - `useCompositorLayers.ts`: in `gpuContent`, `const normals = dofRef ? surfacesImageFor(dofRef) : null`, passed as the new last argument. In the wired path, the same with the ref it already has. **Do not request surfaces from a paint.**
  - Commit CompositorModal.vue with its special recipe.
- [ ] **Step 4: Run tests** (the two new or extended specs, `relight-paint`, `dof-paint`) and the type check.
- [ ] **Step 5: Commit.** Message: `feat(relight): read surfaces for Relight layers in the open Frame, show the price, swap in when ready (stage 2)`.

---

### Task 5: Browser check, and the one paid check

**Files:**
- Modify: `frontend/tests/relight-effect.spec.ts` (add a describe block)
- Modify: `frontend/shared/pricing/relightSurfaces.ts` and the price-book row only if the paid check shows a different real cost

**Interfaces:** consumes everything above.

- [ ] **Step 1: A free browser test with the route mocked.** Use `page.route('**/api/depth/surfaces', …)` to answer after an 800 ms delay with `{ normalsFilename: 'moge_a579ac8e5ca4ba75.png', subfolder: 'sailor_depth', cached: false }`. That file exists in `input/sailor_depth` for the puppy, so `/view` serves it. Then:
  - add Relight to the puppy (the existing `addRelight` helper);
  - assert the panel shows `Reading shape ·` with a price while the mock is pending;
  - after it answers, assert the status line is gone, `__relightRuns` increased again, and the picture differs from the depth-only picture captured before the answer (surfaces changed the shading).

  A second case: the mock answers 503 `{ off: true }`, so no status line and the picture stays on depth only. A third case: the mock answers 500, so the error line and Retry appear, and clicking Retry calls the route again (count requests).
- [ ] **Step 2: Run** `cd frontend && pnpm exec playwright test tests/relight-effect.spec.ts`. Expected: all pass (the 7 stage 1 tests plus the new ones).
- [ ] **Step 3: The paid check (one real call, about $0.01; the user approved stage 2 on 2026-09-30).**
  - Pick an image in `input/` with no `moge_*` file yet: compute its `depthCacheKey` and check `input/sailor_depth`.
  - Call the real route once: `curl -s -X POST http://127.0.0.1:3002/api/depth/surfaces -H 'content-type: application/json' -d '{"filename":"<name>","type":"input"}'`.
  - Record the wall time, the response, and the written file.
  - Call it again, and record that the second answer is `cached: true` and instant.
  - Then look up the real charge if fal's usage API is reachable with the local key: `curl -s -H "Authorization: Key $FAL_KEY" "https://api.fal.ai/v1/models/usage?endpoint_id=fal-ai/moge-2"`. If it isn't, record "billing not readable; kept estimate".
  - If the real cost differs from $0.0125 by more than 30%, update `SURFACES_USD` (and the note) and re-run `price-book.unit.spec.ts`.
  - Never make more than **2** paid calls in this task.
- [ ] **Step 4: Look.** Screenshot a Neon relight on the image from Step 3 with depth only (before surfaces land) and after, and describe the difference.
- [ ] **Step 5: Commit** the spec (and the price constant if it changed). Message: `test(relight): surfaces swap, price line, switched off and retry; paid check recorded (stage 2)`.

---

### Task 6: Record the state

- [ ] `docs/STATE.md`: extend the Frame Relight entry with stage 2: what landed, the commits, the paid check's numbers, and what's still open.
- [ ] The ⛵ State of the Build dashboard: read the live artifact first, replace rather than append.
- [ ] Commit `docs/STATE.md` alone.

---

## Rulings made while writing this plan (against the spec)

- **No runner family.** The spec said surfaces would be "a runner family (off until priced)". Frame-editor utility routes (cut-out, smart select, Animate) are not runner nodes and don't use families. They are gated by a price-book row, hosted metering through `runFal`, and rate limits. This plan follows that pattern and adds an env kill switch. The paid check happens inside this stage, so the switch defaults to on. Cost if wrong: a later move to a family if the user wants surfaces behind the runner switchboard.
- **The price is shown, not confirmed.** Sailor has no automatic-paid-step pattern. The user asked to "show it every time", and the global cost gate only asks at $1 or more. So the price appears in the panel's status line while a photo's surfaces are being read.
- **Paints never pay.** Requests come only from the open Frame editor, so a project full of relit photos never fires paid calls from canvas cards or exports.
- **Ownership check added to `/api/depth/estimate` too.** The same hosted gap (read any file by name). It costs one line with the same helper.
