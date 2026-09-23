# Frame Web Export — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Web export" button in the Frame editor that downloads one self-contained HTML file playing the Frame live — every layer kind, motion, letter behaviours, transitions, shader fills and image clips — with wired studio layers held as stills (nesting is stage 2).

**Architecture:** The Frame's own painter (`paintLayerStack`) ships unchanged inside a new `frame` embed bundle. A pure planner walks the Frame and lists every asset it touches; a gatherer inlines them into a `FrameSnapshot` (plain JSON). At mount, the adapter registers an **asset resolver** that the painter's five URL builders consult, so every image, clip frame, fill image, shader texture and outline font resolves to an inlined data URL — in the exported file *and* in the app while the poster is baked. The two places that contain network code the file must not carry (the depth-estimate request and the Google Fonts URL table) are removed from the embed build only.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Canvas2D + WebGL2, Vite lib-mode IIFE (`vite.embed.config.ts`), Vitest (`tests/unit/**/*.unit.spec.ts`), Playwright (`tests/*.spec.ts`, against the running dev server on `:3002`).

**Spec:** `docs/superpowers/specs/2026-09-21-frame-web-export-design.md` — read its plain-language summary, "User experience" and "Testing" sections before starting. Also read `docs/superpowers/HANDOFF-video-export-and-frame-embed.md`.

## Global Constraints

- **Main checkout only.** No worktree, no branch (`CLAUDE.md`). Several sessions share this checkout.
- **Never start a dev server.** Never run `npm run dev`. E2E tasks need the shared server on `:3002`: check `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/` returns `200` first; if not, stop and report — do not start one.
- **Commits use a private index, every time, in ONE Bash call** (the shared index is hostile):
  ```bash
  cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE="$(mktemp -d)/idx" && git read-tree HEAD && git add -- <exact paths> && git diff --cached --name-status && git commit -q -F <msgfile> && unset GIT_INDEX_FILE && git reset -q -- <the same exact paths>
  ```
  Never `cp .git/index`. Never `git stash`. Never `git add -A` / `git commit -a`. Confirm `git diff --cached --name-status` lists only your paths before committing. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Every existing Frame and every existing export stays byte-identical.** Each new seam defaults to today's behaviour when nothing opts in. Existing embed suites (`tests/unit/embed-*.unit.spec.ts`, `tests/embed-*.spec.ts`) must stay green.
- **Nothing reachable from `app/lib/embed/entry-frame.ts` may import Vue, Nuxt (`#imports`, composables that use Vue), or issue a network request.** Enforced by `externalRefs()` on every export and by the cone guard test (Task 6).
- **Do not move, rename or change `renderCompositeAtTime(t)`** in `ArtifactFrameNode.vue` — the browser video export depends on it (handoff note).
- **`FrameFit` is `'fit' | 'fill'`** and must stay a union a third value (`'adapt'`, owned by the responsive-Frames work) can join without a format change.
- **UI copy:** sentence case, plain words, no internal identifiers, no terminal punctuation on labels (memory rule `ui-copy-sentence-case-no-identifiers`).
- **Typecheck baseline:** before your first edit, record `cd frontend && npx nuxi typecheck 2>&1 | grep -c 'error TS'`. After your task it must not be higher.
- **Run only the specs a task names** — the full unit suite is slow and its counts are unreliable while other sessions run.

## Where this plan departs from the spec (found by reading the code; the spec is amended in Task 11)

1. **Supply lines are swapped at runtime, not by build alias.** The poster is baked inside the app by mounting the adapter with the app's own modules (`app/lib/embed/export.ts` `bakePoster`), where a build alias never applies — the poster would come from the original images and the live file from the re-encoded ones. And two embeds can sit on one page. So the five URL builders consult a registered resolver chain (`lib/compositor/assetScope.ts`). Build-time replacement is kept only for code that must not be *present* in the file: the depth request and the Google Fonts URL table.
2. **Fit-and-bleed needs no painter change.** The adapter paints the background once across the whole box (one `paintLayerStack` call with no layers), then the layers under a scale-and-offset (a second call with no background). Post effects already operate on the whole device canvas (`applyStackPost`).
3. **The keyed bundle registry moves to stage 2.** Only nesting needs several bundles in one file.
4. **The two-bundle split is gated on measurement** (Task 10): built only if the single bundle is large enough to justify it.
5. **No shared stack-builder extraction.** The adapter only needs local layers (`l:` keys); the modal's and card's builders also carry legacy `w:` wiring. A Frame still holding a `w:` key is refused with a notice (the modal migrates on open, so this should never appear).
6. **The embed build cache misses nine folders the Frame bundle depends on** (`app/composables`, `lib/frame`, `lib/motion`, `lib/motionx`, `lib/paint`, `lib/scene3d`, `lib/shapes`, `lib/vary`, `lib/vectortype`). Task 6 adds them and a guard test.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/compositor/assetScope.ts` (new) | Resolver chain: `registerAssetResolver`, `resolveAssetUrl` |
| `frontend/app/lib/compositor/depthRequest.ts` (new) | The one network call behind depth maps |
| `frontend/app/lib/embed/frame/types.ts` (new) | `FrameSnapshot` and friends, `assetKey` |
| `frontend/app/lib/embed/frame/plan.ts` (new) | Pure: what a Frame needs and what the sheet will say |
| `frontend/app/lib/embed/frame/gather.ts` (new) | Async: turns a plan into a snapshot through an injected IO |
| `frontend/app/lib/embed/frame/appIO.ts` (new) | The app's real IO (fetch, canvas encode, font sources) |
| `frontend/app/lib/embed/frame/fit.ts` (new) | Pure fit / fill rectangle maths |
| `frontend/app/lib/embed/frame/depthRequest.embed.ts` (new) | Embed-build stand-in: depth estimation unavailable |
| `frontend/app/lib/embed/fontBytes.ts` (new) | Base64 + font subsetting helpers (moved out of Space Type) |
| `frontend/app/lib/embed/snippet.ts` (new) | The "Copy embed code" iframe snippet |
| `frontend/app/lib/embed/surfaces/frame.ts` (new) | The adapter |
| `frontend/app/lib/embed/entry-frame.ts` (new) | Bundle entry |
| `frontend/scripts/embed-cone.mjs` (new) | Import-cone walker used by the guard test |
| `frontend/app/components/vue-canvas/compositor/FrameWebExportSheet.vue` (new) | The sheet |
| `frontend/app/pages/dev/frame-embed-harness.vue` (new) | Test harness page |
| `frontend/tests/frame-embed-*.spec.ts` (new) | E2E |
| Modified: `useCompositorLayers.ts` (2 small edits), `lib/compositor/clip.ts`, `lib/paint/imageFillCache.ts`, `lib/shaderfill/field.ts`, `lib/vectortype/fontToken.ts`, `lib/compositor/depthRegistry.ts`, `lib/shaderfx/catalogStore.ts`, `lib/embed/{fontFace,contract,bundle,export,surfaces}.ts`, `vite.embed.config.ts`, `scripts/build-embed.mjs`, `scripts/embed-build-cache.mjs`, `CompositorModal.vue` (footer button + glue), `SpaceTypeSurface.vue` (use `fontBytes.ts`) | |

---

### Task 1: The asset resolver seam

**Files:**
- Create: `frontend/app/lib/compositor/assetScope.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`imageLayerUrl` ~line 1148; `ensureLayerImages` ~line 1310; one import)
- Modify: `frontend/app/lib/compositor/clip.ts` (`clipFrameUrl`, end of file)
- Modify: `frontend/app/lib/paint/imageFillCache.ts` (`ensureFillBitmaps`, the `im.src = src` line)
- Modify: `frontend/app/lib/shaderfill/field.ts` (`textureAssetUrl` ~line 310 and its one caller ~line 344)
- Modify: `frontend/app/lib/vectortype/fontToken.ts` (`vtFontFileUrl` ~line 68)
- Test: `frontend/tests/unit/frame-embed-asset-scope.unit.spec.ts`

**Interfaces:**
- Produces:
  - `type FrameAssetKind = 'image' | 'clipFrame' | 'fillImage' | 'shaderTexture' | 'outlineFont'`
  - `type FrameAssetResolver = (kind: FrameAssetKind, key: string) => string | null | undefined`
  - `registerAssetResolver(r: FrameAssetResolver): () => void` (returns unregister)
  - `resolveAssetUrl(kind: FrameAssetKind, key: string, fallback: string): string`
  - `__resetAssetResolversForTest(): void`
  - `clipFrameKey(clip: ImageClip, index: number): string` → `` `${clip.dir}/${index}` `` (from `clip.ts`)
  - `shaderTextureUrl(file: string, v?: string | number): string` and `shaderTextureKey(file: string, v?: string | number): string` → `` `${file}@${v ?? ''}` `` (exported from `field.ts`)
  - `ensureLayerImages(layers: LocalLayer[], opts?: { keep?: boolean }): Promise<void>`
