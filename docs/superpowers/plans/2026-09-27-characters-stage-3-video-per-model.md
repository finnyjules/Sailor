# Characters stage 3 — video per model: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shot Director can film a character on Seedance 2.0, Kling 3 or Veo 3.1 (and Veo 3.1 Fast). Each model gets the character in the form it understands. A shot can start from a first frame made from the characters. Every take is scored against the characters' faces.

**Architecture:**
- **What each model gets.** A shared "identity ref set" per character look (front face, portrait, body front, body back) feeds a per-model Shot Director profile. The profile decides the form:
  - Seedance: flat pictures.
  - Veo: flat pictures on `reference-to-video`.
  - Kling: one fal "element" per character, plus the required start frame.
- **Where shots run.** The Sailor runner (Nitro) now takes a *shot-directed* "Film a shot" node. It resolves the node's `/view` references into provider links and reuses the Generate-a-video builders. The Kling and Veo builders gain their reference forms.
- **Face scores on takes.** Three frames of each new take are decoded in the browser and sent to a new route. The route compares them with each character's face, using AWS for Photo characters and Claude for Anime ones. The scores are stored on the take.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Nitro server routes, Vitest, Playwright, mediabunny (browser decode), AWS Rekognition via `server/utils/faceCheck/`.

**Spec:** `docs/superpowers/specs/2026-09-26-characters-rework-design.md`. The relevant sections are "What gets sent (per model)", "Style: Photo and Anime", "Checks", and Build stages §3.

## Global Constraints

- The combined sheet grid is **never** sent to any model.
- Seedance 2.0/2.5 gets at most 2 images per character (portrait + full-body front). It can't mix references with a start frame.
- Kling 3 gets one element per character: the front face as the main image, plus up to 3 more (portrait, body front, body back). A start frame is required (fal's `image-to-video` requires `start_image_url`). Elements are referenced in the prompt as `@Element1`, `@Element2`, and so on.
- Veo 3.1 gets up to 3 separate images on `fal-ai/veo3.1/reference-to-video` (fast: `fal-ai/veo3.1/fast/reference-to-video`). References and a first frame are exclusive on Veo. Veo never takes a last frame.
- When a request can't be sent as asked, refuse it in plain words. Never drop a reference silently.
- UI copy is sentence case, with no identifiers and no explanatory small text in panels (hints go in tooltips). Labels quote the user's own content, such as the character's name.
- Work in the main checkout. No worktree or branch, and never `git stash`. **Commit with a private index in ONE Bash call:**
  ```
  export GIT_INDEX_FILE=$(mktemp); git read-tree HEAD; git add <your paths>; git diff --cached --stat; git commit -m "…"
  ```
  Then, in a separate call without that variable: `git reset -q -- <your paths>`. The trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Other sessions edit this checkout at the same time. If a file you touch already has someone else's uncommitted hunks, stage only your own hunks (`git diff <file>`, keep your hunks, then `git apply --cached`).
- Never run `npm run dev` and never restart servers. The shared dev server is on `127.0.0.1:3002`, and ComfyUI is on `127.0.0.1:8188`.
- No paid calls in any task except Task 12, and only after the user's go-ahead.
- Unit tests: `cd frontend && npx vitest run <file>`. Type check the files you touched with `npx vue-tsc --noEmit -p .`, compared against the baseline (the tree has pre-existing errors; introduce none).

---

### Task 1: Identity ref sets per character look

**Files:**
- Modify: `frontend/shared/characters/types.ts` (next to `videoIdentityRefs`, ~L136)
- Modify: `frontend/app/composables/useCharacters.ts` (`resolveStateRefs`, ~L84)
- Modify: every caller of `videoIdentityRefs` (grep; at least `useCharacters.ts`)
- Test: `frontend/tests/unit/character-model.unit.spec.ts` (extend) and `frontend/tests/unit/characters-composable.unit.spec.ts` (extend)

**Interfaces:**
- Produces:
  - `interface IdentityRefSet { name: string; front: string | null; portrait: string | null; bodyFront: string | null; bodyBack: string | null }` (filenames)
  - `identityRefSet(record: CharacterRecord, state: CharacterState | undefined): IdentityRefSet`
  - `videoIdentityRefs(record: CharacterRecord, state: CharacterState | undefined): string[]` (a new signature; carries over Ruling M from stage 2)
  - `lookFaceFilename(record, state): string | null`
  - In `useCharacters`: `resolveCastSets(picks: { slug: string; stateId: string | null }[]): Record<string, IdentityRefSet>`, whose values are `/view` URLs made by `viewRefUrl`. `resolveStateRefs` stays, delegating to `videoIdentityRefs(record, state)`.

- [ ] **Step 1: Write failing tests** in `character-model.unit.spec.ts`:

```ts
import { identityRefSet, videoIdentityRefs, lookFaceFilename } from '#shared/characters/types'

const panel = (slot: string, filename: string) => ({ slot, filename, check: null, madeFrom: null })
const state = (over: Record<string, unknown> = {}) => ({
  id: 'default', label: 'Default', descriptor: '', refImages: ['cover.png'], coverIndex: 0,
  panels: [], sheetImage: 'grid.png', clothes: [], face: null, status: 'draft', stressResult: null, updatedAt: '', ...over,
}) as any
const record = (over: Record<string, unknown> = {}) => ({ slug: 'reva', name: 'Reva', face: { filename: 'face.png', approvedAt: 'x' }, states: [], ...over }) as any

describe('identity ref sets', () => {
  it('uses the face-neutral panel as the front, then portrait, body front, body back', () => {
    const s = state({ panels: [panel('portrait', 'p.png'), panel('face-neutral', 'fn.png'), panel('body-front', 'bf.png'), panel('body-back', 'bb.png')] })
    expect(identityRefSet(record(), s)).toEqual({ name: 'Reva', front: 'fn.png', portrait: 'p.png', bodyFront: 'bf.png', bodyBack: 'bb.png' })
  })
  it('falls back to the look face, then the record face, then the cover for the front', () => {
    expect(identityRefSet(record(), state({ face: { filename: 'lookface.png', approvedAt: 'x' } })).front).toBe('lookface.png')
    expect(identityRefSet(record(), state()).front).toBe('face.png')
    expect(identityRefSet(record({ face: null }), state()).front).toBe('cover.png')
  })
  it('never returns the sheet grid', () => {
    const set = identityRefSet(record({ face: null }), state({ refImages: [] }))
    expect(Object.values(set)).not.toContain('grid.png')
  })
  it('videoIdentityRefs: portrait + body front; with no portrait panel, the face stands in', () => {
    expect(videoIdentityRefs(record(), state({ panels: [panel('portrait', 'p.png'), panel('body-front', 'bf.png')] }))).toEqual(['p.png', 'bf.png'])
    expect(videoIdentityRefs(record(), state({ panels: [panel('body-front', 'bf.png')] }))).toEqual(['face.png', 'bf.png'])
    expect(videoIdentityRefs(record({ face: null }), state())).toEqual(['cover.png'])
    expect(videoIdentityRefs(record({ face: null }), state({ refImages: [] }))).toEqual([])
  })
  it('lookFaceFilename prefers the look face', () => {
    expect(lookFaceFilename(record(), state({ face: { filename: 'l.png', approvedAt: '' } }))).toBe('l.png')
    expect(lookFaceFilename(record(), undefined)).toBe('face.png')
  })
})
```

  Adapt the fixture fields to the real `CharacterRecord` and `CharacterState` shapes in `types.ts`. Keep the asserted values.

- [ ] **Step 2: Run the tests and confirm they fail.** `npx vitest run tests/unit/character-model.unit.spec.ts` should fail with "identityRefSet is not a function" (or signature errors).

- [ ] **Step 3: Implement** in `types.ts`:

```ts
export interface IdentityRefSet { name: string; front: string | null; portrait: string | null; bodyFront: string | null; bodyBack: string | null }

/** The look's face, else the character's approved face (spec: one face per character). */
export function lookFaceFilename(record: CharacterRecord, state: CharacterState | undefined): string | null {
  return state?.face?.filename ?? record.face?.filename ?? null
}

/** Every clean single-person picture of one look, by role. Never the sheet grid. */
export function identityRefSet(record: CharacterRecord, state: CharacterState | undefined): IdentityRefSet {
  const cover = state ? coverFirstRefs(state)[0] ?? null : null
  const front = panelFilename(state, 'face-neutral') ?? lookFaceFilename(record, state) ?? panelFilename(state, 'portrait') ?? cover
  return {
    name: record.name,
    front,
    portrait: panelFilename(state, 'portrait'),
    bodyFront: panelFilename(state, 'body-front'),
    bodyBack: panelFilename(state, 'body-back'),
  }
}

/** Seedance: portrait + full-body front (at most 2). The face stands in for a missing portrait. */
export function videoIdentityRefs(record: CharacterRecord, state: CharacterState | undefined): string[] {
  const set = identityRefSet(record, state)
  const refs = [set.portrait ?? lookFaceFilename(record, state), set.bodyFront].filter((f): f is string => !!f)
  if (refs.length) return [...new Set(refs)]
  return set.front ? [set.front] : []
}
```

  Use the file's existing `panelFilename` helper. If it doesn't accept `undefined`, guard for it. Fix the stale docstring on `identityRefs` (it mentions `CAST_REF_CAP=1`), which is a deferred minor from stage 0.

- [ ] **Step 4: Update `useCharacters.ts`.** `resolveStateRefs` calls `videoIdentityRefs(c, state)` (return `[]` when there is no character). Add `resolveCastSets`, which maps each non-null filename through `viewRefUrl`, and export it from the composable's return. Add a test to `characters-composable.unit.spec.ts` that `resolveCastSets` returns `/view?filename=…&type=input` URLs and keeps `null` roles as `null`.

- [ ] **Step 5: Run the tests** for character-model, characters-composable and shotdirector-cast. Expected: PASS.

- [ ] **Step 6: Commit** `feat(characters): identity ref sets per look; video refs fall back to the face`.

---

### Task 2: Runner — Veo 3.1 reference pictures

**Files:**
- Already saved (commit them with this task): `frontend/tests/unit/fixtures/provider-schemas/fal/fal-ai__veo3.1__reference-to-video.json` and `…__fast__reference-to-video.json`
- Modify: `frontend/server/runner/generators/video.ts` (`veo31`, `VEO_31_ONE_PICTURE`, `veo31HasExtras`, the `RUNNER_VIDEO_MODELS` veo rows)
- Modify: `frontend/server/runner/requestRules.ts` (the GenerateVideoNode Veo check, ~L701-706)
- Test: `frontend/tests/unit/veo-31-one-picture.unit.spec.ts`, `frontend/tests/unit/runner-provider-schemas.unit.spec.ts`, `frontend/tests/unit/runner-video-models.unit.spec.ts`

**Interfaces:**
- Produces:
  - `veo31RefsProblem(adv: Record<string, unknown>, hasFirstFrame: boolean): string | null`
  - The constant `VEO_31_REFS_WORDS`
  - The veo rows get `fnByMode.reference = 'reference-to-video'`

The fal schema (both apps) requires `prompt` and `image_urls`. The optional fields are:
- `aspect_ratio`: `16:9` or `9:16`
- `resolution`: `720p`, `1080p` or `4k`
- `duration`: string, default `"8s"`
- `generate_audio`: boolean
- `auto_fix`: boolean
- `safety_tolerance`

It has **no** `negative_prompt` and **no** `seed`.

- [ ] **Step 1: Write failing tests** in `veo-31-one-picture.unit.spec.ts`:

```ts
import { RUNNER_VIDEO_MODELS, falVideoFn, veo31RefsProblem, VEO_31_REFS_WORDS } from '../../server/runner/generators/video'

const args = (adv: Record<string, unknown>, image: string | null = null) =>
  ({ prompt: 'Reva walks', aspectRatio: '9:16', duration: 5, seed: 7, image, adv })

describe('Veo 3.1 reference pictures', () => {
  for (const id of ['veo-3.1', 'veo-3.1-fast']) {
    it(`${id}: image_urls go to reference-to-video, 8 s, no seed or negative prompt`, () => {
      const d = RUNNER_VIDEO_MODELS[id]!
      const payload = d.build(args({ image_urls: ['a', 'b', 'c'], negative_prompt: 'x', resolution: '1080p' }))
      expect(payload).toEqual({ prompt: 'Reva walks', image_urls: ['a', 'b', 'c'], aspect_ratio: '9:16', duration: '8s', resolution: '1080p', generate_audio: true, auto_fix: true })
      expect(falVideoFn(payload, d.fnByMode)).toBe('reference-to-video')
    })
  }
  it('refuses more than 3 pictures, a first frame beside pictures, a last frame, clips or sounds', () => {
    expect(veo31RefsProblem({ image_urls: ['a', 'b', 'c', 'd'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ image_urls: ['a'] }, true)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ end_image_url: 'z' }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ video_urls: ['v'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ audio_urls: ['s'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ image_urls: ['a', 'b', 'c'] }, false)).toBeNull()
    expect(veo31RefsProblem({}, true)).toBeNull()
  })
  it('the builder throws the same words', () => {
    expect(() => RUNNER_VIDEO_MODELS['veo-3.1']!.build(args({ image_urls: ['a'] }, 'first.png'))).toThrow(VEO_31_REFS_WORDS)
  })
})
```

  Replace or update the old tests that expected `VEO_31_ONE_PICTURE` for `image_urls` alone. The first-frame and text-to-video payload tests must stay byte-identical.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement** in `video.ts`:

```ts
export const VEO_31_REFS_WORDS
  = 'Veo 3.1 takes up to 3 reference pictures, or one first frame — not both, and no last frame, clips or sounds. Remove the extras or pick another model.'

export function veo31RefsProblem(adv: Record<string, unknown>, hasFirstFrame: boolean): string | null {
  const pics = Array.isArray(adv.image_urls) ? adv.image_urls.length : 0
  const clips = ['video_urls', 'audio_urls'].some(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
  if (adv.end_image_url || clips || pics > 3 || (pics > 0 && hasFirstFrame)) return VEO_31_REFS_WORDS
  return null
}
```

  In `veo31`:
  - Replace the `veo31HasExtras` throw with `const p = veo31RefsProblem(adv, !!(image || adv.image_url)); if (p) throw new Error(p)`.
  - When `image_urls` is non-empty, return `{ prompt, image_urls, aspect_ratio: arOr(['16:9','9:16'], aspectRatio, '16:9'), duration: '8s', resolution, generate_audio, auto_fix }`, with the same `resolution`/`generate_audio`/`auto_fix` reads as today. Send no seed and no negative prompt.
  - Otherwise keep today's behaviour exactly.

  Set `fnByMode.reference: 'reference-to-video'` on both veo rows. Keep exporting `VEO_31_ONE_PICTURE` and `veo31HasExtras`: the ComfyUI path (Python, which never sends refs) still uses them (Task 4).

  Before changing `requestRules.ts`, find where `requestRules` runs (grep its importers). The GenerateVideoNode Veo check must use `veo31RefsProblem` when the node is headed for the runner. Veo 3.1 GenerateVideoNodes are always taken by the runner when the runner is on (`RUNNER_VIDEO_MODEL_IDS`). If the same rules also guard the ComfyUI path, keep `VEO_31_ONE_PICTURE` there. Write the reasoning in the report.

- [ ] **Step 4: Fixture fit.** In `runner-provider-schemas.unit.spec.ts`, add a case that builds a Veo reference payload for each veo app and calls `expectFits('fal', '<app>/reference-to-video', payload)`. Follow how the file's existing video cases drive `falVideoFn`. Also check pricing: `videoPriceUsd('veo-3.1', …)` and `'veo-3.1-fast'` must equal the fixtures' `pricingText` for reference-to-video (Veo 3.1: $0.20/s without audio and $0.40/s with audio at 720p/1080p; Fast: $0.10/s and $0.15/s). Assert one value each, taken from the fixture.

- [ ] **Step 5: Run** veo-31-one-picture, runner-provider-schemas, runner-video-models and video-pricing. Expected: PASS.

- [ ] **Step 6: Commit** (with the two fixture files) `feat(runner): Veo 3.1 takes up to 3 reference pictures via reference-to-video`.

---

### Task 3: Runner — Kling 3 elements

**Files:**
- Modify: `frontend/server/runner/generators/twins.ts` (`klingV3Fal`, ~L346)
- Modify: `frontend/server/runner/executors.ts` (the `FAL_FIRST_VIDEO` branch, ~L536: no Replicate backup when elements are sent)
- Test: `frontend/tests/unit/runner-replicate-video.unit.spec.ts` and `runner-provider-schemas.unit.spec.ts`

**Interfaces:**
- Consumes: `adv.elements: { frontal_image_url: string; reference_image_urls: string[] }[]`. Task 4 resolves the links inside them to provider links before the builder runs.
- Produces:
  - `KLING_ELEMENTS_NEED_FRAME = 'Kling 3 needs a first frame to film characters. Make one or upload one.'`
  - `klingElementsProblem(adv, hasFirstFrame): string | null`

- [ ] **Step 1: Write failing tests:**

```ts
import { klingV3Fal, klingElementsProblem, KLING_ELEMENTS_NEED_FRAME } from '../../server/runner/generators/twins'

const el = { frontal_image_url: 'https://f/face.png', reference_image_urls: ['https://f/p.png', 'https://f/bf.png'] }
it('Kling 3: elements ride along with the start frame on image-to-video', () => {
  const call = klingV3Fal({ prompt: '@Element1 waves', aspectRatio: '16:9', duration: 5, seed: 0, image: 'https://f/start.png', adv: { elements: [el] } })
  expect(call.endpoint).toBe('fal-ai/kling-video/v3/pro/image-to-video')
  expect(call.payload.elements).toEqual([el])
  expect(call.payload.start_image_url).toBe('https://f/start.png')
})
it('refuses elements without a start frame, and more than 3 extra pictures', () => {
  expect(klingElementsProblem({ elements: [el] }, false)).toBe(KLING_ELEMENTS_NEED_FRAME)
  expect(() => klingV3Fal({ prompt: 'x', aspectRatio: '16:9', duration: 5, seed: 0, image: null, adv: { elements: [el] } })).toThrow(KLING_ELEMENTS_NEED_FRAME)
  expect(klingElementsProblem({ elements: [{ frontal_image_url: 'a', reference_image_urls: ['1', '2', '3', '4'] }] }, true)).toMatch(/at most 3/)
  expect(klingElementsProblem({}, false)).toBeNull()
})
it('no elements: payload unchanged from today', () => {
  const call = klingV3Fal({ prompt: 'x', aspectRatio: '16:9', duration: 5, seed: 0, image: 'https://f/s.png', adv: {} })
  expect(call.payload).not.toHaveProperty('elements')
})
```

  Also add a schema-fit case: an elements payload passes `expectFits('fal', 'fal-ai/kling-video/v3/pro/image-to-video', payload)`.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.** In `klingV3Fal`:
  - Throw `klingElementsProblem(adv, !!image)` when it is non-null.
  - Copy `elements` onto the payload when it is a non-empty array. Keep only `frontal_image_url` and `reference_image_urls` per element.

  `klingElementsProblem` returns:
  - the "needs a first frame" words when elements come without a frame;
  - `'Kling 3 takes a face and at most 3 more pictures per character.'` when any element has more than 3 `reference_image_urls` or no `frontal_image_url`;
  - `null` otherwise.

  In `executors.ts`, in the `FAL_FIRST_VIDEO` branch, omit the `backup` when `call.payload.elements` is a non-empty array. The Replicate Kling can't take elements, so a fall-over would silently drop the character. Add a one-line comment saying so, plus a test that plans a GenerateVideoNode `kling-v3` with elements and a linked image and asserts there is no `backup`. Follow the existing executor tests (grep `planNodeRequest` in tests).

- [ ] **Step 4: Run** runner-replicate-video, runner-provider-schemas and the executor test file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(runner): Kling 3 on fal takes characters as elements with a start frame`.

---

### Task 4: Runner takes a shot-directed "Film a shot"

**Files:**
- Modify: `frontend/shared/runner/eligibility.ts` (`runnerTakesNode` ~L1166)
- Modify: `frontend/server/runner/executors.ts` (add `case 'FilmShotNode'` next to `case 'GenerateVideoNode'` ~L468; extract the shared video planning)
- Create: `frontend/server/runner/shotRefs.ts` (resolves `/view` refs in `model_options`, lists their filenames)
- Modify: `frontend/server/runner/engine.ts` (~L1514-1536, the ownership checks before a run)
- Modify: `frontend/server/runner/requestRules.ts` (FilmShotNode block ~L776-788: refuse elements on the ComfyUI path)
- Modify: `frontend/server/utils/engineFileSurface.ts` (the `video-refs` reader also lists `elements[].frontal_image_url` and `reference_image_urls[]`)
- Test: create `frontend/tests/unit/runner-film-shot.unit.spec.ts`; extend the eligibility test file (grep `runnerTakesNode` in tests)

**Interfaces:**
- Consumes: `readViewRef` (`shared/pricing/clipSettings.ts`), `ctx.toUrl(OutputFile)`, the builders from Tasks 2–3.
- Produces:
  - `isShotDirected(inputs): boolean`, exported from `eligibility.ts`
  - `shotRefFilenames(adv): string[]`
  - `resolveShotRefs(adv, toUrl): Promise<{ adv: Record<string, unknown>; firstFrame: string | null }>`

**Rules:**
- The runner takes a `FilmShotNode` only when all of these hold:
  - `model_options` is not a link, and its JSON has `__shot_directed === true`;
  - `audio` is not linked;
  - the model is one of `seedance-2.0`, `veo-3.1` or `veo-3.1-fast` (no family needed, as for Generate a video), **or** `kling-v3` with the `replicate-video` family on (the same switch as Generate a video's Kling).

  Any other Film a shot stays on ComfyUI, exactly as today (presets, overrides).
- **Resolving links.** Every `/view?…&type=input` string in `image_url`, `end_image_url`, `image_urls[]`, `video_urls[]`, `audio_urls[]` and `elements[].frontal_image_url` / `elements[].reference_image_urls[]` becomes `await toUrl({ filename, subfolder: '', type: 'input' })`. `http(s)` links pass unchanged. A refused `/view` link (`readViewRef(...).refused`) throws that refusal's words. Anything else throws `'A reference picture could not be read.'`.
- **The first frame.** A linked `image` wins. Otherwise the resolved `adv.image_url` becomes the build's `image`, and `image_url` is removed from `adv`. `__shot_directed` is removed before building.
- **Planning.** Plan exactly like Generate a video from there (the same model tables, backups and Seedance/Veo/Kling checks). Extract the body of `case 'GenerateVideoNode'` into `async function planVideoGeneration(inputs, first: string | null)`. Both cases call it, and Generate a video's own behaviour must stay unchanged (its tests prove that).
- **`uiFor`.** Film a shot shows its video **on itself**, as it does on ComfyUI, so Shot Director takes appear on the node. Return the same `ui` shape the runner's Video card case returns for a video file (grep `case 'Video'` in executors.ts), not `() => null`.
- **Ownership** (hosted). In `engine.ts`, where `assertFilesOwned(collectInputFiles(p))` runs, also assert ownership of `shotRefFilenames(parseJsonObject(inputs.model_options))` for every runner-taken FilmShotNode. The GenerateVideoNode path doesn't resolve `/view` refs, so it isn't affected.
- **The ComfyUI path.** In `requestRules.ts`'s FilmShotNode block, when `model_options.elements` is non-empty, push `{ input: 'model_options', message: 'Kling 3 films characters only through Sailor\'s runner, which is off for Kling here. Pick Seedance or Veo, or switch Kling on.' }`. This covers the case where Kling's family is off and the node falls through to ComfyUI, where Python would drop the elements. Check that this block runs only on the ComfyUI path (its comment says so). If it doesn't, add the condition.

- [ ] **Step 1: Write failing tests** in `runner-film-shot.unit.spec.ts`:
  - `runnerTakesNode` takes a shot-directed `seedance-2.0` Film a shot and a shot-directed `veo-3.1` one.
  - It does not take one without `__shot_directed`, nor one whose `model_options` is a link.
  - A `kling-v3` one is taken only with the `replicate-video` family.
  - `resolveShotRefs` turns `/view?filename=a.png&type=input` into the stubbed `toUrl` result (for example `https://fal/a.png`) in every key listed above, including `elements`. It moves `image_url` to `firstFrame`, passes `https://x/y.png` through, and throws the refusal words for `/view?filename=../x&type=input`.
  - `shotRefFilenames` lists every `/view` filename once, including the ones inside `elements`.
  - Planning a shot-directed Veo Film a shot with 2 `/view` pictures gives endpoint `fal-ai/veo3.1/reference-to-video` and resolved `image_urls`, with no `__shot_directed` in the payload. Build the node the way the existing executor tests build a GenerateVideoNode.
  - Planning a shot-directed Seedance Film a shot gives the same payload as the equivalent Generate a video with the same resolved links.
  - The plan's `uiFor` for a video file returns a non-null ui.
  - requestRules: a Film a shot with `elements` on the ComfyUI path yields the Kling words.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement** `shotRefs.ts`:

```ts
import { readViewRef } from '#shared/pricing/clipSettings'
import type { OutputFile } from './types'

const STR_KEYS = ['image_url', 'end_image_url'] as const
const LIST_KEYS = ['image_urls', 'video_urls', 'audio_urls'] as const

async function one(v: unknown, toUrl: (f: OutputFile) => Promise<string>): Promise<string> {
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  const r = readViewRef(v)
  if (r?.refused) throw new Error(r.refused)
  if (!r?.name) throw new Error('A reference picture could not be read.')
  return toUrl({ filename: r.name, subfolder: '', type: 'input' })
}

export function shotRefFilenames(adv: Record<string, unknown>): string[] {
  const out = new Set<string>()
  const take = (v: unknown) => { const n = readViewRef(v)?.name; if (n) out.add(n) }
  for (const k of STR_KEYS) take(adv[k])
  for (const k of LIST_KEYS) if (Array.isArray(adv[k])) (adv[k] as unknown[]).forEach(take)
  if (Array.isArray(adv.elements)) for (const e of adv.elements as Record<string, unknown>[]) {
    take(e?.frontal_image_url)
    if (Array.isArray(e?.reference_image_urls)) (e.reference_image_urls as unknown[]).forEach(take)
  }
  return [...out]
}

export async function resolveShotRefs(adv: Record<string, unknown>, toUrl: (f: OutputFile) => Promise<string>): Promise<{ adv: Record<string, unknown>; firstFrame: string | null }> {
  const next: Record<string, unknown> = { ...adv }
  delete next.__shot_directed
  for (const k of STR_KEYS) if (next[k] != null && next[k] !== '') next[k] = await one(next[k], toUrl)
  for (const k of LIST_KEYS) if (Array.isArray(next[k])) next[k] = await Promise.all((next[k] as unknown[]).map(v => one(v, toUrl)))
  if (Array.isArray(next.elements)) next.elements = await Promise.all((next.elements as Record<string, unknown>[]).map(async e => ({
    frontal_image_url: await one(e?.frontal_image_url, toUrl),
    reference_image_urls: await Promise.all(((e?.reference_image_urls as unknown[]) ?? []).map(v => one(v, toUrl))),
  })))
  const firstFrame = typeof next.image_url === 'string' ? next.image_url : null
  delete next.image_url
  return { adv: next, firstFrame }
}
```

  Then change eligibility, executors, engine, requestRules and engineFileSurface as described under Rules. `isShotDirected(inputs)` parses `inputs.model_options` safely: not a link, and valid JSON with `__shot_directed === true`.

- [ ] **Step 4: Run** runner-film-shot, the eligibility test file, runner-video-models, runner-replicate-video, veo-31-one-picture, runner-provider-schemas and the engine ownership tests (grep `assertFilesOwned` in tests). Expected: PASS.

- [ ] **Step 5: Commit** `feat(runner): the runner films Shot Director shots (Seedance, Veo, Kling) and resolves their reference links`.

---

### Task 5: Shot Director profiles for Kling 3 and Veo 3.1

**Files:**
- Modify: `frontend/app/lib/shotdirector/profiles.ts`
- Test: `frontend/tests/unit/shotdirector-profiles.unit.spec.ts`

**Interfaces:**
- Consumes: `IdentityRefSet` (Task 1).
- Produces new `ModelProfile` fields (every profile sets them):
  - `castMode: 'images' | 'elements'`
  - `castRefCap: number` (pictures per character)
  - `pickCastRefs(set: IdentityRefSet): string[]` (ordered, no nulls, no duplicates; `images` mode only)
  - `supportsLastFrame: boolean`
  - `requiresFirstFrame: boolean`
  - `refsWithFirstFrame: boolean`
- `buildInput(sheet, prompt, cast?: CastBundle[])`, where `CastBundle = { slug: string; front: string; refs: string[] }` (used by `elements` mode)
- The new profiles are `KLING_V3_PROFILE` (`'kling-v3'`), `VEO_31_PROFILE` (`'veo-3.1'`) and `VEO_31_FAST_PROFILE` (`'veo-3.1-fast'`), all in `SHOT_PROFILES_BY_ID`.
- `SHOT_MODEL_CHOICES: { id: string; label: string }[] = [Seedance 2.0, Kling 3, Veo 3.1, Veo 3.1 Fast]`. This leaves out `stub-basic`.

**Profile values:**

| id | castMode | castRefCap | pickCastRefs | maxRefImages | supportsFirstLastFrame | supportsLastFrame | requiresFirstFrame | refsWithFirstFrame | refTag |
|---|---|---|---|---|---|---|---|---|---|
| seedance-2.0 | images | 2 | `[portrait ?? front, bodyFront]` | 9 (unchanged) | true | true | false | false | `atTag` (unchanged) |
| kling-v3 | elements | 4 (face + 3) | — | 0 (no loose pictures) | true | true | **true** | true | `(_k, slot) => '@Element' + slot` |
| veo-3.1 / veo-3.1-fast | images | 3 | `[front, portrait, bodyFront]` | 3 | true | **false** | false | false | `(_k, slot) => 'image ' + slot` |

Word budgets:
- Kling: warn 400, hard 2500 (the schema's prompt maxLength).
- Veo: warn 150, hard 1000.
- Seedance: unchanged.

Video and audio references are 0 on Kling and Veo. Durations are Kling 3–15 s and Veo 8 s only.

What `buildInput` produces:

- **Kling**, where `firstFrame` is required:
  ```
  { prompt, duration, generate_audio, image_url: sheet.firstFrame,
    ...(sheet.lastFrame ? { end_image_url } : {}),
    ...(cast?.length ? { elements: cast.map(c => ({ frontal_image_url: c.front, reference_image_urls: c.refs })) } : {}) }
  ```
  The runner (Task 4) turns `image_url` into the start frame.
- **Veo in reference mode:** `{ prompt, aspect_ratio, image_urls, resolution, generate_audio }`. `image_urls` holds the sheet's image references in slot order.
- **Veo with a first frame:** `{ prompt, image_url: sheet.firstFrame, resolution, generate_audio }`.

Use the same keys the Seedance `buildInput` uses for the shared fields.

- [ ] **Step 1: Write failing tests.** Cover:
  - each profile's table values;
  - `pickCastRefs` on a full set and on a set with only `front`;
  - Kling `buildInput` with two `CastBundle`s giving two elements in order;
  - Veo `buildInput` in both modes;
  - `refTag` outputs (`@Element2`, `image 3`);
  - `getProfile('kling-v3')` returning Kling;
  - `SHOT_MODEL_CHOICES` labels.

  Every existing Seedance assertion must still pass unchanged.

- [ ] **Step 2: Run the tests and confirm they fail.** Then implement, and run shotdirector-profiles, shotdirector-compile and shotdirector-cast. Expected: PASS.

- [ ] **Step 3: Commit** `feat(shot-director): Kling 3 and Veo 3.1 profiles`.

---

### Task 6: Cast, compile, rules, dispatch and price follow the profile

**Files:**
- Modify: `frontend/app/lib/shotdirector/cast.ts`, `compile.ts`, `rules.ts`, `dispatch.ts`, `price.ts`
- Test: `frontend/tests/unit/shotdirector-cast.unit.spec.ts`, `-cast-edges`, `-compile`, `-rules`, `-dispatch`, `-price`

**Interfaces:**
- Consumes: Task 5's profile fields and `IdentityRefSet` values holding `/view` URLs (Task 1 `resolveCastSets`).
- Produces:
  - `materializeCast(sheet, resolved: Record<string, IdentityRefSet>, profile): { sheet, issues, bundles: CastBundle[] }`
  - `compileShot(sheet, profile, opts?: { castDescriptors?, castBundles?: CastBundle[] })`
  - `buildFilmShotPatch(sheet, result, profile)`, where the model is `profile.id`
  - `estimateShotUSD(sheet, modelId = 'seedance-2.0')`

**Behaviour:**
- **`images` mode:** exactly today's behaviour, except a member's refs are `profile.pickCastRefs(set).slice(0, profile.castRefCap)` instead of `CAST_REF_CAP`. Keep `CAST_REF_CAP` exported as Seedance's 2 for existing importers. `bundles` is `[]`.
- **`elements` mode:** cast refs are **not** added to `sheet.references`. Each member with a `front` becomes a bundle `{ slug, front, refs: [portrait, bodyFront, bodyBack].filter(Boolean).filter(r => r !== front).slice(0, profile.castRefCap - 1) }`, in cast order. A member with no front raises the existing `cast-member-no-refs` issue.
- **`castClause`:** in `elements` mode, member `i` (1-based, in bundle order) is tagged `@Element{i}`, giving for example `"Characters: Reva (desc) @Element1; Marcus @Element2."`. In `images` mode it is unchanged, including " (the same person)".
- **`compileShot`:** passes `opts.castBundles` to `profile.buildInput`.
- **`rules.ts`** adds these issues, plain words, `severity: 'error'`:
  - `profile.requiresFirstFrame && !sheet.firstFrame` → `'Kling 3 needs a first frame. Make one from the cast or upload one.'` (build the model name from `profile.label`)
  - `sheet.lastFrame && !profile.supportsLastFrame` → `'<label> can't use a last frame.'`
  - `sheet.firstFrame && !profile.refsWithFirstFrame && (image references or cast in images mode)` → `'<label> uses either the first frame or reference pictures, not both. Characters are left out while a first frame is set.'` This one is a **warning**, not an error: the cast then isn't sent, which is today's Seedance behaviour, made visible.

  Follow the file's existing issue shape and code naming.
- **Kling mode:** the sheet's `mode` must be `firstLastFrame`. When `profile.requiresFirstFrame`, `compileShot` treats the sheet as `firstLastFrame` for `buildInput`, but doesn't change the stored sheet.
- **`price.ts`:** `estimateShotUSD(sheet, modelId)` returns `videoPriceUsd(modelId, { seconds, resolution, audio, … })` (`shared/pricing/videoRates.ts`, `VideoSettings` in `shared/pricing/videoSettings.ts`), with `seconds` as in dispatch (≤0 → the profile's default: Seedance 5, Kling 5, Veo 8). If it returns null, fall back to today's Seedance table. `formatShotUSD(sheet, modelId)` follows.

- [ ] **Step 1: Write failing tests** for:
  - elements-mode materialize: bundles and no references added;
  - the Kling clause text;
  - images mode with Veo (3 per member, squeezed issue at 2 members);
  - the three new rules;
  - the dispatch model id from the profile;
  - Veo price 8 s at 720p with audio equalling `videoPriceUsd('veo-3.1', …)`.

  Existing Seedance tests stay green unchanged.

- [ ] **Step 2: Run the tests and confirm they fail.** Then implement, and run all `shotdirector-*` specs. Expected: PASS.

- [ ] **Step 3: Commit** `feat(shot-director): cast, rules, dispatch and price follow the chosen model`.

---

### Task 7: The model on the sheet, and the picker

**Files:**
- Modify: `frontend/app/lib/shotdirector/types.ts` (`ShotSheet.model?: string`) and the sheet hydrate (grep `hydrate` in `lib/shotdirector`; default `'seedance-2.0'`, unknown ids → `'seedance-2.0'`)
- Modify: `frontend/app/composables/useShotDirector.ts:41`, `frontend/app/components/vue-canvas/ShotDirectorNode.vue:24`, `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (~L4023-4066, `handleShotDirectorGenerate`)
- Modify: `frontend/app/components/vue-canvas/ShotDirectorSurface.vue` (the model picker; cast refs through `resolveCastSets`)
- Test: `shotdirector-hydrate`, `shotdirector-composable`, and a new dispatch-flow test if `handleShotDirectorGenerate`'s logic can be extracted (see below)

**Behaviour:**
- Every `getProfile('seedance-2.0')` becomes `getProfile(sheet.model ?? 'seedance-2.0')`.
- In `handleShotDirectorGenerate`:
  - resolved cast = `resolveCastSets(picks)`;
  - `const { sheet, issues, bundles } = materializeCast(...)`;
  - `compileShot(effectiveSheet, profile, { castDescriptors, castBundles: bundles })`;
  - `buildFilmShotPatch(sheet, result, profile)`.

  If that handler holds real logic, move it into a pure function in `lib/shotdirector/` (for example `prepareShotDispatch`) and unit-test it. Leave only the store and node calls in the component.
- **The picker.** A "Model" select at the top of the Shot Director's format section, options from `SHOT_MODEL_CHOICES` with sentence-case labels.
  - Changing it writes `sheet.model`.
  - When the new profile `requiresFirstFrame`, it also sets `mode: 'firstLastFrame'`.
  - Durations the model can't do are clamped to its nearest allowed value (Veo → 8).
  - The price label uses `formatShotUSD(sheet, sheet.model)`.
  - Follow the surface's existing select component and styles.
  - No helper text under it. A tooltip on the label may say what the model is good at, in one short line.

- [ ] **Step 1: Write failing tests** for hydrate (the default and unknown-id cases) and the extracted dispatch function (Kling sheet → `model_options.elements` with `/view` fronts, `model: 'kling-v3'`, `image_url` = first frame).
- [ ] **Step 2: Implement; run the `shotdirector-*` specs.** Then type-check the touched files.
- [ ] **Step 3: Commit** `feat(shot-director): pick the video model per shot`.

---

### Task 8: Make the first frame from the cast

**Files:**
- Modify: `frontend/app/lib/shotdirector/keyframe.ts`
- Modify: `frontend/app/components/vue-canvas/ShotDirectorSurface.vue` (`generatePreview` ~L231, `previewFrame`)
- Test: `frontend/tests/unit/shotdirector-keyframe.unit.spec.ts`

**Interfaces:**
- Produces:
  - `startFrameImages(cast: { name: string; set: IdentityRefSet; clothes: string[] }[], location: string | null): { urls: string[]; castLine: string }` (pure)
  - `buildKeyframePrompt(sheet, refs: { hasPerson; hasLocation; castLine?: string })`

**Behaviour:**
- For each cast member (at most 3), in order:
  - `front`;
  - `bodyFront` if present;
  - that look's clothes photos (`state.clothes[].filename` as `/view` URLs, at most 2).
- The location image comes last.
- `castLine` names the image numbers, for example `"Reva is the person in images 1–2, wearing the clothes in image 3. Marcus is the person in images 4–5."` Use "image N" for a single image and an en dash for ranges.
- `buildKeyframePrompt` appends `castLine` when it is given. Its existing output without `castLine` is unchanged (the existing tests prove it).
- **The preview.** `generatePreview` sends these images in place of `subjectImage` whenever the sheet has a cast. Without a cast it behaves as today. The price label stays `KEYFRAME_COST_USD`.
- **The first-frame button.** Under the preview, a button **Use as first frame**:
  1. converts `previewFrame` (a data URL) to a `File` named `first-frame.png`;
  2. calls `uploadRefFile(file)`;
  3. sets `firstFrame` to the returned `/view` URL, and `mode: 'firstLastFrame'`.

  One undo step if the surface has undo; otherwise a single `update`.

- [ ] **Step 1: Write failing tests** for `startFrameImages` (numbering with 1 and 2 members, clothes, location last, cap of 3 members) and the `castLine` appended to the prompt.
- [ ] **Step 2: Implement; run shotdirector-keyframe and shotdirector-composable.**
- [ ] **Step 3: Commit** `feat(shot-director): make the first frame from the cast's pictures`.

---

### Task 9: Face scores for a take (server)

**Files:**
- Create: `frontend/server/utils/faceCheck/take.ts` (pure scoring over injected compare)
- Create: `frontend/server/api/characters-local/take-check.post.ts`
- Test: `frontend/tests/unit/face-check-take.unit.spec.ts`

**Interfaces:**
- Consumes:
  - `faceFor(record, stateId)` (`plan.ts`);
  - `verdictFor(score)`;
  - `compareFaces` / `prepareForCompare` / `rekognitionClient` / `FaceCheckError` (`rekognition.ts`);
  - `judgeSameCharacter` (`vision.ts`);
  - `meterAssist`, `assertRateLimit`, `guardMutation`, `parseCharacterRecord`, used as in `check.post.ts`.
- Produces:
  - `scoreTake(frames: Buffer[], face: Buffer, compare: (s: Buffer, t: Buffer) => Promise<number | null>): Promise<{ scores: (number | null)[]; best: number | null; verdict: CheckVerdict }>`
  - `POST /api/characters-local/take-check` with body `{ slug: string; stateId: string | null; frames: string[] /* JPEG data URLs, ≤ 3, each ≤ 2 MB */ }`, returning `{ slug, name, scores, best, verdict }`
  - `TakeFaceScore = { slug: string; name: string; best: number | null; verdict: CheckVerdict }`, exported from `shared/characters/types.ts`

**Behaviour:**
- **`scoreTake`:**
  - It compares the face (source) with each frame (target).
  - `FaceCheckError('no-face-either')` for a frame scores `null` for that frame. The face itself was checked when it was approved.
  - `best` is the highest non-null score.
  - `verdict` is `verdictFor(best)`, or `'no-face'` when every score is null.
  - Any other error rethrows.
- **The route** reuses `check.post.ts`'s guards in the same order:
  - rate limit (`'character-take-check'`, 20);
  - slug validation;
  - the record read (404);
  - `guardMutation`, then the hosted likeness 403;
  - hosted Photo → 501 with the same words as `check.post.ts`;
  - Anime → `meterAssist` per compare + `judgeSameCharacter`, with images unpadded;
  - Photo locally → AWS.
- It validates `frames`: 1–3 strings starting `data:image/jpeg;base64,`, each decoded size ≤ 2 MB. Otherwise it answers 400 `'Send one to three pictures from the take.'`.
- It never writes the record.
- No face (`faceFor` null) → 409 `'This character has no approved face yet.'`

- [ ] **Step 1: Write failing tests** for `scoreTake`:
  - scores [96, null, 91] → best 96, match;
  - all null → no-face;
  - 70 → unsure (with `FACE_THRESHOLDS` 90/65);
  - an `aws` error rethrows.

  Then write a route test in the style of the existing route tests, if any exist (grep `characters-local` in tests); otherwise test only the pure validator `readTakeFrames(body): Buffer[] | string` as its own export.
- [ ] **Step 2: Implement; run face-check-take plus the other face-check specs.**
- [ ] **Step 3: Commit** `feat(characters): score a video take's frames against the characters' faces`.

---

### Task 10: Face scores on every Shot Director take (client)

**Files:**
- Create: `frontend/app/lib/shotdirector/takeFrames.ts` (browser: decode 3 frames with mediabunny)
- Create: `frontend/app/lib/shotdirector/takeScores.ts` (pure: which cast to score, how to store it)
- Modify: `frontend/app/composables/useTakes.ts` (`Take.faceScores?: TakeFaceScore[]`)
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue` (the `'executed'` take append, ~L3343-3398)
- Modify: `frontend/app/components/vue-canvas/ShotDirectorSurface.vue` (show the latest take's scores)
- Test: `frontend/tests/unit/shotdirector-take-scores.unit.spec.ts`

**Behaviour:**
- **`sampleTakeFrames(videoUrl): Promise<string[]>`**
  - It fetches the video as a Blob and opens it with mediabunny (`Input`, `BlobSource`, `ALL_FORMATS`, `CanvasSink`, as in `app/pages/dev/video-export-harness.vue`).
  - It reads frames at 25%, 50% and 75% of the duration using `CanvasSink.getCanvas(timestamp)`, which is mediabunny's random-access read. Check the installed mediabunny's typings for the exact method.
  - It draws each frame scaled to at most 1024 px on the long side and returns JPEG data URLs at quality 0.85.
  - It is imported with `import()` only when needed (dynamic import, like the harness).
- **`castToScore(studioData)`** (pure) takes the Shot Director studio's sheet cast and returns `{ slug, stateId }[]`.
- **`withFaceScores(data, takeId, scores)`** (pure) returns node data with that take's `faceScores` set and leaves the other takes alone.
- **Wiring.** Where an `'executed'` event appends a take:
  - If the executed node is the stored `sailor_shotDirectorTargetId` of some Shot Director studio, and the new take has a video, and that studio's cast is non-empty, then in the background (never awaited by the append):
    1. sample the frames;
    2. POST `take-check` per cast member;
    3. write the results onto that take with `withFaceScores`.
  - Failures are logged with `console.warn` and leave no scores. A 501 (hosted Photo) is silent.
  - Score each take once: skip a take that already has `faceScores`.
- **Display.** In `ShotDirectorSurface.vue`, beside the take controls, the latest take's scores appear as small chips: `Reva 96`, amber when `unsure` or `different` (`Reva 58`), and `Reva: no face` for `no-face`. There is no extra text. A tooltip gives the verdict in words ("Looks like Reva", "May not be Reva", "Doesn't look like Reva", "No face found").

- [ ] **Step 1: Write failing tests** for `castToScore`, `withFaceScores` (only the named take changes, and a take with scores is not re-scored), and the chip label and tone function (make it pure: `faceScoreChip(score: TakeFaceScore): { text: string; tone: 'plain' | 'amber'; tip: string }`).
- [ ] **Step 2: Implement; run the new spec and shotdirector-composable.** Type-check.
- [ ] **Step 3: Commit** `feat(shot-director): every take is scored against the cast's faces`.

---

### Task 11: End-to-end with mocked services

**Files:**
- Create: `frontend/tests/shot-director-models.spec.ts` (Playwright), following `frontend/tests/character-sheet.spec.ts` for setup, routes and fixtures

**Scenario, with every provider route mocked (no paid calls):**
1. Open the app on the existing `:3002` server. Seed a character with portrait, face-neutral and body-front panels, as `character-sheet.spec.ts` does.
2. Add a Shot Director, cast the character, and pick **Kling 3**. Expect the "needs a first frame" issue.
3. Mock `/api/inpaint/nano-gen` to return a small PNG data URL. Make the preview, then press **Use as first frame**. The issue clears.
4. Intercept `POST /api/runs`, press Generate, and capture the body. Assert:
   - the Film a shot node's `model` is `kling-v3`;
   - `model_options.elements[0].frontal_image_url` is a `/view` URL of the face-neutral panel;
   - `image_url` is the uploaded first frame;
   - no sheet grid filename appears anywhere in the body.
5. Switch to **Veo 3.1** and clear the first frame. Generate again and assert `model_options.image_urls` has 3 `/view` URLs, with no grid.

If the runner is switched off on `:3002`, the run goes to `/prompt` instead. Intercept both and assert on whichever is called. Mocking and asserting on either route is enough for this task.

- [ ] **Step 1: Write the spec.** Run it: `cd frontend && npx playwright test tests/shot-director-models.spec.ts --reporter=line`. If `:3002` is down or answering 500, report BLOCKED with the log line. Don't start a server.
- [ ] **Step 2: Also run `tests/character-sheet.spec.ts` Scenario A** (owed from stage 0) and report its result.
- [ ] **Step 3: Commit** `test(shot-director): per-model cast payloads end to end`.

---

### Task 12: One paid live check per new path, then record the state (needs the user)

**Stop and ask the user before any paid step.** Quote these costs:
- Kling 3 Pro, 5 s, with a character element and a start frame: about $0.84 with audio (check `videoPriceUsd('kling-v3', …)`).
- Veo 3.1 Fast with 3 reference pictures, 8 s at 720p with audio: about $1.20.
- The start frame from Nano Banana Pro: about $0.15.
- AWS take checks: under $0.01.

- [ ] **Step 1:** With the user's go-ahead:
  1. In the real app, film Reva once on Kling 3 (with a first frame made in Shot Director) and once on Veo 3.1 Fast (reference mode).
  2. Confirm each take lands on the Film a shot node with face scores.
  3. Report the fal request ids, the scores, and a frame of each take.
  4. A fal 422 means a schema mismatch. Fix the builder, re-check it against the fixture, and retry once.
- [ ] **Step 2:** Update `docs/STATE.md` (a "Characters stage 3 — LANDED" entry above the stages 0–2 entry) and the build dashboard (the characters programme row, landed line, owed, debt), then commit `docs(state): characters stage 3 landed`.