- Keys each kind is looked up by: `image` → the layer's `filename`; `clipFrame` → `clipFrameKey(clip, i)`; `fillImage` → the fill's `src`; `shaderTexture` → `shaderTextureKey(t.file, t.v)`; `outlineFont` → the Vector Type token string (`formatVtFontToken(ref)`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-embed-asset-scope.unit.spec.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { registerAssetResolver, resolveAssetUrl, __resetAssetResolversForTest } from '~/lib/compositor/assetScope'
import {
  imageLayerUrl, ensureLayerImages, sweepClipCache,
  __setClipFramesForTest, __clipCacheKeysForTest,
} from '~/composables/useCompositorLayers'
import { clipFrameUrl, clipFrameKey, type ImageClip } from '~/lib/compositor/clip'
import { vtFontFileUrl, parseVtFontToken } from '~/lib/vectortype/fontToken'
import { shaderTextureUrl, shaderTextureKey } from '~/lib/shaderfill/field'

const clip = (dir: string): ImageClip => ({ dir, frames: 3, fps: 24, speed: 1, prompt: '', model: '' })
const imageWithClip = (id: string, c: ImageClip) =>
  ({ kind: 'image', id, filename: `${id}.png`, w: 0.5, h: 0.5, clip: c } as any)

afterEach(() => __resetAssetResolversForTest())

describe('asset resolver chain', () => {
  it('falls back to the app URL when nothing is registered (byte-identical app)', () => {
    expect(imageLayerUrl('a b.png')).toBe('/view?filename=a+b.png&type=input')
    expect(clipFrameUrl(clip('d1'), 3)).toBe('/view?filename=000003.png&subfolder=d1&type=input')
    expect(shaderTextureUrl('atlas.png', '7')).toBe('/sailor/shader_effects/assets/atlas.png?v=7')
    expect(shaderTextureUrl('atlas.png')).toBe('/sailor/shader_effects/assets/atlas.png')
    expect(vtFontFileUrl(parseVtFontToken('google:Inter@700')!)).toBe('/api/fonts/google-file?family=Inter&weight=700')
  })

  it('a registered resolver supplies the URL for its kind and key', () => {
    registerAssetResolver((kind, key) => (kind === 'image' && key === 'a.png' ? 'data:image/png;base64,AA' : null))
    expect(imageLayerUrl('a.png')).toBe('data:image/png;base64,AA')
    expect(imageLayerUrl('b.png')).toBe('/view?filename=b.png&type=input')
  })

  it('each builder asks with its own kind and key', () => {
    const asked: string[] = []
    registerAssetResolver((kind, key) => { asked.push(`${kind}|${key}`); return null })
    clipFrameUrl(clip('d1'), 2)
    shaderTextureUrl('atlas.png', 7)
    vtFontFileUrl(parseVtFontToken('google:Inter@700')!)
    expect(asked).toEqual([
      `clipFrame|${clipFrameKey(clip('d1'), 2)}`,
      `shaderTexture|${shaderTextureKey('atlas.png', 7)}`,
      'outlineFont|google:Inter@700',
    ])
    expect(clipFrameKey(clip('d1'), 2)).toBe('d1/2')
    expect(shaderTextureKey('atlas.png', 7)).toBe('atlas.png@7')
    expect(shaderTextureKey('atlas.png')).toBe('atlas.png@')
  })

  it('the most recently registered resolver wins; a miss falls through; unregister restores', () => {
    registerAssetResolver(() => 'data:old')
    const off = registerAssetResolver((_k, key) => (key === 'x' ? 'data:new' : null))
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('data:new')
    expect(resolveAssetUrl('image', 'y', 'fb')).toBe('data:old')
    off()
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('data:old')
    __resetAssetResolversForTest()
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('fb')
  })
})

describe('ensureLayerImages keep option', () => {
  beforeEach(() => sweepClipCache([]))

  it('default call still sweeps clips the layers no longer name', async () => {
    __setClipFramesForTest(clip('other'), [1, 2, 3])
    await ensureLayerImages([imageWithClip('a', clip('a'))])
    expect(__clipCacheKeysForTest()).not.toContain('other:3')
  })

  it('keep: true never sweeps another embed\'s clip', async () => {
    __setClipFramesForTest(clip('other'), [1, 2, 3])
    await ensureLayerImages([imageWithClip('a', clip('a'))], { keep: true })
    expect(__clipCacheKeysForTest()).toContain('other:3')
  })

  it('keep: true pins its clips past the cache cap', async () => {
    const layers = ['p', 'q', 'r'].map(d => imageWithClip(d, clip(d)))
    await ensureLayerImages(layers, { keep: true })
    for (const d of ['p', 'q', 'r']) __setClipFramesForTest(clip(d), [1, 2, 3])
    expect(__clipCacheKeysForTest()).toEqual(expect.arrayContaining(['p:3', 'q:3', 'r:3']))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-asset-scope.unit.spec.ts`
Expected: FAIL — `Cannot find module '~/lib/compositor/assetScope'` (and missing exports `clipFrameKey`, `shaderTextureUrl`).

- [ ] **Step 3: Create the resolver module**

Create `frontend/app/lib/compositor/assetScope.ts`:

```ts
/**
 * Where the Frame painter's assets come from, when something other than the app wants to say.
 *
 * The painter builds five kinds of asset URL — image layers, clip frames, image fills, shader
 * textures and outline fonts — and loads them by URL into its own caches. The app's URLs point at
 * the server (`/view?…`, `/sailor/…`, `/api/…`). A Frame web export must never reach a server, so
 * its adapter registers a resolver here that answers from the snapshot's inlined data URLs.
 *
 * A CHAIN, not a single slot, and registered for the embed's whole life rather than scoped to one
 * call: clip frames resolve inside an async loader, after an await, so a synchronous scope would
 * not cover them; and two exported Frames can sit on one page. Most recent first; a resolver that
 * does not know a key returns null and the next one is asked; nothing registered ⇒ the fallback,
 * so the app is byte-identical when no export is running.
 *
 * No imports, no DOM, no network — this module travels into the embed bundle.
 */
export type FrameAssetKind = 'image' | 'clipFrame' | 'fillImage' | 'shaderTexture' | 'outlineFont'
export type FrameAssetResolver = (kind: FrameAssetKind, key: string) => string | null | undefined

const resolvers: FrameAssetResolver[] = []

export function registerAssetResolver(r: FrameAssetResolver): () => void {
  resolvers.push(r)
  return () => {
    const i = resolvers.indexOf(r)
    if (i >= 0) resolvers.splice(i, 1)
  }
}

export function resolveAssetUrl(kind: FrameAssetKind, key: string, fallback: string): string {
  for (let i = resolvers.length - 1; i >= 0; i--) {
    const hit = resolvers[i]!(kind, key)
    if (hit) return hit
  }
  return fallback
}

/** Test seam — forget every registered resolver. */
export function __resetAssetResolversForTest(): void {
  resolvers.length = 0
}
```

- [ ] **Step 4: Wire the five builders**

In `frontend/app/composables/useCompositorLayers.ts`, add beside the other `~/lib/compositor/*` imports (near line 42):

```ts
import { resolveAssetUrl } from '~/lib/compositor/assetScope'
```

Replace `imageLayerUrl` (~line 1148):

```ts
/** Resolve an image layer's filename to a ComfyUI /view URL — or, while a web export's adapter is
 *  mounted, to its inlined copy (see ~/lib/compositor/assetScope). */
export function imageLayerUrl(filename: string): string {
  return resolveAssetUrl('image', filename, `/view?${new URLSearchParams({ filename, type: 'input' })}`)
}
```

Replace the head of `ensureLayerImages` (~line 1310) — only the signature and the sweep line change:

```ts
export async function ensureLayerImages(layers: LocalLayer[], opts?: { keep?: boolean }): Promise<void> {
  // Before anything else, and before the no-DOM bail: a layer list that no longer
  // names a clip is the signal that its frames can go (see sweepClipCache).
  //
  // `keep` is for a web export's adapter: it is one of possibly several Frames on a page, so it
  // must never sweep a clip another one is showing, and its own clips must never be evicted by
  // the cap (the page has no editor that would re-request them). It pins instead of sweeping.
  if (opts?.keep) {
    for (const l of layers) if (l.kind === 'image' && l.clip) _clipLive.add(clipKey(l.clip))
  } else {
    sweepClipCache(layers)
  }
  if (typeof window === 'undefined') return
```

(the rest of the function body is unchanged).

In `frontend/app/lib/compositor/clip.ts`, add at the top below the file comment:

```ts
import { resolveAssetUrl } from './assetScope'
```

and replace `clipFrameUrl`:

```ts
/** The key a web export stores clip frame `index` under (see ~/lib/compositor/assetScope). */
export function clipFrameKey(clip: ImageClip, index: number): string {
  return `${clip.dir}/${index}`
}

/** The /view URL of one frame, same shape `imageLayerUrl` uses for stills — or its inlined copy
 *  while a web export's adapter is mounted. */
export function clipFrameUrl(clip: ImageClip, index: number): string {
  const i = Math.max(0, Math.floor(index))
  const filename = `${String(i).padStart(6, '0')}.png`
  return resolveAssetUrl('clipFrame', clipFrameKey(clip, i),
    `/view?${new URLSearchParams({ filename, subfolder: clip.dir, type: 'input' })}`)
}
```

In `frontend/app/lib/paint/imageFillCache.ts`, add `import { resolveAssetUrl } from '~/lib/compositor/assetScope'` and change the one line inside `ensureFillBitmaps`:

```ts
        im.src = resolveAssetUrl('fillImage', src, src)
```

(the cache stays keyed by the original `src`, so `getFillBitmap(src)` is unchanged).

In `frontend/app/lib/shaderfill/field.ts`, add `import { resolveAssetUrl } from '~/lib/compositor/assetScope'` and replace the private `textureAssetUrl` with two exports (keep its doc comment above them):

```ts
export function shaderTextureKey(file: string, v?: string | number): string {
  return `${file}@${v ?? ''}`
}

export function shaderTextureUrl(file: string, v?: string | number): string {
  const base = `/sailor/shader_effects/assets/${encodeURIComponent(file)}`
  const url = v != null ? `${base}?v=${encodeURIComponent(String(v))}` : base
  return resolveAssetUrl('shaderTexture', shaderTextureKey(file, v), url)
}
```

and change its caller in `ensureTextureImage` to `img.src = shaderTextureUrl(t.file, t.v)`. Confirm with `grep -n "textureAssetUrl" frontend/app/lib/shaderfill/field.ts` that no reference is left.

In `frontend/app/lib/vectortype/fontToken.ts`, add `import { resolveAssetUrl } from '~/lib/compositor/assetScope'` and replace `vtFontFileUrl`:

```ts
export function vtFontFileUrl(ref: VtFontRef): string | null {
  let url: string | null
  if (ref.kind === 'catalog') url = variableFontUrl(ref.id)
  else if (ref.kind === 'google') url = `${VT_GOOGLE_FILE_ROUTE}?family=${encodeURIComponent(ref.family)}&weight=${ref.weight}`
  else {
    const face = resolveLibraryFace(ref.family, ref.weight ?? 400, ref.italic)
    url = face ? libraryFontUrl(face.id) : null
  }
  // While a web export's adapter is mounted, an outline font resolves to its inlined bytes; fetch()
  // of a data: URL is not a network request, so loadVectorFont needs no change.
  return url === null ? null : resolveAssetUrl('outlineFont', formatVtFontToken(ref), url)
}
```

- [ ] **Step 5: Run the new test and the neighbours it could break**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-asset-scope.unit.spec.ts`
Expected: PASS (all 7 tests).

Then run the existing specs that cover the edited modules:
`cd frontend && npx vitest run $(ls tests/unit | grep -Ei 'clip|imagefill|image-fill|fonttoken|font-token|shaderfill|compositor-layers|living' | sed 's#^#tests/unit/#')`
Expected: PASS, same counts as at HEAD (run the same command on HEAD first if a count looks off; a timing-out spec re-runs alone per `main-test-suite-triage` memory).

- [ ] **Step 6: Typecheck and commit**

Typecheck count must not exceed the baseline. Commit (private-index recipe) the paths:
`frontend/app/lib/compositor/assetScope.ts frontend/app/composables/useCompositorLayers.ts frontend/app/lib/compositor/clip.ts frontend/app/lib/paint/imageFillCache.ts frontend/app/lib/shaderfill/field.ts frontend/app/lib/vectortype/fontToken.ts frontend/tests/unit/frame-embed-asset-scope.unit.spec.ts`

Message: `feat(embed): an asset resolver the Frame painter's five URL builders consult — nothing registered, nothing changes`

**Before committing `useCompositorLayers.ts`:** another session may have uncommitted edits in it. Run `git diff -- frontend/app/composables/useCompositorLayers.ts`; if it shows hunks that are not yours, stage only your hunks (`git diff -- <file> > /tmp/x.patch`, edit the patch down to your hunks, `git apply --cached /tmp/x.patch` with the private index exported) and skip the final `git reset` for that one file.

---

### Task 2: Depth request split, shader catalog merge, weight-range font faces

**Files:**
- Create: `frontend/app/lib/compositor/depthRequest.ts`
- Modify: `frontend/app/lib/compositor/depthRegistry.ts`
- Modify: `frontend/app/lib/shaderfx/catalogStore.ts`
- Modify: `frontend/app/lib/embed/fontFace.ts`
- Test: `frontend/tests/unit/frame-embed-seams.unit.spec.ts`

**Interfaces:**
- Produces:
  - `type DepthEstimate = { ok: true; depthFilename: string; subfolder: string } | { ok: false; message: string }`
  - `requestDepthEstimate(src: { filename: string; subfolder?: string; type?: 'input' | 'output' | 'temp' }): Promise<DepthEstimate>` (in `depthRequest.ts`)
  - `seedDepthImage(ref: DepthRef, img: HTMLImageElement): void` (in `depthRegistry.ts`)
  - `addShaderFxEffects(defs: EffectDef[]): void` (in `catalogStore.ts`)
  - `fontFaceRule(opts: { family: string; weight: FontWeightSpec; dataUrl: string }): string` and `fontFaceId(family: string, weight: FontWeightSpec): string`, where `type FontWeightSpec = number | readonly [number, number]` (exported from `fontFace.ts`)

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-embed-seams.unit.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('~/lib/compositor/depthRequest', () => ({
  requestDepthEstimate: vi.fn(async () => ({ ok: false, message: 'depth estimation is not available here' })),
}))

import {
  requestDepth, depthStatusFor, depthMessageFor, depthImageFor, seedDepthImage, onDepthChange, __resetDepthRegistry,
} from '~/lib/compositor/depthRegistry'
import { setShaderFxCatalog, addShaderFxEffects, getEffectSync } from '~/lib/shaderfx/catalogStore'
import { fontFaceRule, fontFaceId } from '~/lib/embed/fontFace'

describe('depth registry', () => {
  beforeEach(() => __resetDepthRegistry())

  it('a seeded depth map is ready synchronously and notifies', () => {
    const img = {} as HTMLImageElement
    const seen = vi.fn()
    onDepthChange(seen)
    seedDepthImage({ filename: 'a.png', type: 'input' }, img)
    expect(depthImageFor('a.png')).toBe(img)
    expect(depthStatusFor('a.png')).toBe('ready')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('a failed estimate lands as a retryable error with its message', async () => {
    requestDepth('b.png')
    await vi.waitFor(() => expect(depthStatusFor('b.png')).toBe('error'))
    expect(depthMessageFor('b.png')).toBe('depth estimation is not available here')
  })
})

describe('shader catalog merge', () => {
  it('adds effects the catalog lacks and never replaces one it has', () => {
    setShaderFxCatalog({ version: 3, effects: [{ id: 'keep', source: 'A' } as any] })
    addShaderFxEffects([{ id: 'keep', source: 'B' } as any, { id: 'new', source: 'C' } as any])
    expect((getEffectSync('keep') as any).source).toBe('A')
    expect((getEffectSync('new') as any).source).toBe('C')
  })

  it('works from an empty store', () => {
    setShaderFxCatalog(null)
    addShaderFxEffects([{ id: 'solo', source: 'S' } as any])
    expect((getEffectSync('solo') as any).source).toBe('S')
  })
})

describe('font faces with a weight range', () => {
  it('a single weight is unchanged', () => {
    expect(fontFaceRule({ family: 'A', weight: 700, dataUrl: 'data:font/ttf;base64,AA' }))
      .toBe("@font-face{font-family:'A';font-weight:700;font-style:normal;font-display:swap;src:url('data:font/ttf;base64,AA')}")
    expect(fontFaceId('A', 700)).toBe('A__700')
  })

  it('a variable file declares its whole weight range', () => {
    expect(fontFaceRule({ family: 'Inter', weight: [100, 900], dataUrl: 'data:font/ttf;base64,AA' }))
      .toContain('font-weight:100 900;')
    expect(fontFaceId('Inter', [100, 900])).toBe('Inter__100-900')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-seams.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/compositor/depthRequest`; `seedDepthImage` / `addShaderFxEffects` not exported.

- [ ] **Step 3: Split out the depth request**

Create `frontend/app/lib/compositor/depthRequest.ts`:

```ts
/**
 * The one network call behind depth maps, on its own so the web-export build can replace this
 * module (and only this module) with a stand-in that says "not available" — the literal route
 * below must never be present in an exported file. See vite.embed.config.ts.
 */
export type DepthEstimate =
  | { ok: true; depthFilename: string; subfolder: string }
  | { ok: false; message: string }

export async function requestDepthEstimate(
  src: { filename: string; subfolder?: string; type?: 'input' | 'output' | 'temp' },
): Promise<DepthEstimate> {
  try {
    const res = await fetch('/api/depth/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: src.filename, subfolder: src.subfolder, type: src.type ?? 'input' }),
    })
    if (!res.ok) return { ok: false, message: `depth request failed (${res.status})` }
    const data = await res.json()
    if (!data?.depthFilename) return { ok: false, message: 'depth request returned no file' }
    return { ok: true, depthFilename: data.depthFilename, subfolder: data.subfolder ?? '' }
  } catch (err) {
    return { ok: false, message: `depth request failed: ${(err as Error).message}` }
  }
}
```

In `frontend/app/lib/compositor/depthRegistry.ts` add `import { requestDepthEstimate } from '~/lib/compositor/depthRequest'` (an alias path, not `./depthRequest`, so the one embed-build alias in Task 6 covers it) and replace the `void (async () => { … })()` body of `requestDepth` with:

```ts
  void (async () => {
    const est = await requestDepthEstimate(src)
    if (!est.ok) return fail(key, est.message)
    const url = depthUrl(est.depthFilename, est.subfolder)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { entries.set(key, { status: 'ready', img }); notify() }
    img.onerror = () => fail(key, 'depth map could not be decoded')
    img.src = url
  })()
```

The messages are the same strings as before, so any existing depth test keeps passing. Add below `requestDepth`:

```ts
/** A depth map that is already in hand — a web export ships the maps the editor had cached and
 *  seeds them here at mount, so a depth-of-field layer paints exactly as it did in the editor. */
export function seedDepthImage(ref: DepthRef, img: HTMLImageElement): void {
  entries.set(depthKey(ref), { status: 'ready', img })
  notify()
}
```

- [ ] **Step 4: Catalog merge and font weight ranges**

In `frontend/app/lib/shaderfx/catalogStore.ts`, below `setShaderFxCatalog`:

```ts
/** Add effect definitions the store does not have yet; never replace one it has. A web export
 *  ships only the effects its Frame uses and merges them in at mount — merging, not replacing,
 *  because two exported Frames can share one page (and, in the app, the full catalog is already
 *  loaded and must stay intact while the poster is baked). */
export function addShaderFxEffects(defs: EffectDef[]): void {
  const byId = new Map((cached?.effects ?? []).map(e => [e.id, e]))
  for (const d of defs) if (!byId.has(d.id)) byId.set(d.id, d)
  cached = { version: cached?.version ?? 1, effects: [...byId.values()] }
}
```

In `frontend/app/lib/embed/fontFace.ts`, add `export type FontWeightSpec = number | readonly [number, number]`, change both signatures' `weight: number` to `weight: FontWeightSpec`, and use:

```ts
const weightCss = (w: FontWeightSpec) => (typeof w === 'number' ? String(w) : `${w[0]} ${w[1]}`)
export function fontFaceId(family: string, weight: FontWeightSpec): string {
  return `${family}__${typeof weight === 'number' ? weight : `${weight[0]}-${weight[1]}`}`
}
```

and `font-weight:${weightCss(weight)};` inside `fontFaceRule`. Add a sentence to the module doc: a variable font file is one face covering its whole weight range.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-seams.unit.spec.ts tests/unit/embed-font-face.unit.spec.ts tests/unit/embed-spacetype.unit.spec.ts $(ls tests/unit | grep -Ei 'depth|catalog' | sed 's#^#tests/unit/#')`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Paths: `frontend/app/lib/compositor/depthRequest.ts frontend/app/lib/compositor/depthRegistry.ts frontend/app/lib/shaderfx/catalogStore.ts frontend/app/lib/embed/fontFace.ts frontend/tests/unit/frame-embed-seams.unit.spec.ts`
Message: `feat(embed): depth request in its own module, a merging shader-catalog add, font faces with a weight range`

---

### Task 3: The snapshot types, the planner, and the embed snippet

**Files:**
- Create: `frontend/app/lib/embed/frame/types.ts`
- Create: `frontend/app/lib/embed/frame/plan.ts`
- Create: `frontend/app/lib/embed/snippet.ts`
- Test: `frontend/tests/unit/frame-embed-plan.unit.spec.ts`

**Interfaces:**
- Consumes: `FrameAssetKind` (Task 1); `effectStackOf` from `~/lib/compositor/effectStack`; `depthSourceFromViewUrl`, `DepthRef` from `~/lib/compositor/depthRegistry`; `collectFillImageSrcs`, `LocalLayer` from `~/composables/useCompositorLayers`; `revealEffectIdsFor` from `~/lib/motionx/reveal/params`; `resolveEffectId` from `~/lib/shaderfx/catalogStore`.
- Produces (`types.ts`):

```ts
export type FrameFit = 'fit' | 'fill'
export interface FrameVariant {
  width: number; height: number
  layers: LocalLayer[]; stackOrder: string[]; groups: LayerGroup[]
  background: Paint | null; post: PostEffect[]; motion: FrameMotion | null
  wiredTreatments: Record<string, WiredTreatment>
}
export type FrameFontOrigin = 'uploaded' | 'google' | 'library' | 'variable'
export interface FrameFontAsset { family: string; weight: FontWeightSpec; dataUrl: string; origin: FrameFontOrigin }
export type WiredEntry = { kind: 'still'; dataUrl: string }
export interface FrameAssets {
  urls: Record<string, string>                 // assetKey(kind, key) → data URL
  fonts: FrameFontAsset[]
  shaders: EffectDef[]
  depth: { ref: DepthRef; dataUrl: string }[]
}
export type FrameNoticeGroup = 'fonts' | 'live' | 'still' | 'leftOut' | 'blocked'
export interface FrameNotice { group: FrameNoticeGroup; text: string; layerId?: string; bytes?: number }
export interface FrameSnapshot {
  version: 1; fit: FrameFit; duration: number; still: boolean
  variants: FrameVariant[]; assets: FrameAssets; wired: Record<number, WiredEntry>; notices: FrameNotice[]
}
export function assetKey(kind: FrameAssetKind, key: string): string
```

- Produces (`plan.ts`):

```ts
export interface WiredSlotInfo { slot: number; layerId: string; label: string; animated: boolean }
export interface FrameExportInput {
  variant: FrameVariant; fit: FrameFit; wiredSlots: WiredSlotInfo[]
  catalogIds: ReadonlySet<string>; hasMotion: boolean; animatedFill: boolean
}
export interface FramePlan {
  fit: FrameFit; duration: number; still: boolean
  images: { filename: string; maxPx: number }[]
  clips: { clip: ImageClip; maxPx: number; layerId: string }[]
  fillImages: string[]
  fonts: { family: string; weight: number; text: string; outline: boolean }[]
  shaderIds: string[]
  depth: { ref: DepthRef; layerId: string; label: string }[]
  wiredStills: { slot: number; maxPx: number }[]
  notices: FrameNotice[]
}
export function planFrameExport(input: FrameExportInput): FramePlan
export function layerLabel(l: LocalLayer): string
export function textNeedsOutline(l: LocalLayer): boolean
```

- Produces (`snippet.ts`): `embedSnippet(filename: string, width: number, height: number): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-embed-plan.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planFrameExport, type FrameExportInput } from '~/lib/embed/frame/plan'
import { assetKey, type FrameVariant } from '~/lib/embed/frame/types'
import { embedSnippet } from '~/lib/embed/snippet'
import { createTextLayer, createRectLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_FILL } from '~/lib/spacetype/fillTile'
import { createEffect } from '~/lib/compositor/effectStack'

function variant(layers: any[], extra: Partial<FrameVariant> = {}): FrameVariant {
  return {
    width: 1000, height: 500, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
    background: '#101010', post: [], motion: null, wiredTreatments: {}, ...extra,
  }
}
function input(v: FrameVariant, extra: Partial<FrameExportInput> = {}): FrameExportInput {
  return { variant: v, fit: 'fit', wiredSlots: [], catalogIds: new Set(['liquify', 'ascii_dither']),
    hasMotion: false, animatedFill: false, ...extra }
}

describe('planFrameExport', () => {
  it('a Frame with nothing moving is a still with a one-second placeholder clock', () => {
    const p = planFrameExport(input(variant([createRectLayer({})])))
    expect(p.still).toBe(true)
    expect(p.duration).toBe(1)
  })

  it('motion makes it live and takes the motion duration', () => {
    const v = variant([createRectLayer({})], { motion: { fps: 30, duration: 6 } })
    const p = planFrameExport(input(v, { hasMotion: true }))
    expect(p.still).toBe(false)
    expect(p.duration).toBe(6)
    expect(p.notices.find(n => n.group === 'live')?.text).toBe('Everything you animated in the Motion tab')
  })

  it('images are sized to twice their drawn long side', () => {
    const img = createImageLayer('photo.png', 0.5, { w: 0.4, h: 0.2 })
    const p = planFrameExport(input(variant([img])))
    expect(p.images).toEqual([{ filename: 'photo.png', maxPx: 800 }])   // 2 × 0.4 × 1000
  })

  it('a stand-in image needs no file', () => {
    const img = createImageLayer('x.png', 1, { standIn: true } as any)
    expect(planFrameExport(input(variant([img]))).images).toEqual([])
  })

  it('an image clip keeps the Frame live and is listed', () => {
    const img = createImageLayer('rose.png', 1, { w: 0.3, h: 0.3 })
    ;(img as any).clip = { dir: 'sailor_clips/c1', frames: 12, fps: 24, speed: 1, prompt: '', model: '' }
    const p = planFrameExport(input(variant([img])))
    expect(p.still).toBe(false)
    expect(p.clips).toHaveLength(1)
    expect(p.clips[0]!.maxPx).toBe(600)
  })

  it('fonts are listed once per family and weight, with all their text', () => {
    const a = createTextLayer({ text: 'Hello', fontFamily: 'Inter', fontWeight: 700 })
    const b = createTextLayer({ text: 'World', fontFamily: 'Inter', fontWeight: 700 })
    const c = createTextLayer({ text: 'Light', fontFamily: 'Inter', fontWeight: 300 })
    const p = planFrameExport(input(variant([a, b, c])))
    expect(p.fonts).toEqual([
      { family: 'Inter', weight: 700, text: 'HelloWorld', outline: false },
      { family: 'Inter', weight: 300, text: 'Light', outline: false },
    ])
  })

  it('an accent face is a font too', () => {
    const a = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).accentFace = 'Fraunces'
    expect(planFrameExport(input(variant([a]))).fonts.map(f => f.family)).toEqual(['Inter', 'Fraunces'])
  })

  it('outlined text asks for outline bytes', () => {
    const a = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(a as any).renderAsOutline = true
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(true)
  })

  it('shader ids are found anywhere in the Frame, plus what the transitions need', () => {
    const r = createRectLayer({})
    ;(r as any).fill = { ...DEFAULT_FILL, type: 'shader', shader: { effectId: 'liquify', params: {}, anchor: 'object', speed: 1, seed: 42, input: '#000000' } }
    const v = variant([r], { motion: { fps: 30, duration: 4, behaviours: [
      { id: 'b1', layerId: r.id, kind: 'dither', timing: { start: 0, duration: 1 }, params: { style: 'pixels' } } as any,
    ] } })
    const ids = planFrameExport(input(v, { hasMotion: true })).shaderIds
    expect(ids).toContain('liquify')
    expect(ids).toContain('ascii_dither')   // revealEffectIdsFor: a Pixels dither bar needs the ASCII effect
  })

  it('a string that is not a catalog id is not a shader', () => {
    const t = createTextLayer({ text: 'liquify me' })
    expect(planFrameExport(input(variant([t]))).shaderIds).toEqual([])
  })

  it('an animated wired layer is held as a still and says so', () => {
    const w = { kind: 'wired', id: 'w1', slot: 0, w: 0.5, lastAspect: 0.5, x: 0.5, y: 0.5 } as any
    const p = planFrameExport(input(variant([w]), {
      wiredSlots: [{ slot: 0, layerId: 'w1', label: 'Space Type', animated: true }],
    }))
    expect(p.wiredStills).toEqual([{ slot: 0, maxPx: 1000 }])
    expect(p.notices).toContainEqual({ group: 'still', text: 'Space Type · shown as a still in this version', layerId: 'w1' })
  })

  it('a still wired layer is captured without a notice', () => {
    const w = { kind: 'wired', id: 'w1', slot: 1, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any
    const p = planFrameExport(input(variant([w]), {
      wiredSlots: [{ slot: 1, layerId: 'w1', label: 'Photo', animated: false }],
    }))
    expect(p.wiredStills).toHaveLength(1)
    expect(p.notices.filter(n => n.group === 'still')).toEqual([])
  })

  it('an old-style wired stack key blocks the export', () => {
    const v = variant([createRectLayer({})])
    v.stackOrder = ['w:1', ...v.stackOrder]
    const p = planFrameExport(input(v))
    expect(p.notices.some(n => n.group === 'blocked')).toBe(true)
  })

  it('depth of field lists its depth source', () => {
    const img = createImageLayer('photo.png', 1, {})
    ;(img as any).effects = [{ ...createEffect('dof'), visible: true }]
    const p = planFrameExport(input(variant([img])))
    expect(p.depth).toEqual([{ ref: 'photo.png', layerId: img.id, label: 'Image' }])
  })

  it('assetKey joins kind and key', () => {
    expect(assetKey('image', 'a.png')).toBe('image|a.png')
  })
})

describe('embedSnippet', () => {
  it('keeps the export\'s aspect ratio and loads lazily', () => {
    expect(embedSnippet('sailor-frame.html', 1920, 1080)).toBe(
      '<iframe src="sailor-frame.html" title="Sailor frame" loading="lazy" '
      + 'style="width:100%;aspect-ratio:1920 / 1080;border:0;display:block"></iframe>')
  })

  it('escapes the file name', () => {
    expect(embedSnippet('a"b.html', 1, 1)).toContain('src="a&quot;b.html"')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-plan.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the types**

Create `frontend/app/lib/embed/frame/types.ts` with exactly the declarations listed under **Produces** above, with these imports:

```ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Paint } from '~/lib/compositor/paint'
import type { PostEffect } from '~/lib/compositor/postEffects'
import type { FrameMotion } from '~/lib/motion/types'
import type { WiredTreatment } from '~/composables/useWiredTreatments'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import type { FrameAssetKind } from '~/lib/compositor/assetScope'
import type { FontWeightSpec } from '../fontFace'
```

(type-only imports: this file travels into the bundle). Implementation of `assetKey`: `return \`${kind}|${key}\``. Put a module doc stating: plain JSON, written once at export, `variants` is a list so art-directed variants or responsive layout can arrive without a format change; `FrameFit` leaves room for `'adapt'`.

- [ ] **Step 4: Write the planner**

Create `frontend/app/lib/embed/frame/plan.ts`:

```ts
/**
 * What a Frame needs in order to play on its own, and what the export sheet will say about it.
 * Pure: no fetching, no DOM. The gatherer (gather.ts) turns this plan into a snapshot.
 *
 * The walk that lists assets is the walk that writes the notices, so the sheet cannot disagree
 * with the file.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { collectFillImageSrcs } from '~/composables/useCompositorLayers'
import { effectStackOf, GEOMETRY_KINDS } from '~/lib/compositor/effectStack'
import { depthSourceFromViewUrl, type DepthRef } from '~/lib/compositor/depthRegistry'
import { revealEffectIdsFor } from '~/lib/motionx/reveal/params'
import { resolveEffectId } from '~/lib/shaderfx/catalogStore'
import type { ImageClip } from '~/lib/compositor/clip'
import type { FrameFit, FrameNotice, FrameVariant } from './types'

export interface WiredSlotInfo { slot: number; layerId: string; label: string; animated: boolean }
export interface FrameExportInput {
  variant: FrameVariant
  fit: FrameFit
  wiredSlots: WiredSlotInfo[]
  /** Every effect id in the loaded shader catalog. */
  catalogIds: ReadonlySet<string>
  /** The modal's own `hasMotion` (local animation, animated slot, motion bands or behaviours). */
  hasMotion: boolean
  /** `hasAnimatedShaderFill(items, background)` — a live shader fill with no other motion. */
  animatedFill: boolean
}
export interface FramePlan {
  fit: FrameFit
  duration: number
  still: boolean
  images: { filename: string; maxPx: number }[]
  clips: { clip: ImageClip; maxPx: number; layerId: string }[]
  fillImages: string[]
  fonts: { family: string; weight: number; text: string; outline: boolean }[]
  shaderIds: string[]
  depth: { ref: DepthRef; layerId: string; label: string }[]
  wiredStills: { slot: number; maxPx: number }[]
  notices: FrameNotice[]
}

const GEOMETRY = new Set<string>(GEOMETRY_KINDS)

/** A name for a layer in a sentence. */
export function layerLabel(l: LocalLayer): string {
  const named = (l as { name?: unknown }).name
  if (typeof named === 'string' && named.trim()) return named.trim()
  switch (l.kind) {
    case 'wired': return 'Wired layer'
    case 'image': return 'Image'
    case 'text': return 'Text'
    default: return 'Layer'
  }
}

/** True when the painter will draw this text from glyph outlines (fontkit), not fillText. Mirrors
 *  drawLayerContent's rule: an explicit outline, a path to follow, or any geometry effect. */
export function textNeedsOutline(l: LocalLayer): boolean {
  if (l.kind !== 'text') return false
  const t = l as { renderAsOutline?: boolean; path?: unknown }
  if (t.renderAsOutline === true || t.path) return true
  return effectStackOf(l).some(e => GEOMETRY.has(e.type))
}

function drawnLongSide(l: { w?: number; h?: number }, width: number): number {
  const w = Number(l.w) || 0
  const h = Number(l.h) || 0
  return Math.max(w, h) * width
}

/** Every string anywhere inside `value` — the robust way to find shader ids, which live in fills,
 *  strokes, layer effects, deal fills, backgrounds and motion alike. A string that happens to equal
 *  an id only costs one extra effect in the file. */
function collectStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 40 || value == null) return
  if (typeof value === 'string') { out.add(value); return }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1)
}

export function planFrameExport(input: FrameExportInput): FramePlan {
  const { variant: v, fit } = input
  const notices: FrameNotice[] = []
  const layers = v.layers

  if (v.stackOrder.some(k => k.startsWith('w:'))) {
    notices.push({ group: 'blocked', text: 'This Frame uses an older kind of wired layer. Close the Frame editor, open it again, then export.' })
  }

  const images: FramePlan['images'] = []
  const clips: FramePlan['clips'] = []
  const depth: FramePlan['depth'] = []
  const wiredStills: FramePlan['wiredStills'] = []
  const fontMap = new Map<string, FramePlan['fonts'][number]>()

  const addFont = (family: string | undefined, weight: number, text: string, outline: boolean) => {
    const fam = family?.trim()
    if (!fam) return
    const key = `${fam}|${weight}`
    const hit = fontMap.get(key)
    if (hit) { hit.text += text; hit.outline ||= outline }
    else fontMap.set(key, { family: fam, weight, text, outline })
  }

  for (const l of layers) {
    if (l.kind === 'image') {
      const img = l as LocalLayer & { filename: string; standIn?: boolean; clip?: ImageClip; w: number; h: number }
      const maxPx = Math.ceil(2 * drawnLongSide(img, v.width))
      if (img.filename && !img.standIn) images.push({ filename: img.filename, maxPx })
      if (img.clip && img.clip.frames > 0) clips.push({ clip: img.clip, maxPx, layerId: l.id })
    }
    if (l.kind === 'text') {
      const t = l as LocalLayer & { text: string; fontFamily: string; fontWeight: number; accentFace?: string }
      const weight = Number(t.fontWeight) || 400
      const outline = textNeedsOutline(l)
      addFont(t.fontFamily, weight, t.text ?? '', outline)
      if (t.accentFace) addFont(t.accentFace, weight, t.text ?? '', outline)
    }
    if (l.kind === 'wired') {
      const wl = l as LocalLayer & { slot: number; w: number; lastAspect: number }
      const w = Number(wl.w) || 0
      const aspect = Number(wl.lastAspect) || 1
      wiredStills.push({ slot: wl.slot, maxPx: Math.ceil(2 * Math.max(w, w * aspect) * v.width) })
      const info = input.wiredSlots.find(s => s.layerId === l.id)
      if (info?.animated) notices.push({ group: 'still', text: `${info.label} · shown as a still in this version`, layerId: l.id })
    }
    const hasDof = effectStackOf(l).some(e => e.type === 'dof' && (e as { visible?: boolean }).visible !== false)
      || (l.kind === 'wired' && !!v.wiredTreatments[`l:${l.id}`]?.dof)
    if (hasDof) {
      const ref: DepthRef | null = l.kind === 'image'
        ? (l as { filename: string }).filename
        : l.kind === 'wired' ? depthSourceFromViewUrl((l as { depthKey?: string }).depthKey) : null
      if (ref) depth.push({ ref, layerId: l.id, label: layerLabel(l) })
      else notices.push({ group: 'leftOut', text: `Depth blur on ${layerLabel(l)} · needs a depth map`, layerId: l.id })
    }
  }

  const strings = new Set<string>()
  collectStrings({ layers, background: v.background, post: v.post, motion: v.motion }, strings)
  const shaderIds = new Set<string>()
  for (const s of strings) {
    const id = resolveEffectId(s)
    if (input.catalogIds.has(id)) shaderIds.add(id)
  }
  for (const id of revealEffectIdsFor(v.motion?.behaviours)) shaderIds.add(id)

  const still = !input.hasMotion && !input.animatedFill && clips.length === 0
  if (input.hasMotion) notices.push({ group: 'live', text: 'Everything you animated in the Motion tab' })
  if (input.animatedFill) notices.push({ group: 'live', text: 'Moving shader fills' })
  const duration = still ? 1 : (v.motion && v.motion.duration > 0 ? v.motion.duration : 4)

  return {
    fit, duration, still, images, clips,
    fillImages: collectFillImageSrcs(layers),
    fonts: [...fontMap.values()],
    shaderIds: [...shaderIds],
    depth, wiredStills, notices,
  }
}
```

Check that `effectStackOf` accepts every `LocalLayer` (its parameter type is `StackHost | null | undefined`); if TypeScript needs it, cast `l as any` at the two call sites — do not change `effectStackOf`.

- [ ] **Step 5: Write the snippet**

Create `frontend/app/lib/embed/snippet.ts`:

```ts
/** The iframe a designer pastes into their site to show an exported file. The aspect ratio is
 *  the export's own, so the box keeps the Frame's shape at any width. */
export function embedSnippet(filename: string, width: number, height: number): string {
  const src = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return `<iframe src="${src}" title="Sailor frame" loading="lazy" `
    + `style="width:100%;aspect-ratio:${w} / ${h};border:0;display:block"></iframe>`
}
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-plan.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Paths: `frontend/app/lib/embed/frame/types.ts frontend/app/lib/embed/frame/plan.ts frontend/app/lib/embed/snippet.ts frontend/tests/unit/frame-embed-plan.unit.spec.ts`
Message: `feat(embed): FrameSnapshot types and a pure planner — what a Frame needs, and what the sheet will say`

---

### Task 4: The gatherer, the app IO, and the shared font helpers

**Files:**
- Create: `frontend/app/lib/embed/fontBytes.ts`
- Create: `frontend/app/lib/embed/frame/gather.ts`
- Create: `frontend/app/lib/embed/frame/appIO.ts`
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` (use `fontBytes.ts`; see Step 6)
- Test: `frontend/tests/unit/frame-embed-gather.unit.spec.ts`

**Interfaces:**
- Consumes: `FramePlan`, `FrameVariant`, `FrameSnapshot`, `assetKey` (Task 3); `imageLayerUrl` (useCompositorLayers), `clipFrameUrl`, `clipFrameKey` (clip.ts), `shaderTextureUrl`, `shaderTextureKey` (field.ts), `compositorFontToken` (textOutline.ts), `parseVtFontToken`, `vtFontFileUrl` (fontToken.ts), `VARIABLE_FONTS_BY_ID` (data/variable-fonts), `depthImageFor` (depthRegistry).
- Produces:

```ts
// fontBytes.ts
export function bufferToBase64(buf: ArrayBuffer): string
export async function subsetFontBase64(fontB64: string, text: string, logTag?: string): Promise<string | null>
// gather.ts
export interface FontSource { url: string; origin: FrameFontOrigin; weight: FontWeightSpec }
export interface FrameExportIO {
  fetchBlob(url: string): Promise<Blob>
  blobToImage(blob: Blob): Promise<CanvasImageSource>
  imageToDataUrl(img: CanvasImageSource, maxPx: number, mime: 'image/webp' | 'image/png'): Promise<string>
  blobToDataUrl(blob: Blob): Promise<string>
  blobToBase64(blob: Blob): Promise<string>
  subsetFont(fontB64: string, text: string): Promise<string | null>
  fontSource(family: string, weight: number): FontSource | null
  wiredStill(slot: number): CanvasImageSource | null
  depthImage(ref: DepthRef): CanvasImageSource | null
  shaderDefs(ids: string[]): EffectDef[]
}
export async function buildFrameSnapshot(plan: FramePlan, variant: FrameVariant, io: FrameExportIO): Promise<FrameSnapshot>
export function isBlocked(snapshot: FrameSnapshot): boolean
// appIO.ts
export function makeFontSource(uploaded: UploadedFontEntry[]): (family: string, weight: number) => FontSource | null
export function createAppFrameExportIO(opts: {
  uploaded: UploadedFontEntry[]
  wiredStill: (slot: number) => CanvasImageSource | null
  catalog: EffectDef[]
}): FrameExportIO
```

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-embed-gather.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildFrameSnapshot, isBlocked, type FrameExportIO } from '~/lib/embed/frame/gather'
import { planFrameExport } from '~/lib/embed/frame/plan'
import { assetKey, type FrameVariant } from '~/lib/embed/frame/types'
import { makeFontSource } from '~/lib/embed/frame/appIO'
import { createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { clipFrameKey } from '~/lib/compositor/clip'
import { createEffect } from '~/lib/compositor/effectStack'

const v = (layers: any[]): FrameVariant => ({
  width: 1000, height: 500, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
  background: null, post: [], motion: null, wiredTreatments: {},
})

function fakeIO(over: Partial<FrameExportIO> = {}): FrameExportIO {
  return {
    fetchBlob: vi.fn(async (url: string) => new Blob([url])),
    blobToImage: vi.fn(async () => ({ width: 10, height: 10 } as any)),
    imageToDataUrl: vi.fn(async (_i, maxPx, mime) => `data:${mime};base64,IMG${maxPx}`),
    blobToDataUrl: vi.fn(async () => 'data:image/png;base64,RAW'),
    blobToBase64: vi.fn(async () => 'RkFMTA=='),
    subsetFont: vi.fn(async () => 'U1VC'),
    fontSource: vi.fn((family: string, weight: number) => ({ url: `/f/${family}/${weight}`, origin: 'google' as const, weight })),
    wiredStill: vi.fn(() => ({ width: 4, height: 4 } as any)),
    depthImage: vi.fn(() => null),
    shaderDefs: vi.fn(() => []),
    ...over,
  }
}
const plan = (layers: any[]) => planFrameExport({
  variant: v(layers), fit: 'fit', wiredSlots: [], catalogIds: new Set(), hasMotion: false, animatedFill: false,
})

describe('buildFrameSnapshot', () => {
  it('inlines each image under its asset key, re-encoded at the planned size', async () => {
    const img = createImageLayer('photo.png', 1, { w: 0.4, h: 0.4 })
    const snap = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    expect(snap.assets.urls[assetKey('image', 'photo.png')]).toBe('data:image/webp;base64,IMG800')
    expect(isBlocked(snap)).toBe(false)
  })

  it('a failed image blocks the export and names the file', async () => {
    const img = createImageLayer('gone.png', 1, {})
    const io = fakeIO({ fetchBlob: vi.fn(async () => { throw new Error('404') }) })
    const snap = await buildFrameSnapshot(plan([img]), v([img]), io)
    expect(isBlocked(snap)).toBe(true)
    expect(snap.notices.find(n => n.group === 'blocked')?.text).toBe('The image "gone.png" couldn\'t be loaded.')
  })

  it('every clip frame is inlined and the clip\'s weight is stated', async () => {
    const img = createImageLayer('rose.png', 1, { w: 0.2, h: 0.2 })
    const clip = { dir: 'c1', frames: 3, fps: 24, speed: 1, prompt: '', model: '' }
    ;(img as any).clip = clip
    const snap = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    for (let i = 0; i < 3; i++) expect(snap.assets.urls[assetKey('clipFrame', clipFrameKey(clip, i))]).toMatch(/^data:image\/webp/)
    expect(snap.notices.find(n => n.group === 'live')?.text).toMatch(/^Image clip · adds \d+(\.\d)? (KB|MB)$/)
  })

  it('fonts are subsetted, inlined as faces, and listed by name', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const io = fakeIO()
    const snap = await buildFrameSnapshot(plan([t]), v([t]), io)
    expect(io.subsetFont).toHaveBeenCalledWith('RkFMTA==', 'Hi')
    expect(snap.assets.fonts).toEqual([{ family: 'Inter', weight: 700, dataUrl: 'data:font/ttf;base64,U1VC', origin: 'google' }])
    expect(snap.notices).toContainEqual({ group: 'fonts', text: 'Inter · Google' })
  })

  it('a failed subset falls back to the whole font', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO({ subsetFont: vi.fn(async () => null) }))
    expect(snap.assets.fonts[0]!.dataUrl).toBe('data:font/ttf;base64,RkFMTA==')
  })

  it('a system family needs nothing and says nothing', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Helvetica', fontWeight: 400 })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO({ fontSource: vi.fn(() => null) }))
    expect(snap.assets.fonts).toEqual([])
    expect(snap.notices.filter(n => n.group === 'fonts')).toEqual([])
  })

  it('a font that cannot be fetched blocks the export', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const io = fakeIO({ fetchBlob: vi.fn(async () => { throw new Error('offline') }) })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), io)
    expect(snap.notices.find(n => n.group === 'blocked')?.text)
      .toBe('The font "Inter" couldn\'t be loaded, so the export would draw the wrong typeface.')
  })

  it('one variable file serves every weight of its family once', async () => {
    const a = createTextLayer({ text: 'A', fontFamily: 'Inter', fontWeight: 300 })
    const b = createTextLayer({ text: 'B', fontFamily: 'Inter', fontWeight: 800 })
    const io = fakeIO({ fontSource: vi.fn(() => ({ url: '/f/inter-var', origin: 'variable' as const, weight: [100, 900] as const })) })
    const snap = await buildFrameSnapshot(plan([a, b]), v([a, b]), io)
    expect(snap.assets.fonts).toHaveLength(1)
    expect(snap.assets.fonts[0]!.weight).toEqual([100, 900])
    expect(io.subsetFont).toHaveBeenCalledWith('RkFMTA==', 'AB')
  })

  it('outlined text also gets its outline bytes under the Vector Type token', async () => {
    const t = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(t as any).renderAsOutline = true
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO())
    expect(Object.keys(snap.assets.urls).some(k => k.startsWith('outlineFont|'))).toBe(true)
  })

  it('wired stills are captured', async () => {
    const w = { kind: 'wired', id: 'w1', slot: 2, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any
    const snap = await buildFrameSnapshot(plan([w]), v([w]), fakeIO())
    expect(snap.wired[2]).toEqual({ kind: 'still', dataUrl: 'data:image/webp;base64,IMG1000' })
  })

  it('a depth map the editor has cached ships; a missing one is named as left out', async () => {
    const img = createImageLayer('p.png', 1, {})
    ;(img as any).effects = [{ ...createEffect('dof'), visible: true }]
    const missing = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    expect(missing.notices).toContainEqual({ group: 'leftOut', text: 'Depth blur on Image · needs a depth map', layerId: img.id })
    const cached = await buildFrameSnapshot(plan([img]), v([img]), fakeIO({ depthImage: vi.fn(() => ({ width: 2, height: 2 } as any)) }))
    expect(cached.assets.depth).toEqual([{ ref: 'p.png', dataUrl: 'data:image/png;base64,IMG4096' }])
  })

  it('shader definitions and their textures are inlined', async () => {
    const io = fakeIO({ shaderDefs: vi.fn(() => [{ id: 'fx', textures: [{ uniform: 'u_atlas', file: 'atlas.png', v: '3' }] } as any]) })
    const p = plan([]); p.shaderIds = ['fx']
    const snap = await buildFrameSnapshot(p, v([]), io)
    expect(snap.assets.shaders.map(d => d.id)).toEqual(['fx'])
    expect(snap.assets.urls[assetKey('shaderTexture', 'atlas.png@3')]).toBe('data:image/png;base64,RAW')
  })

  it('a planned shader the catalog lacks blocks the export', async () => {
    const p = plan([]); p.shaderIds = ['nope']
    const snap = await buildFrameSnapshot(p, v([]), fakeIO())
    expect(isBlocked(snap)).toBe(true)
  })
})

describe('makeFontSource', () => {
  it('an uploaded family wins and uses its nearest stored weight', () => {
    const src = makeFontSource([{ family: 'Brand', slug: 'brand', weights: { '400': 'b4.otf', '700': 'b7.otf' } }])
    expect(src('Brand', 600)).toEqual({ url: '/api/template-fonts/file/b7.otf', origin: 'uploaded', weight: 700 })
    expect(src('Brand', 400)).toEqual({ url: '/api/template-fonts/file/b4.otf', origin: 'uploaded', weight: 400 })
  })

  it('a system family has no source', () => {
    expect(makeFontSource([])('Helvetica', 400)).toBeNull()
  })

  it('a curated variable family is one file across its weight axis', () => {
    const s = makeFontSource([])('Inter', 700)!
    expect(s.origin).toBe('variable')
    expect(Array.isArray(s.weight)).toBe(true)
  })

  it('anything else is a Google static cut at that weight', () => {
    expect(makeFontSource([])('Lobster', 400)).toEqual({ url: '/api/fonts/google-file?family=Lobster&weight=400', origin: 'google', weight: 400 })
  })
})
```

The depth test's expected `IMG4096` is `imageToDataUrl(img, 4096, 'image/png')` — the gatherer encodes depth maps as PNG capped at 4096 px (a depth map must not be lossy).

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-gather.unit.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Move the font helpers out of Space Type**

Create `frontend/app/lib/embed/fontBytes.ts` containing `bufferToBase64` and `subsetFontBase64` copied from `SpaceTypeSurface.vue` (~lines 1735–1810, the functions of the same names), with two changes: both are `export`ed, and `subsetFontBase64` takes an optional third parameter `logTag = '[embed]'` used in place of the hard-coded `'[space-type] embed export:'` prefix in its `console.error` calls. Keep their doc comments. No Vue imports.

- [ ] **Step 4: Write the gatherer**

Create `frontend/app/lib/embed/frame/gather.ts`:

```ts
/**
 * Turns a FramePlan into a FrameSnapshot: every asset fetched once, re-encoded to the size it is
 * drawn at, and inlined as a data URL under the key the painter will ask for. Everything that
 * touches the browser or the server goes through `io`, so this file is unit-tested in node.
 *
 * Failure policy (spec, "Failure handling"): a missing image, font or shader BLOCKS the export
 * with a sentence naming it — it would otherwise ship a plausible wrong picture. A missing depth
 * map is LEFT OUT with a sentence: the layer then paints unblurred, exactly as the editor does
 * until a map arrives.
 */
import { imageLayerUrl } from '~/composables/useCompositorLayers'
import { clipFrameUrl, clipFrameKey } from '~/lib/compositor/clip'
import { shaderTextureUrl, shaderTextureKey } from '~/lib/shaderfill/field'
import { compositorFontToken } from '~/lib/compositor/textOutline'
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { FontWeightSpec } from '../fontFace'
import type { FramePlan } from './plan'
import { assetKey, type FrameFontAsset, type FrameFontOrigin, type FrameNotice, type FrameSnapshot, type FrameVariant, type WiredEntry } from './types'

export interface FontSource { url: string; origin: FrameFontOrigin; weight: FontWeightSpec }

export interface FrameExportIO {
  fetchBlob(url: string): Promise<Blob>
  blobToImage(blob: Blob): Promise<CanvasImageSource>
  imageToDataUrl(img: CanvasImageSource, maxPx: number, mime: 'image/webp' | 'image/png'): Promise<string>
  blobToDataUrl(blob: Blob): Promise<string>
  blobToBase64(blob: Blob): Promise<string>
  subsetFont(fontB64: string, text: string): Promise<string | null>
  fontSource(family: string, weight: number): FontSource | null
  wiredStill(slot: number): CanvasImageSource | null
  depthImage(ref: DepthRef): CanvasImageSource | null
  shaderDefs(ids: string[]): EffectDef[]
}

const ORIGIN_LABEL: Record<FrameFontOrigin, string> = {
  uploaded: 'uploaded', google: 'Google', library: 'library', variable: 'Google, variable',
}
const DEPTH_MAX_PX = 4096

/** Size of a data URL's payload, for the sheet. */
function dataUrlBytes(u: string): number {
  const i = u.indexOf(',')
  return i < 0 ? u.length : Math.floor((u.length - i - 1) * 3 / 4)
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function isBlocked(snapshot: FrameSnapshot): boolean {
  return snapshot.notices.some(n => n.group === 'blocked')
}

export async function buildFrameSnapshot(plan: FramePlan, variant: FrameVariant, io: FrameExportIO): Promise<FrameSnapshot> {
  const urls: Record<string, string> = {}
  const notices: FrameNotice[] = plan.notices.filter(n => n.group !== 'live')
  const liveNotices: FrameNotice[] = plan.notices.filter(n => n.group === 'live')
  const block = (text: string, layerId?: string) => notices.push({ group: 'blocked', text, ...(layerId ? { layerId } : {}) })

  for (const im of plan.images) {
    try {
      const img = await io.blobToImage(await io.fetchBlob(imageLayerUrl(im.filename)))
      urls[assetKey('image', im.filename)] = await io.imageToDataUrl(img, im.maxPx, 'image/webp')
    } catch { block(`The image "${im.filename}" couldn't be loaded.`) }
  }

  for (const c of plan.clips) {
    let bytes = 0
    try {
      for (let i = 0; i < c.clip.frames; i++) {
        const img = await io.blobToImage(await io.fetchBlob(clipFrameUrl(c.clip, i)))
        const u = await io.imageToDataUrl(img, c.maxPx, 'image/webp')
        urls[assetKey('clipFrame', clipFrameKey(c.clip, i))] = u
        bytes += dataUrlBytes(u)
      }
      liveNotices.push({ group: 'live', text: `Image clip · adds ${formatBytes(bytes)}`, layerId: c.layerId, bytes })
    } catch { block('An image clip is missing some of its frames.', c.layerId) }
  }

  for (const src of plan.fillImages) {
    try {
      const img = await io.blobToImage(await io.fetchBlob(src))
      urls[assetKey('fillImage', src)] = await io.imageToDataUrl(img, 2 * Math.max(variant.width, variant.height), 'image/webp')
    } catch { block('An image used as a fill couldn\'t be loaded.') }
  }

  const shaders = io.shaderDefs(plan.shaderIds)
  for (const id of plan.shaderIds) {
    if (!shaders.some(d => d.id === id)) block('A shader this Frame uses isn\'t available. Open Shader Studio once, then export again.')
  }
  for (const def of shaders) {
    for (const t of def.textures ?? []) {
      try { urls[assetKey('shaderTexture', shaderTextureKey(t.file, t.v))] = await io.blobToDataUrl(await io.fetchBlob(shaderTextureUrl(t.file, t.v))) }
      catch { block('A texture one of the shaders needs couldn\'t be loaded.') }
    }
  }

  // Fonts: one face per file+weight (a variable file serves every weight at once), text merged.
  const faces = new Map<string, { src: FontSource; family: string; text: string; outlineTokens: Set<string> }>()
  for (const f of plan.fonts) {
    const src = io.fontSource(f.family, f.weight)
    if (!src) continue // a system family: the viewer's browser has it
    const key = `${src.url}|${JSON.stringify(src.weight)}`
    const face = faces.get(key) ?? { src, family: f.family, text: '', outlineTokens: new Set<string>() }
    face.text += f.text
    if (f.outline) {
      const token = compositorFontToken({ fontFamily: f.family, fontWeight: f.weight })
      if (token) face.outlineTokens.add(token)
    }
    faces.set(key, face)
  }
  const fonts: FrameFontAsset[] = []
  for (const face of faces.values()) {
    try {
      const b64 = await io.blobToBase64(await io.fetchBlob(face.src.url))
      const subset = await io.subsetFont(b64, face.text)
      const dataUrl = `data:font/ttf;base64,${subset ?? b64}`
      fonts.push({ family: face.family, weight: face.src.weight, dataUrl, origin: face.src.origin })
      for (const token of face.outlineTokens) urls[assetKey('outlineFont', token)] = dataUrl
      notices.push({ group: 'fonts', text: `${face.family} · ${ORIGIN_LABEL[face.src.origin]}` })
    } catch { block(`The font "${face.family}" couldn't be loaded, so the export would draw the wrong typeface.`) }
  }

  const depth: FrameSnapshot['assets']['depth'] = []
  for (const d of plan.depth) {
    const img = io.depthImage(d.ref)
    if (img) depth.push({ ref: d.ref, dataUrl: await io.imageToDataUrl(img, DEPTH_MAX_PX, 'image/png') })
    else notices.push({ group: 'leftOut', text: `Depth blur on ${d.label} · needs a depth map`, layerId: d.layerId })
  }

  const wired: Record<number, WiredEntry> = {}
  for (const w of plan.wiredStills) {
    const src = io.wiredStill(w.slot)
    if (src) wired[w.slot] = { kind: 'still', dataUrl: await io.imageToDataUrl(src, w.maxPx, 'image/webp') }
  }

  return {
    version: 1, fit: plan.fit, duration: plan.duration, still: plan.still,
    variants: [variant], assets: { urls, fonts, shaders, depth }, wired,
    notices: [...notices.filter(n => n.group === 'fonts'), ...liveNotices, ...notices.filter(n => n.group !== 'fonts')],
  }
}
```

(The notice ordering puts fonts first, then live, then still / leftOut / blocked, which is the sheet's order. Note `blobToBase64` of the fake returns `'RkFMTA=='`, which is what the test asserts `subsetFont` receives.)

- [ ] **Step 5: Write the app IO**

Create `frontend/app/lib/embed/frame/appIO.ts`:

```ts
/** The app's real IO for buildFrameSnapshot. App-side only — never imported by the embed bundle. */
import { compositorFontToken } from '~/lib/compositor/textOutline'
import { parseVtFontToken, vtFontFileUrl } from '~/lib/vectortype/fontToken'
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { depthImageFor } from '~/lib/compositor/depthRegistry'
import type { UploadedFontEntry } from '~/composables/useUploadedFonts'
import type { EffectDef } from '~/lib/shaderfx/types'
import { bufferToBase64, subsetFontBase64 } from '../fontBytes'
import type { FontSource, FrameExportIO } from './gather'

export function makeFontSource(uploaded: UploadedFontEntry[]) {
  return (family: string, weight: number): FontSource | null => {
    const up = uploaded.find(f => f.family === family)
    if (up) {
      const w: '400' | '700' | null = weight >= 550
        ? (up.weights['700'] ? '700' : up.weights['400'] ? '400' : null)
        : (up.weights['400'] ? '400' : up.weights['700'] ? '700' : null)
      if (w) return { url: `/api/template-fonts/file/${encodeURIComponent(up.weights[w]!)}`, origin: 'uploaded', weight: Number(w) }
    }
    const token = compositorFontToken({ fontFamily: family, fontWeight: weight })
    if (!token) return null
    const ref = parseVtFontToken(token)
    if (!ref) return null
    const url = vtFontFileUrl(ref)
    if (!url) return null
    if (ref.kind === 'catalog') {
      const ax = VARIABLE_FONTS_BY_ID[ref.id]?.axes.find(a => a.tag === 'wght')
      return { url, origin: 'variable', weight: ax ? [ax.min, ax.max] : [100, 900] }
    }
    return { url, origin: ref.kind === 'local' ? 'library' : 'google', weight }
  }
}

function sizeOf(img: CanvasImageSource): { w: number; h: number } {
  const a = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  return { w: a.naturalWidth || Number(a.width) || 1, h: a.naturalHeight || Number(a.height) || 1 }
}

export function createAppFrameExportIO(opts: {
  uploaded: UploadedFontEntry[]
  wiredStill: (slot: number) => CanvasImageSource | null
  catalog: EffectDef[]
}): FrameExportIO {
  return {
    async fetchBlob(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return res.blob()
    },
    blobToImage: blob => createImageBitmap(blob),
    async imageToDataUrl(img, maxPx, mime) {
      const { w, h } = sizeOf(img)
      const k = Math.min(1, maxPx / Math.max(w, h))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL(mime, 0.9)
    },
    blobToDataUrl: blob => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob)
    }),
    blobToBase64: async blob => bufferToBase64(await blob.arrayBuffer()),
    subsetFont: (b64, text) => subsetFontBase64(b64, text, '[frame] web export:'),
    fontSource: makeFontSource(opts.uploaded),
    wiredStill: opts.wiredStill,
    depthImage: ref => depthImageFor(ref),
    shaderDefs: ids => opts.catalog.filter(d => ids.includes(d.id)),
  }
}
```

Check `UploadedFontEntry` is exported from `useUploadedFonts.ts` (it is, line 10). Importing that file only for a type is erased at build.

- [ ] **Step 6: Point Space Type at the shared helpers**

First run `git diff --stat -- frontend/app/components/vue-canvas/SpaceTypeSurface.vue`. **If it shows changes you did not make, skip this step**, note it in your report, and move on — another session owns that file right now.

Otherwise: in `SpaceTypeSurface.vue` delete the local `bufferToBase64` and `subsetFontBase64` functions and add `import { bufferToBase64, subsetFontBase64 } from '~/lib/embed/fontBytes'`. Its calls to `subsetFontBase64(fontB64, text)` gain the tag argument `'[space-type] embed export:'` so its log lines read exactly as before. Then run `cd frontend && npx vitest run tests/unit/embed-spacetype.unit.spec.ts` — PASS.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-gather.unit.spec.ts tests/unit/frame-embed-plan.unit.spec.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Paths: `frontend/app/lib/embed/fontBytes.ts frontend/app/lib/embed/frame/gather.ts frontend/app/lib/embed/frame/appIO.ts frontend/tests/unit/frame-embed-gather.unit.spec.ts` plus `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` if Step 6 ran.
Message: `feat(embed): gather a Frame's assets into one snapshot — images at drawn size, clips as WebP, fonts subsetted, a named reason whenever something is missing`

---

### Task 5: The embed runtime learns "fill the box", poster fit, stills and a backdrop colour

**Files:**
- Create: `frontend/app/lib/embed/frame/fit.ts`
- Modify: `frontend/app/lib/embed/contract.ts` (`EmbedSnapshot`)
- Modify: `frontend/app/lib/embed/bundle.ts` (`buildEmbedHtml`)
- Modify: `frontend/app/lib/embed/export.ts` (`ExportEmbedOptions`, `exportEmbedHtml`)
- Test: `frontend/tests/unit/frame-embed-runtime.unit.spec.ts`

**Interfaces:**
- Produces:
  - `fitRect(box: { w: number; h: number }, art: { w: number; h: number }, mode: FrameFit): { x: number; y: number; w: number; h: number; scale: number }`
  - `EmbedSnapshot` gains optional `framing?: 'contain' | 'box'`, `posterFit?: 'contain' | 'cover'`, `still?: boolean`, `backdrop?: string`
  - `ExportEmbedOptions` gains the same four optional fields; `exportEmbedHtml` copies each into the snapshot **only when defined**, so an existing export's snapshot JSON is unchanged.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/frame-embed-runtime.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fitRect } from '~/lib/embed/frame/fit'
import { buildEmbedHtml } from '~/lib/embed/bundle'
import type { EmbedSnapshot } from '~/lib/embed/contract'

const base: EmbedSnapshot = {
  kind: 'shader', config: {}, duration: 4, width: 200, height: 100,
  posterDataUrl: 'data:image/png;base64,AA', transparent: false,
}
const snapJson = (html: string) => JSON.parse(/window\.__SAILOR_SNAPSHOT__ = (.*);\n/.exec(html)![1]!)

describe('fitRect', () => {
  it('fit: contained and centred', () => {
    expect(fitRect({ w: 400, h: 100 }, { w: 200, h: 100 }, 'fit')).toEqual({ x: 100, y: 0, w: 200, h: 100, scale: 1 })
  })
  it('fill: covers and crops the overflow evenly', () => {
    expect(fitRect({ w: 400, h: 100 }, { w: 200, h: 100 }, 'fill')).toEqual({ x: 0, y: -50, w: 400, h: 200, scale: 2 })
  })
  it('same shape: identity at the box scale', () => {
    expect(fitRect({ w: 400, h: 200 }, { w: 200, h: 100 }, 'fit')).toEqual({ x: 0, y: 0, w: 400, h: 200, scale: 2 })
  })
})

describe('buildEmbedHtml options', () => {
  it('a snapshot without the new fields carries none of them', () => {
    const j = snapJson(buildEmbedHtml(base, 'globalThis.__SAILOR_SURFACE__={}'))
    for (const k of ['framing', 'posterFit', 'still', 'backdrop']) expect(k in j).toBe(false)
  })

  it('the runtime hands a box-framed adapter the whole box', () => {
    const html = buildEmbedHtml({ ...base, framing: 'box' }, '')
    expect(html).toContain("snap.framing === 'box'")
  })

  it('cover poster fit is applied, anything else is contain', () => {
    expect(buildEmbedHtml({ ...base, posterFit: 'cover' }, '')).toContain('object-fit:cover')
    expect(buildEmbedHtml({ ...base, posterFit: 'nonsense' as any }, '')).toContain('object-fit:contain')
  })

  it('a still renders once and never starts the clock', () => {
    expect(buildEmbedHtml({ ...base, still: true }, '')).toContain('snap.still')
  })

  it('a hex backdrop colours the page; anything else falls back to black', () => {
    expect(buildEmbedHtml({ ...base, backdrop: '#12ab34' }, '')).toContain('background:#12ab34')
    const evil = buildEmbedHtml({ ...base, backdrop: 'red}</style><script>' }, '')
    expect(evil).toContain('background:#000')
    expect(evil).not.toContain('red}</style>')
  })

  it('transparent still wins over a backdrop', () => {
    expect(buildEmbedHtml({ ...base, transparent: true, backdrop: '#fff' }, '')).toContain('background:transparent')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-runtime.unit.spec.ts`
Expected: FAIL — `~/lib/embed/frame/fit` not found; the option assertions fail.

- [ ] **Step 3: Write `fit.ts`**

```ts
import type { FrameFit } from './types'

/** Where the artboard lands inside a box. `fit` keeps the whole Frame visible; `fill` covers the
 *  box and crops the overflow evenly (centred — no focal point in v1). `scale` maps artboard
 *  units to box pixels. Pure; used by the adapter every paint. */
export function fitRect(
  box: { w: number; h: number }, art: { w: number; h: number }, mode: FrameFit,
): { x: number; y: number; w: number; h: number; scale: number } {
  const sx = box.w / art.w
  const sy = box.h / art.h
  const scale = mode === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy)
  const w = art.w * scale
  const h = art.h * scale
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h, scale }
}
```

- [ ] **Step 4: Extend the contract and the runtime**

In `contract.ts`, add to `EmbedSnapshot` (each with a one-line doc): `framing?: 'contain' | 'box'` ("'box' hands the adapter the page's whole box; it frames the piece itself"), `posterFit?: 'contain' | 'cover'`, `still?: boolean` ("nothing moves: render one frame, never start the clock"), `backdrop?: string` ("a #hex colour behind the stage when not transparent").

In `bundle.ts` `buildEmbedHtml`:
- replace `const bg = …` with
  ```ts
  const backdrop = typeof snapshot.backdrop === 'string' && /^#[0-9a-f]{3,8}$/i.test(snapshot.backdrop) ? snapshot.backdrop : '#000'
  const bg = snapshot.transparent ? 'transparent' : backdrop
  const posterFit = snapshot.posterFit === 'cover' ? 'cover' : 'contain'
  ```
- in the `<style>`, change the poster rule's `object-fit:contain` to `object-fit:${posterFit}`;
- at the top of the runtime's `fit()` function body insert:
  ```js
    if (snap.framing === 'box') {
      var fw = box.clientWidth || snap.width, fh = box.clientHeight || snap.height;
      stage.style.width = fw + 'px';
      stage.style.height = fh + 'px';
      return [Math.max(1, Math.round(fw * dpr)), Math.max(1, Math.round(fh * dpr))];
    }
  ```
- change `if (frozen !== null || reduce) {` to `if (frozen !== null || reduce || snap.still) {`.
- Update the "Framing policy" comment above the template with one paragraph on `'box'`: the adapter is handed the whole box and frames the piece itself (Frame's fit and fill), so the background can reach the box's edges.

In `export.ts`, add the four optional fields to `ExportEmbedOptions` and, after building `snapshot`, copy each that is defined:

```ts
  if (opts.framing !== undefined) snapshot.framing = opts.framing
  if (opts.posterFit !== undefined) snapshot.posterFit = opts.posterFit
  if (opts.still !== undefined) snapshot.still = opts.still
  if (opts.backdrop !== undefined) snapshot.backdrop = opts.backdrop
```

- [ ] **Step 5: Run the new test and every existing embed unit spec**

Run: `cd frontend && npx vitest run tests/unit/frame-embed-runtime.unit.spec.ts tests/unit/embed-bundle.unit.spec.ts tests/unit/embed-clock.unit.spec.ts tests/unit/embed-registry.unit.spec.ts tests/unit/embed-spacetype.unit.spec.ts`
Expected: PASS.

Then, with the `:3002` server up (check first; do not start one): `cd frontend && PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/embed-export.spec.ts tests/embed-parity.spec.ts --project=chromium`
Expected: PASS — existing exports behave exactly as before.

- [ ] **Step 6: Typecheck and commit**

Paths: `frontend/app/lib/embed/frame/fit.ts frontend/app/lib/embed/contract.ts frontend/app/lib/embed/bundle.ts frontend/app/lib/embed/export.ts frontend/tests/unit/frame-embed-runtime.unit.spec.ts`
Message: `feat(embed): the runtime can hand an adapter the whole box, fit the poster to cover, hold a still, and colour the page behind it`

---

### Task 6: The Frame adapter and its bundle

**Files:**
- Create: `frontend/app/lib/embed/surfaces/frame.ts`
- Create: `frontend/app/lib/embed/entry-frame.ts`
- Create: `frontend/app/lib/embed/frame/depthRequest.embed.ts`
- Create: `frontend/scripts/embed-cone.mjs`
- Modify: `frontend/app/lib/embed/surfaces.ts` (registry)
- Modify: `frontend/app/lib/embed/bundle.ts` (`INERT_LITERALS`)
- Modify: `frontend/vite.embed.config.ts` (alias + plugin)
- Modify: `frontend/scripts/build-embed.mjs`, `frontend/scripts/embed-build-cache.mjs`
- Modify: `frontend/tests/unit/embed-build-output.unit.spec.ts` (a `frame.js` size bucket)
- Test: `frontend/tests/unit/embed-frame-cone.unit.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `paintLayerStack`, `ensureLayerImages`, `withWiredContent`, `StackItem`, `LocalLayer` (useCompositorLayers); `whenFieldEffectReady` (field.ts); `ensureRevealShadersReady` (motionx/reveal/paintPixels); `seedDepthImage` (Task 2); `addShaderFxEffects` (Task 2); `fontFaceRule`, `fontFaceId` (Task 2).
- Produces:
  - `export default frameSurface: EmbedSurface` with `kind: 'frame'`, `caps.alpha: true`; `mount(container, snapshot: FrameSnapshot)`.
  - `export function stackItemsFor(v: FrameVariant): StackItem[]`
  - `export function embedCone(entries: string[]): { files: string[]; bare: string[] }` (scripts/embed-cone.mjs, paths relative to `frontend/`)

- [ ] **Step 1: Commit the cone walker and write the failing guard test**

Create `frontend/scripts/embed-cone.mjs`:

```js
// Walks the VALUE-import graph of an embed entry (type-only imports are erased and skipped) and
// returns every first-party file it reaches plus the bare packages it names. Used by
// tests/unit/embed-frame-cone.unit.spec.ts to prove (a) the build cache hashes every file a bundle
// is made from, and (b) nothing Vue- or Nuxt-shaped is reachable. Resolves `~/`, `~~/` and
// relative specifiers the way vite.embed.config.ts's aliases do.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = path.join(ROOT, 'app')
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

function resolve(from, spec, bare) {
  let p
  if (spec.startsWith('~~/')) p = path.join(ROOT, spec.slice(3))
  else if (spec.startsWith('~/')) p = path.join(APP, spec.slice(2))
  else if (spec.startsWith('.')) p = path.join(path.dirname(from), spec)
  else { bare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]); return null }
  for (const c of [p, `${p}.ts`, `${p}/index.ts`, `${p}.js`, `${p}.mjs`, `${p}.json`]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

export function embedCone(entries) {
  const seen = new Set()
  const bare = new Set()
  const walk = (f) => {
    if (seen.has(f)) return
    seen.add(f)
    if (!/\.(ts|js|mjs)$/.test(f)) return
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolve(f, m[1] || m[2] || m[3], bare)
      if (r) walk(r)
    }
  }
  for (const e of entries) walk(path.join(ROOT, e))
  return { files: [...seen].map(f => path.relative(ROOT, f)).sort(), bare: [...bare].sort() }
}
```

Create `frontend/tests/unit/embed-frame-cone.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { embedCone } from '../../scripts/embed-cone.mjs'
import { EMBED_INPUT_DIRS, EMBED_INPUT_FILES } from '../../scripts/embed-build-cache.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const cone = embedCone(['app/lib/embed/entry-frame.ts'])

describe('the Frame bundle\'s import cone', () => {
  it('is non-trivial (the walker actually walked)', () => {
    expect(cone.files).toContain('app/composables/useCompositorLayers.ts')
    expect(cone.files.length).toBeGreaterThan(100)
  })

  it('every file it is built from is hashed by the build cache', () => {
    const covered = (f: string) =>
      EMBED_INPUT_FILES.includes(f) || EMBED_INPUT_DIRS.some((d: string) => f === d || f.startsWith(`${d}/`))
    expect(cone.files.filter(f => !covered(f))).toEqual([])
  })

  it('names no package beyond the two it is known to need', () => {
    expect(cone.bare.filter(b => !['fontkit', 'paper'].includes(b))).toEqual([])
  })

  it('reaches no Vue or Nuxt code', () => {
    const offenders = cone.files.filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return /from\s+['"]vue['"]|from\s+['"]#imports['"]|\$fetch\(|useRuntimeConfig\(/.test(
        src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\s+type\b/.test(l)).join('\n'))
    })
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/embed-frame-cone.unit.spec.ts`
Expected: FAIL — `entry-frame.ts` does not exist, so the cone is empty.

- [ ] **Step 3: Write the adapter and entry**

Create `frontend/app/lib/embed/surfaces/frame.ts`:

```ts
/**
 * The Frame as an embeddable surface. Ships the editor's own painter (paintLayerStack) unchanged;
 * everything it would fetch comes from the snapshot through the asset resolver chain
 * (~/lib/compositor/assetScope), which is registered for the life of the handle — so it also
 * covers the poster bake, which runs this adapter inside the app.
 *
 * Mount does every await: fonts, shaders and their textures, depth maps, images, clip frames and
 * the transitions' shaders. setTime is one synchronous paint. A font or shader that fails REJECTS
 * the mount — the runtime then keeps the poster, which is a correct still, never a wrong picture.
 *
 * Fit and bleed without touching the painter: the background is painted once across the whole
 * box (a paintLayerStack call with no layers, sized to the box in artboard units), then the layers
 * are painted under the fit transform with no background. Post effects already work on the whole
 * device canvas (applyStackPost), so they cover the bleed too.
 */
import type { EmbedHandle, EmbedSurface } from '../contract'
import { assetKey, type FrameSnapshot, type FrameVariant } from '../frame/types'
import { fitRect } from '../frame/fit'
import { fontFaceId, fontFaceRule } from '../fontFace'
import { registerAssetResolver } from '~/lib/compositor/assetScope'
import { addShaderFxEffects } from '~/lib/shaderfx/catalogStore'
import { whenFieldEffectReady } from '~/lib/shaderfill/field'
import { seedDepthImage } from '~/lib/compositor/depthRegistry'
import { ensureRevealShadersReady } from '~/lib/motionx/reveal/paintPixels'
import {
  paintLayerStack, ensureLayerImages, withWiredContent, type LocalLayer, type StackItem,
} from '~/composables/useCompositorLayers'
import '~/lib/motion/paint' // registers the per-layer animation painter paintLayerStack relies on

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('embed: an inlined image failed to decode'))
    im.src = src
  })
}

/** The stack the painter draws, in the Frame's saved order. Only `l:` keys exist in a migrated
 *  Frame; the planner refuses a snapshot holding a legacy `w:` key. */
export function stackItemsFor(v: FrameVariant): StackItem[] {
  const byId = new Map(v.layers.map(l => [l.id, l]))
  const out: StackItem[] = []
  for (const key of v.stackOrder) {
    if (!key.startsWith('l:')) continue
    const layer = byId.get(key.slice(2))
    if (layer) out.push({ type: 'local', key, layer })
  }
  return out
}

const frameSurface: EmbedSurface = {
  kind: 'frame',
  // Genuinely true: with no background the painter never fills, so the canvas keeps its
  // transparent pixels. The sheet only offers a transparent export when the background is empty.
  caps: { alpha: true },

  async mount(container: HTMLElement, config: unknown): Promise<EmbedHandle> {
    const snap = config as FrameSnapshot
    const v = snap.variants?.[0]
    if (!v) throw new Error('embed: frame snapshot has no variant')
    const urls = snap.assets.urls
    const unregister = registerAssetResolver((kind, key) => urls[assetKey(kind, key)] ?? null)
    const styles: HTMLStyleElement[] = []
    const cleanup = () => { unregister(); for (const s of styles) s.remove() }

    try {
      for (const f of snap.assets.fonts) {
        const el = document.createElement('style')
        el.dataset.sailorEmbedFont = fontFaceId(f.family, f.weight)
        el.textContent = fontFaceRule(f)
        document.head.appendChild(el)
        styles.push(el)
      }
      for (const f of snap.assets.fonts) {
        const w = typeof f.weight === 'number' ? f.weight : f.weight[0]
        const faces = await document.fonts.load(`${w} 16px '${f.family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
        if (!faces.length) throw new Error(`embed: font "${f.family}" did not load`)
      }
      await document.fonts.ready

      addShaderFxEffects(snap.assets.shaders)
      const ready = await Promise.all(snap.assets.shaders.map(d => whenFieldEffectReady(d.id)))
      if (!ready.every(Boolean)) throw new Error('embed: a shader did not become ready')

      for (const d of snap.assets.depth) seedDepthImage(d.ref, await loadImage(d.dataUrl))

      const stills = new Map<number, HTMLImageElement>()
      for (const [slot, entry] of Object.entries(snap.wired ?? {})) stills.set(Number(slot), await loadImage(entry.dataUrl))

      const layers = v.layers as LocalLayer[]
      await ensureLayerImages(layers, { keep: true })
      if (!(await ensureRevealShadersReady(v.motion?.behaviours))) throw new Error('embed: a transition shader did not become ready')

      const canvas = document.createElement('canvas')
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.width = Math.max(1, Math.round(v.width))
      canvas.height = Math.max(1, Math.round(v.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('embed: no 2D context')

      const items = stackItemsFor(v)
      const provider = (slot: number) => stills.get(slot) ?? null
      let lastT = 0

      const paint = (t01: number) => {
        lastT = t01
        const tSec = t01 * snap.duration
        const r = fitRect({ w: canvas.width, h: canvas.height }, { w: v.width, h: v.height }, snap.fit)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (v.background != null) {
          ctx.setTransform(r.scale, 0, 0, r.scale, 0, 0)
          paintLayerStack(ctx, canvas.width / r.scale, canvas.height / r.scale, [], [],
            undefined, tSec, undefined, undefined, v.background, undefined, undefined, true)
        }
        ctx.setTransform(r.scale, 0, 0, r.scale, r.x, r.y)
        withWiredContent(provider, () => paintLayerStack(ctx, v.width, v.height, items, layers,
          undefined, tSec, v.motion ?? undefined, v.wiredTreatments, undefined, v.groups, v.post, true))
      }

      container.appendChild(canvas)
      paint(0)

      return {
        setTime: paint,
        setSize(w: number, h: number) {
          canvas.width = Math.max(1, Math.round(w))
          canvas.height = Math.max(1, Math.round(h))
          paint(lastT)
        },
        destroy() { canvas.remove(); cleanup() },
      }
    } catch (err) {
      cleanup()
      throw err
    }
  },
}

export default frameSurface
```

Create `frontend/app/lib/embed/entry-frame.ts`:

```ts
import surface from './surfaces/frame'

// The embed runtime in bundle.ts looks for exactly this global.
;(globalThis as any).__SAILOR_SURFACE__ = surface
```

In `surfaces.ts` add `frame: () => import('./surfaces/frame'),` to `REGISTRY`. `bundleNameFor` needs no change (identity for `frame`).

Create `frontend/app/lib/embed/frame/depthRequest.embed.ts`:

```ts
/** Embed-build stand-in for ~/lib/compositor/depthRequest (aliased in vite.embed.config.ts).
 *  An exported file has no server to estimate depth, and must not carry that route: a depth map
 *  the editor had ships in the snapshot and is seeded at mount; anything else paints unblurred. */
import type { DepthEstimate } from '~/lib/compositor/depthRequest'

export async function requestDepthEstimate(): Promise<DepthEstimate> {
  return { ok: false, message: 'depth estimation is not available in an exported file' }
}
```

- [ ] **Step 4: Teach the build about the Frame**

In `vite.embed.config.ts`:
- add, inside `resolve.alias` **before** the `~` entry (Vite matches aliases in order, and `~` would otherwise win):
  ```ts
      '~/lib/compositor/depthRequest': fileURLToPath(new URL('./app/lib/embed/frame/depthRequest.embed.ts', import.meta.url)),
  ```
  `resolve.alias` is an object today; convert it to the array form so the order is explicit: `[{ find: '~/lib/compositor/depthRequest', replacement: … }, { find: '~~', replacement: … }, { find: '~', replacement: … }]`. `depthRegistry.ts` imports it by that exact alias path (Task 2), so this one entry covers it.
- add a plugin beside `pruneShaderCatalogPlugin`, and include it in `plugins`:
  ```ts
  // app/data/variable-fonts.ts carries a Google Fonts CSS URL per curated family (`cssUrl`), for
  // the app's font previews. Nothing on the render path reads it — the painter loads variable
  // files through its own proxy route, and an export inlines them — but the literal would fail
  // the export's network scan. Blank the field, at embed-build time only.
  function stripVariableFontCssUrlsPlugin(): Plugin {
    return {
      name: 'sailor-embed-strip-variable-font-css-urls',
      enforce: 'pre',
      transform(code, id) {
        if (!id.replace(/\\/g, '/').endsWith('app/data/variable-fonts.ts')) return undefined
        let n = 0
        const out = code.replace(/cssUrl:\s*'https:\/\/[^']*'/g, () => { n++; return "cssUrl: ''" })
        if (n === 0) throw new Error('sailor-embed: found no cssUrl literals in variable-fonts.ts — update stripVariableFontCssUrlsPlugin')
        return { code: out, map: null }
      },
    }
  }
  ```

In `bundle.ts` add to `INERT_LITERALS`, with the same style of comment as its neighbours:

```ts
  // ~/lib/vector/svg.ts writes the SVG namespace into the `xmlns` attribute of SVG it serialises
  // (the Frame painter's cone reaches this module for path-data helpers). A namespace identifier
  // compared as a string, never fetched.
  'http://www.w3.org/2000/svg',
```

In `scripts/build-embed.mjs`: add `'frame.js'` to `expectedOutputs` and `runBuild('frame')` after `runBuild('gradient')`; update the final log line to name frame.

In `scripts/embed-build-cache.mjs`: add to `EMBED_INPUT_DIRS` — `'app/composables'`, `'app/lib/frame'`, `'app/lib/motion'`, `'app/lib/motionx'`, `'app/lib/paint'`, `'app/lib/scene3d'`, `'app/lib/shapes'`, `'app/lib/vary'`, `'app/lib/vectortype'`. (Measured 2026-09-22 with the walker; the guard test keeps this list honest from now on.)

- [ ] **Step 5: Build and run the guard test**

Run: `cd frontend && npx vitest run tests/unit/embed-frame-cone.unit.spec.ts`
Expected: PASS. If "every file … hashed" lists files, add their folders to `EMBED_INPUT_DIRS` (never delete the test's assertion).

Run: `cd frontend && SAILOR_EMBED_SURFACE=frame npx vite build --config vite.embed.config.ts && ls -la public/embed/frame.js`
Expected: build succeeds, `frame.js` exists. Record its size in bytes.

Then: `cd frontend && node -e "import('./app/lib/embed/bundle.ts').catch(()=>0)"` is not how to scan — instead run the existing output test after adding the bucket (next step).

- [ ] **Step 6: Give `frame.js` a size bucket**

In `tests/unit/embed-build-output.unit.spec.ts`, add `const FRAME_CEILING_BYTES = <measured × 1.15, rounded up to the next 10,000>` with a comment in this file's own style: the measured size and date, and what dominates it (look at the bundle: `grep -o 'fontkit\|paper' public/embed/frame.js | sort | uniq -c` and note the painter's ~48k source lines, fontkit and paper). Add the `frame.js` case to the bucket classifier (it throws on unknown names — that is the point).

Run: `cd frontend && npx vitest run tests/unit/embed-build-output.unit.spec.ts`
Expected: PASS — including its network-reference scan over `frame.js`. If the scan reports a literal, apply the rule: **data that is never fetched** → an exact `INERT_LITERALS` entry with the source line cited; **code that makes a request** → move it behind its own module and alias that module in the embed build, as done for the depth request. Never loosen a scan pattern.

- [ ] **Step 7: Run the whole embed build and existing suites**

Run: `cd frontend && npm run build:embed -- --force` (all bundles), then `npx vitest run $(ls tests/unit/embed-*.unit.spec.ts tests/unit/frame-embed-*.unit.spec.ts)`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

`public/embed/` build output is not committed if it is gitignored — check `git check-ignore -q frontend/public/embed/frame.js && echo ignored`. Commit only sources.

Paths: `frontend/app/lib/embed/surfaces/frame.ts frontend/app/lib/embed/entry-frame.ts frontend/app/lib/embed/frame/depthRequest.embed.ts frontend/app/lib/embed/surfaces.ts frontend/app/lib/embed/bundle.ts frontend/vite.embed.config.ts frontend/scripts/embed-cone.mjs frontend/scripts/build-embed.mjs frontend/scripts/embed-build-cache.mjs frontend/tests/unit/embed-frame-cone.unit.spec.ts frontend/tests/unit/embed-build-output.unit.spec.ts`
Message: `feat(embed): the Frame adapter and its bundle — the editor's painter, fed from the snapshot, with a guard that the build cache hashes everything it is made from`

---

### Task 7: Harness page, contract and zero-network tests

**Files:**
- Create: `frontend/app/pages/dev/frame-embed-harness.vue`
- Create: `frontend/tests/_frameEmbedHelpers.ts`
- Create: `frontend/tests/frame-embed-contract.spec.ts`
- Create: `frontend/tests/frame-embed-network.spec.ts`

**Interfaces:**
- Consumes: the adapter (Task 6), planner and gatherer (Tasks 3–4), `createAppFrameExportIO` (Task 4), `exportEmbedHtml` (existing), `fetchShaderFxCatalog` (existing, `~/lib/shaderfx/catalog`).
- Produces — `window.__frameEmbedHarness` on `/dev/frame-embed-harness`, ready when `window.__frameEmbedHarnessReady === true`:

```ts
{
  fixtures: string[]                                         // ['vector', 'image', 'backdrop', 'still']
  snapshot(name: string, over?: { fit?: 'fit' | 'fill' }): Promise<FrameSnapshot>
  mount(slot: 'a' | 'b', snap: FrameSnapshot): Promise<boolean>
  setTime(slot, t01: number): void
  setSize(slot, w: number, h: number): void
  destroy(slot): void
  pixels(slot): string                                       // canvas.toDataURL()
  canvasCount(slot): number
  reference(name: string, t01: number, w: number, h: number): Promise<string>   // Task 8
  exportHtml(snap: FrameSnapshot): Promise<string>
}
```
- Produces — `tests/_frameEmbedHelpers.ts`:

```ts
export async function openHarness(page: Page): Promise<void>
export async function renderExported(context: BrowserContext, html: string, t01: number, viewport: { width: number; height: number }): Promise<{ png: string; requests: string[] }>
export async function pixelDiff(page: Page, a: string, b: string): Promise<{ differing: number; total: number }>
```

- [ ] **Step 1: Check the server**

Run: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/`
Expected: `200`. If not, stop and report. Do not start a server.

- [ ] **Step 2: Write the harness page**

Create `frontend/app/pages/dev/frame-embed-harness.vue`. Model it on `pages/dev/embed-harness.vue` (read it first): `definePageMeta({ layout: false })`, everything that touches `document` inside `onMounted`, two slots `<div id="slot-a" style="width:600px;height:300px">` and `slot-b`.

Fixtures (all synthetic, so no ComfyUI file is needed):
- **`vector`** — 1000×500 artboard; background a two-stop linear gradient (use a `Gradient` paint — copy the shape from any existing gradient fixture in `tests/unit`, e.g. `grep -rl "type: 'linear'" frontend/tests/unit | head -1`); a rect layer whose `fill` is `{ ...DEFAULT_FILL, type: 'shader', shader: { effectId: <id>, params: {}, anchor: 'object', speed: 1, seed: 42, input: '#000000' } }` (`DEFAULT_FILL` from `~/lib/spacetype/fillTile`), `<id>` being the first **generative, texture-free** catalog effect (same selection rule as `embed-harness.vue`); a text layer "Decode me #1" in family `Harness Font` weight 700; motion `{ fps: 30, duration: 4, motionx: [{ path: 'layers.<rectId>.x', type: 'number', keyframes: [{ t: 0, value: 0.3, ease: 'linear' }, { t: 4, value: 0.7, ease: 'linear' }] }], behaviours: [{ id: 'b1', layerId: <textId>, kind: 'text.decode', timing: { start: 0, duration: 3 }, params: { charset: 'symbols' } }] }`.
- **`image`** — an image layer `harness-photo.png` (w 0.5, h 0.375) with `blend: 'multiply'` over a solid `#f0c040` background; an image layer `harness-rose.png` carrying `clip: { dir: 'harness-clip', frames: 6, fps: 6, speed: 1, prompt: '', model: '' }`.
- **`backdrop`** — solid `#202020` background; eight vertical stripe rects; one rect on top whose `effects` is `[{ ...createEffect('backdrop_shader'), effectId: <first catalog id with effectReadsInput(id)>, visible: true }]`, and one whose `effects` is `[{ ...createEffect('long_shadow'), visible: true }]` (`createEffect` from `~/lib/compositor/effectStack`).
- **`still`** — solid background, one text layer, no motion.

Synthetic assets: in `onMounted`, draw `harness-photo.png` (800×600: a smooth radial gradient with three soft-edged discs — no noise, because lossy re-encoding of noise would swamp any pixel comparison) and six `harness-clip` frames (400×400: a disc at six positions) onto canvases and keep their PNG data URLs in a map. Build the harness IO as `createAppFrameExportIO(...)` with three overrides:
- `fetchBlob(url)`: if the URL names `harness-photo.png`, `harness-rose.png` or subfolder `harness-clip`, return the matching PNG as a Blob (`await (await fetch(dataUrl)).blob()`); otherwise delegate to the real `fetchBlob` (fonts, shader textures).
- `fontSource(family, weight)`: `family === 'Harness Font'` → `{ url: '/fonts/ABCROM-Bold.otf', origin: 'uploaded', weight: 700 }`; otherwise the real one.
- `wiredStill`: `() => null`.

Load the shader catalog once with `fetchShaderFxCatalog()` and pass `catalog: cat.effects` and `catalogIds: new Set(cat.effects.map(e => e.id))` to the planner. `snapshot(name, over)` builds the fixture's `FrameVariant`, runs `planFrameExport` (`hasMotion` true for `vector`, false otherwise; `animatedFill` false) then `buildFrameSnapshot`. `exportHtml(snap)` calls `exportEmbedHtml({ kind: 'frame', config: snap, duration: snap.duration, width: v.width, height: v.height, framing: 'box', posterFit: snap.fit === 'fill' ? 'cover' : 'contain', still: snap.still })`.

`mount(slot, snap)` uses `loadEmbedSurface('frame')` and keeps the handle; returns `true` on success, `false` on rejection. `reference` is left as `async () => ''` in this task (Task 8 fills it).

- [ ] **Step 3: Write the helpers**

Create `frontend/tests/_frameEmbedHelpers.ts`:

```ts
import { expect, type BrowserContext, type Page } from '@playwright/test'

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/dev/frame-embed-harness')
  await page.waitForFunction(() => (window as any).__frameEmbedHarnessReady === true, undefined, { timeout: 30_000 })
}

/** Loads an exported file in a FRESH page (its own document: its own fonts, its own module state),
 *  freezes it at `t01`, and returns the live canvas plus every request the file made. Mirrors
 *  tests/embed-parity.spec.ts: the freeze flag must be a context init script, not a page one. */
export async function renderExported(
  context: BrowserContext, html: string, t01: number, viewport: { width: number; height: number },
): Promise<{ png: string; requests: string[] }> {
  await context.addInitScript((t: number) => { (window as any).__SAILOR_FREEZE_T01__ = t }, t01)
  const p = await context.newPage()
  const requests: string[] = []
  p.on('request', r => { const u = r.url(); if (!u.startsWith('data:') && u !== 'about:blank') requests.push(u) })
  p.on('websocket', ws => requests.push(`ws:${ws.url()}`))
  await p.setViewportSize(viewport)
  await p.setContent(html)
  await p.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 30_000 })
  expect(await p.locator('#sailor-poster').isHidden()).toBe(true)   // the LIVE path ran, not the poster
  const png = await p.evaluate(() => (document.querySelector('#sailor-embed canvas') as HTMLCanvasElement).toDataURL())
  await p.close()
  return { png, requests }
}

/** Pixels whose any channel differs by more than `threshold` levels (default 2). Sizes must match;
 *  a size mismatch returns differing = -1. */
export async function pixelDiff(page: Page, a: string, b: string, threshold = 2): Promise<{ differing: number; total: number }> {
  return await page.evaluate(async ([x, y, th]) => {
    const load = (u: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [ia, ib] = await Promise.all([load(x!), load(y!)])
    if (ia.width !== ib.width || ia.height !== ib.height) return { differing: -1, total: 0 }
    const data = (i: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
      const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data
    }
    const da = data(ia), db = data(ib)
    let differing = 0
    for (let p = 0; p < da.length; p += 4) {
      if (Math.abs(da[p]! - db[p]!) > th || Math.abs(da[p + 1]! - db[p + 1]!) > th
        || Math.abs(da[p + 2]! - db[p + 2]!) > th || Math.abs(da[p + 3]! - db[p + 3]!) > th) differing++
    }
    return { differing, total: da.length / 4 }
  }, [a, b, threshold] as const)
}
```

- [ ] **Step 4: Write the contract spec**

Create `frontend/tests/frame-embed-contract.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { openHarness } from './_frameEmbedHelpers'

// Requires the shared dev server: PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-embed-contract.spec.ts --project=chromium
test.describe('Frame embed — contract', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  test('mount puts one canvas in the container; destroy removes it', async ({ page }) => {
    const [mounted, before, after] = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const ok = await H.mount('a', await H.snapshot('vector'))
      const n = H.canvasCount('a'); H.destroy('a')
      return [ok, n, H.canvasCount('a')]
    })
    expect(mounted).toBe(true)
    expect(before).toBe(1)
    expect(after).toBe(0)
  })

  test('setTime moves a Frame with motion', async ({ page }) => {
    const [a, b] = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      await H.mount('a', await H.snapshot('vector'))
      H.setTime('a', 0.1); const x = H.pixels('a')
      H.setTime('a', 0.6); const y = H.pixels('a')
      return [x, y]
    })
    expect(a).not.toBe(b)
  })

  test('setSize resizes the canvas', async ({ page }) => {
    const dims = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      await H.mount('a', await H.snapshot('vector'))
      H.setSize('a', 640, 200)
      const c = document.querySelector('#slot-a canvas') as HTMLCanvasElement
      return [c.width, c.height]
    })
    expect(dims).toEqual([640, 200])
  })

  test('two Frames on one page each draw what they draw alone', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const vec = await H.snapshot('vector'), img = await H.snapshot('image')
      await H.mount('a', vec); H.setTime('a', 0.37); const vecAlone = H.pixels('a'); H.destroy('a')
      await H.mount('a', img); H.setTime('a', 0.37); const imgAlone = H.pixels('a'); H.destroy('a')
      await H.mount('a', vec); await H.mount('b', img)
      H.setTime('a', 0.37); H.setTime('b', 0.37)
      return { vecAlone, imgAlone, vecTogether: H.pixels('a'), imgTogether: H.pixels('b') }
    })
    expect(r.vecTogether).toBe(r.vecAlone)
    expect(r.imgTogether).toBe(r.imgAlone)
  })
})
```

- [ ] **Step 5: Write the network spec**

Create `frontend/tests/frame-embed-network.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { openHarness, renderExported } from './_frameEmbedHelpers'

test.describe('Frame embed — zero network', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  for (const name of ['vector', 'image', 'backdrop', 'still']) {
    test(`the "${name}" export makes no request`, async ({ page, context }) => {
      const html = await page.evaluate(async (n) => {
        const H = (window as any).__frameEmbedHarness
        return await H.exportHtml(await H.snapshot(n))
      }, name)
      const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
      expect(requests).toEqual([])
    })
  }

  // The gate on the gate: a snapshot with one inlined image removed must make the painter fall
  // back to the server URL, and this listener must see that request. Otherwise the tests above
  // prove nothing.
  test('a missing inlined asset IS seen as a request', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('image')
      delete snap.assets.urls['image|harness-photo.png']
      return await H.exportHtml(snap)
    })
    const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
    expect(requests.some(u => u.includes('/view?'))).toBe(true)
  })
})
```

`exportHtml` for the mutated snapshot bakes the poster in the app, where `/view?filename=harness-photo.png` 404s; the poster simply lacks that image — the test only reads the exported file's own requests.

- [ ] **Step 6: Run the specs**

Run: `cd frontend && npm run build:embed && PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-embed-contract.spec.ts tests/frame-embed-network.spec.ts --project=chromium`
Expected: PASS (9 tests). A failing "two Frames on one page" is a real finding: shared module state in the painter (`_fieldCtx`, `_cloneSlot`, the shader GL context). Diagnose it (superpowers:systematic-debugging) and fix in the adapter if possible; report before touching the painter.

- [ ] **Step 7: Commit**

Paths: `frontend/app/pages/dev/frame-embed-harness.vue frontend/tests/_frameEmbedHelpers.ts frontend/tests/frame-embed-contract.spec.ts frontend/tests/frame-embed-network.spec.ts`
Message: `test(embed): Frame harness, contract (two on one page) and zero-network gate with teeth`

---

### Task 8: Parity with teeth, offset, glyphs, clips and stills

**Files:**
- Modify: `frontend/app/pages/dev/frame-embed-harness.vue` (implement `reference`; add `mutate`)
- Create: `frontend/tests/frame-embed-parity.spec.ts`
- Create: `frontend/tests/frame-embed-offset.spec.ts`

**Interfaces:**
- Produces on the harness:
  - `reference(name, t01, w, h): Promise<string>` — the **studio** render: paints the fixture straight from its layers with the painter, the way `CompositorModal.vue`'s `renderStack` does (items built from the stack order; `t` = `t01 × duration`; the fixture's motion, wired treatments, background, groups and post; `bake = true`), loading assets the app's way (`ensureLayerImages`, `document.fonts` with a harness `@font-face` for `Harness Font` pointing at `/fonts/ABCROM-Bold.otf`), at `w × h` = the artboard's own shape. While it paints, the harness registers a resolver mapping the synthetic filenames and clip frames to their **original** full-size PNGs (standing in for `/view`), and unregisters it before returning.
  - `mutate(snap, kind: 'colour' | 'font' | 'shader'): FrameSnapshot` — returns a copy with one deliberate break: the first rect's colour changed; the font's data URL replaced with `/fonts/ABCROM-BoldItalic.otf`'s bytes (check the exact file name in `frontend/public/fonts/`); the first shader definition's `source` replaced by a solid-magenta fragment.

- [ ] **Step 1: Implement `reference` and `mutate`** as specified above. Keep `reference` visibly independent of the adapter: it must not import `surfaces/frame.ts` or `stackItemsFor`.

- [ ] **Step 2: Write the parity spec**

Create `frontend/tests/frame-embed-parity.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { openHarness, pixelDiff, renderExported } from './_frameEmbedHelpers'

const T = 0.37
const VIEW = { width: 1000, height: 500 }   // the fixtures' artboard shape → no bleed, parity applies

async function exported(page: any, context: any, name: string, mutate?: string) {
  const html = await page.evaluate(async ([n, m]: [string, string | undefined]) => {
    const H = (window as any).__frameEmbedHarness
    let snap = await H.snapshot(n)
    if (m) snap = H.mutate(snap, m)
    return await H.exportHtml(snap)
  }, [name, mutate])
  return (await renderExported(context, html, T, VIEW)).png
}
const reference = (page: any, name: string) =>
  page.evaluate(([n, t]: [string, number]) => (window as any).__frameEmbedHarness.reference(n, t, 1000, 500), [name, T])

test.describe('Frame embed — parity with the editor', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  test('vector: identical to the editor, subset font and all', async ({ page, context }) => {
    const d = await pixelDiff(page, await reference(page, 'vector'), await exported(page, context, 'vector'))
    expect(d.differing).toBe(0)
  })

  test('image and clip: within the tolerance lossy frames allow', async ({ page, context }) => {
    // WebP at quality 0.9 moves smooth pixels by a few levels; 6 is the allowance, 1 % the budget.
    const d = await pixelDiff(page, await reference(page, 'image'), await exported(page, context, 'image'), 6)
    expect(d.differing).toBeGreaterThanOrEqual(0)
    expect(d.differing / d.total).toBeLessThan(0.01)
  })

  for (const m of ['colour', 'font', 'shader']) {
    test(`teeth: a broken ${m} fails the comparison`, async ({ page, context }) => {
      const d = await pixelDiff(page, await reference(page, 'vector'), await exported(page, context, 'vector', m))
      expect(d.differing).toBeGreaterThan(50)
    })
  }

  test('an image clip plays', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      return await H.exportHtml(await H.snapshot('image'))
    })
    const a = (await renderExported(context, html, 0.1, VIEW)).png
    const b = (await renderExported(context, html, 0.6, VIEW)).png
    expect(a).not.toBe(b)
  })

  test('a Frame that does not move is a still', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('still')
      if (!snap.still) throw new Error('fixture should plan as a still')
      return await H.exportHtml(snap)
    })
    expect(html).toContain('"still":true')
  })
})
```

The "vector" case expects **zero** differing pixels: the subset keeps every glyph the Decode behaviour draws (letters, numbers and symbols pools are basic Latin; the route keeps basic Latin — confirm by reading `subset_font_bytes` in `comfy_extras/nodes_timeline.py` and write the finding into the test's comment). If it is not zero, find out why before accepting any tolerance.

- [ ] **Step 3: Write the offset spec (reusable by the responsive-Frames work)**

Create `frontend/tests/frame-embed-offset.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { openHarness } from './_frameEmbedHelpers'

// Backdrop-reading effects (backdrop shader, long shadow — and glass and displacement lenses
// through the same backdrop snapshot) have only ever been painted with the Frame at the canvas
// origin. Fit moves it. Render the "backdrop" fixture once exactly at its own shape and once
// centred in a box twice as wide (a solid background, so the bleed is uniform), crop the centre,
// and require the same pixels. The responsive-Frames work reuses this test for its own offsets.
test('backdrop-reading effects are unchanged when the Frame is offset', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const H = (window as any).__frameEmbedHarness
    const snap = await H.snapshot('backdrop')
    await H.mount('a', snap); H.setSize('a', 1000, 500); H.setTime('a', 0.25)
    const own = H.pixels('a'); H.destroy('a')
    await H.mount('a', snap); H.setSize('a', 2000, 500); H.setTime('a', 0.25)
    const wide = H.pixels('a'); H.destroy('a')
    const load = (u: string) => new Promise<HTMLImageElement>(res => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [a, b] = await Promise.all([load(own), load(wide)])
    const ca = document.createElement('canvas'); ca.width = 1000; ca.height = 500
    ca.getContext('2d')!.drawImage(a, 0, 0)
    const cb = document.createElement('canvas'); cb.width = 1000; cb.height = 500
    cb.getContext('2d')!.drawImage(b, 500, 0, 1000, 500, 0, 0, 1000, 500)
    const da = ca.getContext('2d')!.getImageData(0, 0, 1000, 500).data
    const db = cb.getContext('2d')!.getImageData(0, 0, 1000, 500).data
    let differing = 0
    for (let p = 0; p < da.length; p += 4) if (Math.abs(da[p]! - db[p]!) > 2 || Math.abs(da[p + 1]! - db[p + 1]!) > 2 || Math.abs(da[p + 2]! - db[p + 2]!) > 2) differing++
    return differing
  })
  expect(r).toBe(0)
})
```

- [ ] **Step 4: Run**

Run: `cd frontend && PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-embed-parity.spec.ts tests/frame-embed-offset.spec.ts --project=chromium`
Expected: PASS (8 tests). A failing offset test is a real painter finding — report it with the effect that differs (bisect by removing one effect at a time from the fixture) rather than loosening the test.

- [ ] **Step 5: Commit**

Paths: `frontend/app/pages/dev/frame-embed-harness.vue frontend/tests/frame-embed-parity.spec.ts frontend/tests/frame-embed-offset.spec.ts`
Message: `test(embed): Frame parity against the editor with three mutations that must fail, plus offset, clip and still checks`

---

### Task 9: The export sheet in the Frame editor

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/FrameWebExportSheet.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (footer ~line 10935; a glue function near `generateVideo` ~line 4405)
- Create: `frontend/tests/frame-web-export-sheet.spec.ts`

**Interfaces:**
- Consumes: `planFrameExport`, `buildFrameSnapshot`, `isBlocked`, `formatBytes`, `createAppFrameExportIO`, `embedSnippet`, `exportEmbedHtml`, `downloadEmbed`, `fetchShaderFxCatalog`, `useUploadedFonts`.
- Produces: `FrameWebExportSheet` props `{ state: 'working' | 'ready' | 'blocked' | 'error'; notices: FrameNotice[]; bytes: number; fit: FrameFit; transparentAllowed: boolean; transparent: boolean; still: boolean; artAspect: number; errorText?: string }`, emits `update:fit`, `update:transparent`, `download`, `copy`, `close`.

- [ ] **Step 1: Read the modal's state**

In `CompositorModal.vue` confirm the names this task uses, by grep, and note any that differ: `localLayers`, `stackKeys`, `localGroups`, `background`, `postEffects`, `wiredTreatments`, `effectiveMotion`, `hasMotion`, `bakeSize()`, `wiredContentForSlot(slot)`, `buildStackItems()`, `layers` (the per-slot records, 1-based `slot`, each with an optional `live` source — `hasAnimatedSlot` at ~line 3520 tests `l.live && l.live.duration > 0`), `rendering`, `baking`, `encoding`, `renderError`. `hasAnimatedShaderFill` is exported from `useCompositorLayers.ts`. `useUploadedFonts()` — find the exported accessor for the list (`fonts`).

- [ ] **Step 2: Write the sheet**

`FrameWebExportSheet.vue` (script setup, TS). Layout per the spec's "The sheet" section and the approved mockup:
- header row: "Web export" and, right-aligned, `One file · plays anywhere · ${formatBytes(bytes)}` (hidden while `working`);
- left column: a 220×150 preview box showing a dashed "Your Frame" rectangle of `artAspect`, placed by `fitRect` for the current `fit` inside the box; two segment buttons **Fit** / **Fill** with the hint lines "Whole Frame stays visible. The background stretches to the edges of the box." / "Frame covers the whole box. The edges get cropped."; a **Transparent background** checkbox, disabled with "This Frame has a background" when `!transparentAllowed`;
- right column: groups in this order, each only when non-empty — **Fonts going into the file** (`fonts`), **Plays live** (`live`), **Will be a still** (`still`), **Left out** (`leftOut`); and when `blocked` notices exist, a **Can't export yet** group listing them in the danger colour;
- when `still` is true: the one line "This Frame doesn't move. The export will be a single sharp image that scales to any size." replaces the live/still groups;
- `working`: "Working out what goes in the file…" in place of the lists; Download disabled;
- footer: a quiet line "Upload this file to your site, then embed it" with a **Copy embed code** button, then **Cancel** and **Download** (Download disabled unless `state === 'ready'`).

Use the modal footer's own button classes (copy them from the "Generate as video" / "Generate as image" buttons) so the sheet looks native; dark surface `bg-[#161616] border border-white/10 rounded-lg`, positioned `absolute bottom-14 right-3 w-[640px] max-w-[calc(100%-24px)] z-[60]`. All copy exactly as written here — sentence case, no identifiers.

- [ ] **Step 3: Wire it into the modal**

In the footer, add a button before "Generate as video":

```vue
        <button
          class="h-8 px-3 rounded text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 bg-white/[0.06] hover:bg-white/12 text-white/85"
          :disabled="rendering || baking || encoding"
          title="Download a web file that plays this Frame live"
          data-testid="frame-web-export"
          @click="openWebExport">
          Web export
        </button>
```

and render `<FrameWebExportSheet v-if="webExport.open" … />` inside the footer's positioned container (give the footer `relative` if it lacks it). Import the component explicitly (components under `vue-canvas/compositor/` are imported by path in this file — follow how `MotionGallery.vue` is imported).

Glue (script), placed near `generateVideo`:

```ts
const webExport = reactive({
  open: false, state: 'working' as 'working' | 'ready' | 'blocked' | 'error',
  notices: [] as FrameNotice[], bytes: 0, fit: 'fit' as FrameFit, transparent: false, still: false,
  html: '', errorText: '', artAspect: 1,
})
let webExportGen = 0

function webExportVariant(): FrameVariant {
  const { W, H } = bakeSize()
  const motion = hasMotion.value ? effectiveMotion.value : null
  // A deep copy through JSON: the snapshot must not alias reactive editor state.
  return JSON.parse(JSON.stringify({
    width: W, height: H, layers: localLayers.value, stackOrder: stackKeys.value, groups: localGroups.value,
    background: background.value ?? null, post: postEffects.value ?? [], motion, wiredTreatments: wiredTreatments.value ?? {},
  }))
}

async function buildWebExport() {
  const gen = ++webExportGen
  webExport.state = 'working'
  try {
    const cat = await fetchShaderFxCatalog()
    const variant = webExportVariant()
    webExport.artAspect = variant.width / variant.height
    // A wired layer's `slot` is 0-based; the modal's per-slot records (`layers`) number from 1 —
    // the same offset wiredContentForSlot applies. `live.duration > 0` is exactly hasAnimatedSlot's test.
    const wiredSlots = variant.layers.filter(l => l.kind === 'wired').map((l) => {
      const slot = (l as { slot: number }).slot
      const live = layers.value.find(x => x.slot === slot + 1)?.live
      return { slot, layerId: l.id, label: layerLabel(l), animated: !!live && live.duration > 0 }
    })
    const plan = planFrameExport({
      variant, fit: webExport.fit, wiredSlots, catalogIds: new Set(cat.effects.map(e => e.id)),
      hasMotion: hasMotion.value, animatedFill: hasAnimatedShaderFill(buildStackItems(), background.value),
    })
    const io = createAppFrameExportIO({ uploaded: uploadedFonts.value, wiredStill: wiredContentForSlot, catalog: cat.effects })
    const snap = await buildFrameSnapshot(plan, variant, io)
    if (gen !== webExportGen) return
    webExport.notices = snap.notices
    webExport.still = snap.still
    if (isBlocked(snap)) { webExport.state = 'blocked'; webExport.html = ''; return }
    const transparent = webExport.transparent && variant.background == null
    const html = await exportEmbedHtml({
      kind: 'frame', config: snap, duration: snap.duration, width: variant.width, height: variant.height,
      transparent, framing: 'box', posterFit: webExport.fit === 'fill' ? 'cover' : 'contain', still: snap.still,
      backdrop: typeof variant.background === 'string' ? variant.background : undefined,
    })
    if (gen !== webExportGen) return
    webExport.html = html
    webExport.bytes = new Blob([html]).size
    webExport.state = 'ready'
  } catch (err) {
    if (gen !== webExportGen) return
    console.error('[Frame] web export failed', err)
    webExport.state = 'error'
    webExport.errorText = 'The export couldn\'t be built. Try again, or reload the Frame editor.'
  }
}

function openWebExport() { webExport.open = true; webExport.transparent = false; void buildWebExport() }
function setWebExportFit(f: FrameFit) { webExport.fit = f; void buildWebExport() }
function setWebExportTransparent(on: boolean) { webExport.transparent = on; void buildWebExport() }
function downloadWebExport() {
  if (webExport.state !== 'ready') return
  downloadEmbed('sailor-frame.html', webExport.html)
  renderError.value = ''
  webExport.open = false
  webExportNotice.value = `Downloaded · ${formatBytes(webExport.bytes)}`
}
async function copyWebExportSnippet() {
  const { W, H } = bakeSize()
  await navigator.clipboard.writeText(embedSnippet('sailor-frame.html', W, H))
}
```

Add `const uploadedFonts = useUploadedFonts().fonts` beside the modal's other composable calls (the composable returns `fonts`, a ref of `UploadedFontEntry[]`). `webExportNotice` is a new `ref('')` shown in the footer's existing status slot beside `renderError` (same styling, not rose). Pass `transparentAllowed: variant background is empty` to the sheet (compute from `background.value == null`).

- [ ] **Step 4: Write the E2E**

Create `frontend/tests/frame-web-export-sheet.spec.ts`. Use `/dev/frame-lab` (read its header: it mounts the card and opens the modal) to reach the real modal. Steps: open the modal as frame-lab does; click `[data-testid="frame-web-export"]`; wait for the text "One file · plays anywhere"; assert the sheet shows a "Fonts going into the file" group (frame-lab's text layers use a real family — if every family there is a system font, add a Google-family text layer to frame-lab's fixture and say so in the commit); click **Download** inside `page.waitForEvent('download')`; read the download to a string and assert it contains `__SAILOR_SNAPSHOT__` and `"kind":"frame"`; then assert `externalRefs(html)` is empty by evaluating it in the page (`import('/_nuxt/app/lib/embed/bundle.ts')` is not stable — instead assert the download's HTML has no `/view?` and no `https://fonts.googleapis.com`). Finally click **Web export** again, press **Fill** and assert the hint text changes to "Frame covers the whole box. The edges get cropped."

Run: `cd frontend && PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-web-export-sheet.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 5: See it with your own eyes**

In the browser pane (`mcp__Claude_Browser__*`, the existing `:3002` server), open `/dev/frame-lab`, open the modal, press **Web export**, and take a screenshot of the sheet in its ready state. Check the copy against Step 2 word for word. Attach the screenshot path in your report.

- [ ] **Step 6: Typecheck and commit**

`CompositorModal.vue` is shared with other sessions: stage **only your hunks** (see Task 1 Step 6's note), and verify with `git diff --cached -- frontend/app/components/vue-canvas/CompositorModal.vue` that nothing foreign is staged.

Paths: `frontend/app/components/vue-canvas/compositor/FrameWebExportSheet.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/frame-web-export-sheet.spec.ts` (plus `frontend/app/pages/dev/frame-lab.vue` if you added a fixture layer)
Message: `feat(frame): Web export — a sheet that says what goes in the file before it downloads`

---

### Task 10: Decide the lean bundle by measurement

**Files:** possibly `vite.embed.config.ts`, `scripts/build-embed.mjs`, `app/lib/embed/surfaces.ts`, `app/lib/embed/frame/plan.ts`, `app/lib/embed/frame/types.ts`, new stand-ins, `tests/unit/embed-build-output.unit.spec.ts`.

- [ ] **Step 1: Measure**

Run: `cd frontend && ls -la public/embed/frame.js && gzip -c public/embed/frame.js | wc -c`
Then estimate what `fontkit` and `paper` contribute: build once with both aliased to empty stubs (`SAILOR_EMBED_SURFACE=frame` plus a temporary alias `{ find: 'fontkit', replacement: <stub> }`, `{ find: 'paper', replacement: <stub> }` — do not commit this trial) and compare sizes.

- [ ] **Step 2: Decide**

- If the saving is **under 300,000 bytes** (uncompressed): do not build a lean bundle. Write the three numbers into the comment above `FRAME_CEILING_BYTES` and stop. This is the expected outcome if fontkit tree-shakes well; one bundle is simpler.
- If it is **300,000 bytes or more**: build `frame-lean` — add `needsOutlines: boolean` to `FrameSnapshot` (set by the gatherer: any plan font with `outline: true`, or any layer whose effect stack has `boolean`, `shatter` or `morph`), make `bundleNameFor('frame', snap)` return `snap.needsOutlines ? 'frame' : 'frame-lean'`, and in `vite.embed.config.ts` build `frame-lean` from the same entry with `~/lib/compositor/textOutline` aliased to a stand-in whose `getCompositorFont` returns `null` and `runToCommands` returns `[]`, and `paper` aliased to a stub that throws `'paper is not in the lean Frame bundle'`. Add a parity case to Task 8's spec that runs the `vector` fixture through `frame-lean` and expects zero differing pixels, and a unit test that `needsOutlines` is true for an outlined text layer and a boolean effect.

- [ ] **Step 3: Commit** whatever the decision produced (at minimum the updated ceiling comment).

Message (no-split case): `docs(embed): measured the Frame bundle — fontkit and paper cost N bytes, one bundle stays`

---

### Task 11: Record it

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-frame-web-export-design.md`
- Modify: `docs/superpowers/HANDOFF-video-export-and-frame-embed.md` (append one line)
- Modify: `docs/STATE.md`
- The ⛵ dashboard artifact (`https://claude.ai/code/artifact/beb788b5-493b-4597-aa66-ce8a5609df89`)

- [ ] **Step 1: Amend the spec** — add a section "Changed while planning (2026-09-22)" listing the six departures at the top of this plan, and correct the "Supply-line stand-ins" table: the five URL builders consult `lib/compositor/assetScope.ts` at runtime; only `depthRequest` and `variable-fonts.ts`'s `cssUrl` are replaced in the embed build.

- [ ] **Step 2: Append to the handoff note**, below "_Landed notes (append below):_": `2026-09-22 — Frame web export stage 1 landed. renderCompositeAtTime is untouched. The embed contract is unchanged; EmbedSnapshot gained four optional fields (framing, posterFit, still, backdrop) that default to today's behaviour.`

- [ ] **Step 3: STATE.md** — a Frame web export entry in the file's own format: what shipped, the measured bundle size, what is owed (nesting = stage 2; Scene3D adapter; Publish).

- [ ] **Step 4: Dashboard** — read the live artifact first (`Artifact` action `read` with the URL), then edit in place per `update-dashboard-on-every-commit`: replace the "Frame web export — review the spec" decision with a one-line "Try it" entry under Your move, update the Act 3 row, add one line to today's Landed entry. Run the encoding guard before republishing.

- [ ] **Step 5: Commit** the three docs files (private index).
Message: `docs: Frame web export stage 1 — spec amended with what planning found, handoff note, STATE`

---

## Self-review (done while writing)

- **Spec coverage.** Entry point → T9. Sheet (size, fonts, live, still, left out, blocked, working, still-Frame line, copy embed code, fit/fill, transparent) → T9. Time rules (motion duration, still) → T3; the seam warning for nested loops is stage 2 (only nested loops can seam). Fit and bleed → T5 + T6, offset test → T8. Snapshot (variants list, assets, wired, notices) → T3/T4. Supply lines → T1/T2/T6. Adapter → T6. Bundles → T6/T10. Shared foundations: font helper → T4; keyed registry → stage 2 (departure 3); reusable sheet → T9. Failure handling → T6 (reject on font/shader), inherited runtime. Tests 1–9 of the spec → contract T7, parity T8, teeth T8, network T7, glyphs T8 (vector fixture uses Decode on symbols), offset T8, nested staleness → stage 2, notices truthful T3/T4 (unit) + T8 (clip plays, still), existing exports T5/T6.
- **Names used across tasks:** `registerAssetResolver`, `resolveAssetUrl`, `clipFrameKey`, `shaderTextureUrl`, `shaderTextureKey`, `ensureLayerImages(…, { keep })`, `requestDepthEstimate`, `seedDepthImage`, `addShaderFxEffects`, `FontWeightSpec`, `assetKey`, `planFrameExport`, `layerLabel`, `textNeedsOutline`, `buildFrameSnapshot`, `isBlocked`, `formatBytes`, `createAppFrameExportIO`, `makeFontSource`, `fitRect`, `stackItemsFor`, `embedCone`, `embedSnippet` — each defined in exactly one task and used with the same signature after.
