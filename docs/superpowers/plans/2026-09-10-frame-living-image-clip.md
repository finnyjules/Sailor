# Frame living image clip — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-10-frame-living-image-clip-design.md`

**Goal:** an image layer in the Frame can carry a looping, transparent clip made by an image-to-video model, and paints the right frame for the Frame's clock, with each cloner copy offset in time.

**Architecture:** the image layer keeps its still and gains an optional `clip` (a PNG folder under ComfyUI `input/sailor_clips/`). Pure frame-picking maths live in a new `lib/compositor/clip.ts`. `useCompositorLayers` loads the folder into a second cache and, in the image branch, draws the frame for the module-level paint clock plus the current clone's index. The modal and the Frame card count clips when deriving the master clock and the "something animates" gate, so playback, bake and export follow. A Nitro route flattens the still onto a key colour, calls the model through the metered `runFal`/`runReplicate` helpers, then a Python script keys every frame back to transparency and writes the folder.

**Tech stack:** Nuxt 4 / Vue 3 / TypeScript, Canvas2D, vitest (`frontend/tests/unit/*.unit.spec.ts`, happy-dom for components), Nitro server routes, Python 3 in the repo `.venv` (numpy, Pillow, imageio + imageio_ffmpeg), pytest (`tests-unit/`).

## Global constraints

- Work in the main checkout on `main`. No worktree, no branch.
- **Every commit uses a private git index** (several sessions share this checkout):
  ```bash
  export GIT_INDEX_FILE=/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/c0158854-2bb5-4da2-bdec-98a882b38e11/scratchpad/clip-index
  git read-tree HEAD
  git add <only your exact paths>
  git diff --cached --stat        # must list ONLY your files
  git commit -m "..."
  unset GIT_INDEX_FILE
  ```
  Never `git stash`. Never `git add -A` or `git add .`. Leave files you did not write alone.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **A layer without a clip must paint exactly as before.** Every new branch is gated on `layer.clip` being present.
- UI copy: sentence case, no internal ids on screen. Model rows are labelled "Luma, loops by itself", "Seedance", "Hailuo".
- Never start a dev server from a subagent. The main checkout's server is `:3002` (check with `lsof -nP -iTCP -sTCP:LISTEN | grep node`). Killing a Nuxt server can take ComfyUI down with it.
- Run vitest from `frontend/`: `npx vitest run tests/unit/<file>.unit.spec.ts`. Run pytest from the repo root: `.venv/bin/python -m pytest tests-unit/<file>.py -q`.
- After each commit, update the "Sailor — State of the Build" dashboard artifact (`https://claude.ai/code/artifact/beb788b5-493b-4597-aa66-ce8a5609df89`): read the live page first, replace stale state in place, add one line to today's entry under Landed. Never append new sections. The parent session does this, not subagents.
- The paid model call (Task 8) runs once, by hand, and its cost is written into the state note.

## File map

| File | Responsibility |
|---|---|
| `frontend/app/lib/compositor/clip.ts` (new) | `ImageClip` type, played length, frame index for a clock + clone offset, frame URL. Pure. |
| `frontend/app/composables/useCloner.ts` | `Cloner.phase`, `CloneTransform.k` / `.n`. |
| `frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue` | Phase slider. |
| `frontend/app/composables/useCompositorLayers.ts` | `ImageLayer.clip`, clip frame cache + loader, image-branch frame pick, clone slot threading, `clipClocks()`. |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | clips join `liveMasterClock` / `hasAnimatedSlot`; alpha export; Animate panel mount. |
| `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` | clips join `masterClock` / `hasAnimatedSlot`; alpha export. |
| `scripts/clip_key.py` (new) | `flatten` (still → keyed RGB PNG, picks green/blue) and `key` (mp4 → transparent PNG folder). Pure functions + CLI. |
| `tests-unit/clip_key_test.py` (new) | keying maths, guard dilation, key colour choice. |
| `frontend/server/utils/falRun.ts` | `firstFalVideoUrl`. |
| `frontend/app/data/clip-models.ts` (new) | the three model rows: id, label, durations, provider, price hint. |
| `frontend/server/api/frame/animate.post.ts` (new) | orchestrates flatten → model → key → folder. |
| `frontend/server/lib/nitroApiPaths.ts` | add `/api/frame` prefix. |
| `frontend/app/composables/useLayerAnimate.ts` (new) | client call to the route, busy/error, attach/remove clip. |
| `frontend/app/components/vue-canvas/compositor/CompositorAnimatePanel.vue` (new) | prompt / model / length / speed / generate / remove. |
| `frontend/tests/unit/compositor-clip.unit.spec.ts` (new) | Task 1 maths. |
| `frontend/tests/unit/cloner.unit.spec.ts` | Task 2 additions. |
| `frontend/tests/unit/frame-cloner-panel.unit.spec.ts` | Task 2 Phase row. |
| `frontend/tests/unit/compositor-clip-layer.unit.spec.ts` (new) | Task 3 selector + clocks. |
| `frontend/tests/unit/frame-animate-panel.unit.spec.ts` (new) | Task 7 panel. |
| `frontend/tests/unit/clip-models.unit.spec.ts` (new) | Task 6 catalog shape. |

---

### Task 1: pure clip maths

**Files:**
- Create: `frontend/app/lib/compositor/clip.ts`
- Test: `frontend/tests/unit/compositor-clip.unit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ImageClip { dir: string; frames: number; fps: number; speed: number; prompt: string; model: string }
  export function clipPlayedSeconds(clip: ImageClip): number
  export function clipFrameIndex(clip: ImageClip, tSec: number, k = 0, n = 1, phase = 1): number
  export function clipFrameUrl(clip: ImageClip, index: number): string
  ```

- [ ] **Step 1: write the failing test**

```ts
// frontend/tests/unit/compositor-clip.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { clipFrameIndex, clipFrameUrl, clipPlayedSeconds, type ImageClip } from '~/lib/compositor/clip'

const clip = (over: Partial<ImageClip> = {}): ImageClip =>
  ({ dir: 'sailor_clips/clip_1', frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0', ...over })

describe('clipPlayedSeconds', () => {
  it('is frames / fps / speed', () => {
    expect(clipPlayedSeconds(clip())).toBe(1)
    expect(clipPlayedSeconds(clip({ speed: 0.5 }))).toBe(2)
    expect(clipPlayedSeconds(clip({ frames: 48, speed: 4 }))).toBe(0.5)
  })
  it('never divides by zero', () => {
    expect(clipPlayedSeconds(clip({ fps: 0 }))).toBe(0)
    expect(clipPlayedSeconds(clip({ speed: 0 }))).toBe(clipPlayedSeconds(clip({ speed: 1 })))
  })
})

describe('clipFrameIndex', () => {
  it('walks frames at the clip fps and wraps', () => {
    expect(clipFrameIndex(clip(), 0)).toBe(0)
    expect(clipFrameIndex(clip(), 0.5)).toBe(12)
    expect(clipFrameIndex(clip(), 1)).toBe(0)
    expect(clipFrameIndex(clip(), 1.25)).toBe(6)
  })
  it('speed scales the walk', () => {
    expect(clipFrameIndex(clip({ speed: 2 }), 0.25)).toBe(12)
    expect(clipFrameIndex(clip({ speed: 0.5 }), 1)).toBe(12)
  })
  it('picks the nearest frame when the Frame runs at another rate (24 in 30)', () => {
    // 1/30 s into a 24 fps clip is 0.8 frames → frame 1 (nearest), not 0 (floor)
    expect(clipFrameIndex(clip(), 1 / 30)).toBe(1)
    expect(clipFrameIndex(clip(), 2 / 30)).toBe(2)
  })
  it('offsets clones evenly around the loop at phase 1', () => {
    expect(clipFrameIndex(clip(), 0, 0, 4, 1)).toBe(0)
    expect(clipFrameIndex(clip(), 0, 1, 4, 1)).toBe(6)
    expect(clipFrameIndex(clip(), 0, 2, 4, 1)).toBe(12)
    expect(clipFrameIndex(clip(), 0, 3, 4, 1)).toBe(18)
  })
  it('phase 0 plays clones in unison, 0.5 halves the spread', () => {
    expect(clipFrameIndex(clip(), 0, 3, 4, 0)).toBe(0)
    expect(clipFrameIndex(clip(), 0, 2, 4, 0.5)).toBe(6)
  })
  it('is safe with negative time and a single frame', () => {
    expect(clipFrameIndex(clip(), -0.5)).toBe(12)
    expect(clipFrameIndex(clip({ frames: 1 }), 3.7)).toBe(0)
    expect(clipFrameIndex(clip({ frames: 0 }), 3.7)).toBe(0)
  })
})

describe('clipFrameUrl', () => {
  it('is a /view URL into the clip folder with a six-digit name', () => {
    expect(clipFrameUrl(clip(), 7)).toBe('/view?filename=000007.png&subfolder=sailor_clips%2Fclip_1&type=input')
  })
})
```

- [ ] **Step 2: run it, expect failure**

Run: `cd frontend && npx vitest run tests/unit/compositor-clip.unit.spec.ts`
Expected: FAIL, cannot resolve `~/lib/compositor/clip`.

- [ ] **Step 3: implement**

```ts
// frontend/app/lib/compositor/clip.ts
// A "living image": an image layer's optional frame sequence. Pure maths only — no
// DOM, no Vue — so the modal, the Frame card and the bake all pick the same frame
// for the same clock. See docs/superpowers/specs/2026-09-10-frame-living-image-clip-design.md.

export interface ImageClip {
  /** Folder under ComfyUI input/, e.g. "sailor_clips/clip_1725970000_ab12". */
  dir: string
  /** PNG count: 000000.png … (frames-1). */
  frames: number
  /** Rate the model returned (24 or 25 today). */
  fps: number
  /** Playback multiplier, 0.25..4. 1 = as returned. */
  speed: number
  prompt: string
  model: string
}

export const CLIP_SPEED_MIN = 0.25
export const CLIP_SPEED_MAX = 4

/** How long one loop of the clip lasts on screen, in seconds. */
export function clipPlayedSeconds(clip: ImageClip): number {
  const fps = clip.fps > 0 ? clip.fps : 0
  const speed = clip.speed > 0 ? clip.speed : 1
  if (!fps || clip.frames <= 0) return 0
  return clip.frames / fps / speed
}

/**
 * Which frame to draw at `tSec` for clone `k` of `n`. Nearest frame (not floor) so a
 * 24 fps clip inside a 30 fps Frame does not stutter on every fifth frame. Clone `k`
 * starts `k × playedLength × phase / n` seconds ahead of clone 0, so phase 1 spreads
 * the copies evenly around the loop and phase 0 plays them together.
 */
export function clipFrameIndex(clip: ImageClip, tSec: number, k = 0, n = 1, phase = 1): number {
  const frames = Math.floor(clip.frames)
  if (frames <= 1) return 0
  const speed = clip.speed > 0 ? clip.speed : 1
  const played = clipPlayedSeconds(clip)
  const copies = Math.max(1, Math.floor(n))
  const offset = played > 0 ? (Math.max(0, k) * played * Math.max(0, Math.min(1, phase))) / copies : 0
  const f = Math.round((tSec + offset) * speed * clip.fps)
  return ((f % frames) + frames) % frames
}

/** The /view URL of one frame, same shape `imageLayerUrl` uses for stills. */
export function clipFrameUrl(clip: ImageClip, index: number): string {
  const filename = `${String(Math.max(0, Math.floor(index))).padStart(6, '0')}.png`
  return `/view?${new URLSearchParams({ filename, subfolder: clip.dir, type: 'input' })}`
}
```

- [ ] **Step 4: run it, expect pass**

Run: `cd frontend && npx vitest run tests/unit/compositor-clip.unit.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: commit**

```bash
git add frontend/app/lib/compositor/clip.ts frontend/tests/unit/compositor-clip.unit.spec.ts
git commit -m "feat(frame): clip maths — played length, nearest frame for a clock, per-clone phase offset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: cloner phase and clone index

**Files:**
- Modify: `frontend/app/composables/useCloner.ts` (interfaces at lines 25-79, `DEFAULT_CLONER` at 80, `expandClones` at 154)
- Modify: `frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue` (Falloff block, near line 148)
- Test: `frontend/tests/unit/cloner.unit.spec.ts`, `frontend/tests/unit/frame-cloner-panel.unit.spec.ts`

**Interfaces:**
- Produces: `Cloner.phase?: number` (0..1, default 1); `CloneTransform.k: number` (this copy's index, 0 = original) and `CloneTransform.n: number` (copies in this expansion). `expandClones` with no cloner returns one transform with `k: 0, n: 1`.

- [ ] **Step 1: write the failing tests**

Append to `frontend/tests/unit/cloner.unit.spec.ts` (keep its existing imports; add `DEFAULT_CLONER` if not already imported):

```ts
describe('clone index and count', () => {
  it('no cloner → one copy, k 0 of n 1', () => {
    const [only] = expandClones(undefined, 1)
    expect(only.k).toBe(0)
    expect(only.n).toBe(1)
  })
  it('a 2×2 grid numbers its copies 0..3 and reports n 4 on each', () => {
    const out = expandClones({ ...DEFAULT_CLONER, enabled: true, countX: 2, countY: 2 }, 1)
    expect(out.map(c => c.k).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    expect(out.every(c => c.n === 4)).toBe(true)
  })
  it('phase defaults to 1', () => {
    expect(DEFAULT_CLONER.phase).toBe(1)
  })
})
```

Append to `frontend/tests/unit/frame-cloner-panel.unit.spec.ts` (it already mounts `Panel` with happy-dom):

```ts
describe('Phase row', () => {
  it('shows a Phase slider and writes phase back', async () => {
    const w = mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: true } } })
    const row = w.findAllComponents({ name: 'StudioSlider' }).find(s => s.props('label') === 'Phase')
    expect(row).toBeTruthy()
    row!.vm.$emit('update:modelValue', 0.5)
    const last = w.emitted('update')!.at(-1)![0] as Cloner
    expect(last.phase).toBe(0.5)
  })
})
```

- [ ] **Step 2: run, expect failure**

Run: `cd frontend && npx vitest run tests/unit/cloner.unit.spec.ts tests/unit/frame-cloner-panel.unit.spec.ts`
Expected: FAIL — `k`/`n` undefined, `phase` undefined, no Phase row.

- [ ] **Step 3: implement**

In `useCloner.ts`:

1. `Cloner` interface, after `stepOpacity`:
   ```ts
     /** Living-image clips only: how far apart the copies start in the clip, 0..1.
      *  1 spreads them evenly around the loop, 0 plays every copy in unison. */
     phase?: number
   ```
2. `DEFAULT_CLONER`: add `phase: 1,` after `stepOpacity: 1,` (keep whatever the file's current default value formatting is).
3. `CloneTransform`, after `tintStrength`:
   ```ts
     /** This copy's index in the expansion (0 = the original) and the copy count. A
      *  living-image layer offsets its clip by `k / n` of a loop (see lib/compositor/clip). */
     k: number
     n: number
   ```
4. `IDENTITY`: `{ dx: 0, dy: 0, drot: 0, dscale: 1, dopacity: 1, weight: 0, tintStrength: 1, k: 0, n: 1 }`.
5. In `expandClones`, where the final `CloneTransform[]` is assembled from `raw` (pass 2), set `k: r.k` and `n: raw.length` on every emitted transform. `r.k` is already the placement index pushed in pass 1.

In `CompositorClonerPanel.vue`, in the Falloff block directly after the Rotation `StudioSlider`:

```html
<StudioSlider :model-value="c.phase ?? 1" @update:model-value="(v) => up({ phase: Math.max(0, Math.min(1, v)) })"
  label="Phase" :min="0" :max="1" :step="0.05" :bindable="false" />
```

- [ ] **Step 4: run, expect pass**

Run: `cd frontend && npx vitest run tests/unit/cloner.unit.spec.ts tests/unit/frame-cloner-panel.unit.spec.ts`
Expected: PASS. Then run the whole suite once to confirm nothing keyed on the transform shape broke: `npx vitest run` — same pass count as before plus the new tests (the suite's baseline has a handful of known-slow specs; a timeout in a spec you did not touch is not a regression, re-run that spec alone).

- [ ] **Step 5: commit**

```bash
git add frontend/app/composables/useCloner.ts frontend/app/components/vue-canvas/compositor/CompositorClonerPanel.vue frontend/tests/unit/cloner.unit.spec.ts frontend/tests/unit/frame-cloner-panel.unit.spec.ts
git commit -m "feat(cloner): Phase dial + per-copy index on the clone transform

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: the image layer holds and paints a clip

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`
  - `ImageLayer` interface (line 540)
  - image-asset loading (`_imageCache`, `imageLayerUrl`, `ensureLayerImages`, lines 1088-1125)
  - cloner loop in `paintLayer` (line 2262 `for (const c of expandClones(...))`)
  - image branch in `drawLayerContent` (line 3292 `} else if (layer.kind === 'image') {`)
  - `silhouetteContentReady` (line 1895) — unchanged, the still stays the readiness oracle
- Test: `frontend/tests/unit/compositor-clip-layer.unit.spec.ts`

**Interfaces:**
- Consumes: `ImageClip`, `clipFrameIndex`, `clipFrameUrl`, `clipPlayedSeconds` (Task 1); `CloneTransform.k/.n`, `Cloner.phase` (Task 2).
- Produces:
  ```ts
  // on ImageLayer
  clip?: ImageClip
  // exported from useCompositorLayers.ts
  export function clipClocks(layers: LocalLayer[]): { duration: number; fps: number }[]
  export function clipFrameFor(layer: LocalLayer, tSec: number, k: number, n: number): HTMLImageElement | null
  export async function ensureLayerImages(layers: LocalLayer[]): Promise<void>   // now also loads clips
  ```

- [ ] **Step 1: write the failing test**

```ts
// frontend/tests/unit/compositor-clip-layer.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { clipClocks, clipFrameFor, createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const living = (): ImageLayer => ({
  ...still(),
  clip: { dir: 'sailor_clips/clip_x', frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0' },
})

describe('clipClocks', () => {
  it('is empty when no image layer carries a clip', () => {
    expect(clipClocks([still()])).toEqual([])
  })
  it('reports one clock per clip, using the PLAYED length', () => {
    const l = living(); l.clip!.speed = 0.5
    expect(clipClocks([still(), l])).toEqual([{ duration: 2, fps: 24 }])
  })
  it('ignores a clip with no frames', () => {
    const l = living(); l.clip!.frames = 0
    expect(clipClocks([l])).toEqual([])
  })
})

describe('clipFrameFor', () => {
  it('is null for a layer without a clip (the still path is untouched)', () => {
    expect(clipFrameFor(still(), 0.5, 0, 1)).toBeNull()
  })
  it('is null for a clip whose frames are not loaded yet (the still shows meanwhile)', () => {
    expect(clipFrameFor(living(), 0.5, 0, 1)).toBeNull()
  })
})
```

- [ ] **Step 2: run, expect failure**

Run: `cd frontend && npx vitest run tests/unit/compositor-clip-layer.unit.spec.ts`
Expected: FAIL — `clipClocks` / `clipFrameFor` are not exported.

- [ ] **Step 3: implement**

1. Import at the top of `useCompositorLayers.ts`:
   ```ts
   import { clipFrameIndex, clipFrameUrl, clipPlayedSeconds, type ImageClip } from '~/lib/compositor/clip'
   ```
2. `ImageLayer` gains, after `displaceMap`:
   ```ts
     /** Living image: a looping frame sequence made from this still (see lib/compositor/clip).
      *  Absent ⇒ the layer is exactly the still. `filename` stays the still and paints while
      *  the clip loads or if its folder is gone. */
     clip?: ImageClip
   ```
3. Clip cache + loader, right after `_imageCache` / `imageLayerUrl`:
   ```ts
   // ── Living-image clip frames ─────────────────────────────────────────────────
   // Keyed by clip dir. A folder loads ONCE (all frames, in order); until every frame is
   // in, the layer keeps painting its still, so a half-loaded clip never flickers.
   const _clipCache = new Map<string, HTMLImageElement[]>()
   const _clipLoading = new Map<string, Promise<void>>()
   const CLIP_LOAD_PARALLEL = 8

   function loadOne(url: string): Promise<HTMLImageElement | null> {
     return new Promise((res) => {
       const im = new Image()
       im.onload = () => res(im)
       im.onerror = () => res(null)
       im.src = url
     })
   }

   async function loadClip(clip: ImageClip): Promise<void> {
     const out: (HTMLImageElement | null)[] = new Array(clip.frames).fill(null)
     let next = 0
     const worker = async () => {
       while (next < clip.frames) { const i = next++; out[i] = await loadOne(clipFrameUrl(clip, i)) }
     }
     await Promise.all(Array.from({ length: Math.min(CLIP_LOAD_PARALLEL, clip.frames) }, worker))
     // One missing frame = a broken folder: keep the still rather than a stuttering loop.
     if (out.every(Boolean)) _clipCache.set(clip.dir, out as HTMLImageElement[])
   }

   function ensureClip(clip: ImageClip): Promise<void> {
     if (_clipCache.has(clip.dir)) return Promise.resolve()
     let p = _clipLoading.get(clip.dir)
     if (!p) {
       p = loadClip(clip).finally(() => _clipLoading.delete(clip.dir))
       _clipLoading.set(clip.dir, p)
     }
     return p
   }

   /** The frame a living image shows at `tSec` for clone `k` of `n`, or null when the
    *  layer has no clip or its frames are not all loaded yet (paint the still then). */
   export function clipFrameFor(layer: LocalLayer, tSec: number, k: number, n: number): HTMLImageElement | null {
     if (layer.kind !== 'image' || !layer.clip) return null
     const frames = _clipCache.get(layer.clip.dir)
     if (!frames || !frames.length) return null
     return frames[clipFrameIndex(layer.clip, tSec, k, n, layer.cloner?.phase ?? 1)] ?? null
   }

   /** One clock per living image, in the shape `deriveMasterClock` takes. Played length,
    *  so a slowed clip still completes whole cycles in the export. */
   export function clipClocks(layers: LocalLayer[]): { duration: number; fps: number }[] {
     const out: { duration: number; fps: number }[] = []
     for (const l of layers) {
       if (l.kind !== 'image' || !l.clip) continue
       const duration = clipPlayedSeconds(l.clip)
       if (duration > 0) out.push({ duration, fps: l.clip.fps })
     }
     return out
   }
   ```
4. In `ensureLayerImages`, inside the `for` loop after the still job is queued (before `continue` paths), add:
   ```ts
       if (layer.clip && layer.clip.frames > 0) jobs.push(ensureClip(layer.clip))
   ```
   (Place it so an image layer queues BOTH its still and its clip; the still `continue` must not skip the clip. Restructure the loop body as: compute `url`; if still not cached, push still job; if clip, push clip job.)
5. Clone slot threading. Beside `_fieldCtx` (line 1152) add:
   ```ts
   /** The clone being painted right now (set by paintLayer's cloner loop, read by the
    *  image branch of drawLayerContent). Outside a cloner loop it is the original alone. */
   let _cloneSlot = { k: 0, n: 1 }
   ```
   In `paintLayer`'s cloner loop (`for (const c of expandClones(layer.cloner, W / H)) {`), first line inside the loop body: `_cloneSlot = { k: c.k, n: c.n }`. Immediately after the loop ends (the closing brace of the `for`), reset: `_cloneSlot = { k: 0, n: 1 }`. Wrap the loop in `try { … } finally { _cloneSlot = { k: 0, n: 1 } }` if there is an existing try around it; otherwise the plain reset after the loop is enough because nothing in the loop awaits.
6. Image branch in `drawLayerContent` — replace the two lines that pick and test `img`:
   ```ts
     } else if (layer.kind === 'image') {
       const w = layer.w * W, h = layer.h * W
       // A living image draws the frame for the paint clock (`_fieldCtx.t`, set by
       // paintLayerStack) offset by the clone being painted; without a clip, or until
       // every frame is loaded, `clipFrameFor` is null and the still paints exactly as before.
       const img = clipFrameFor(layer, _fieldCtx.t, _cloneSlot.k, _cloneSlot.n)
         ?? _imageCache.get(imageLayerUrl(layer.filename))
       if (img && img.complete && img.naturalWidth) {
   ```
   Everything below (`drawTintedImage` / `drawImage` / placeholder) stays as it is.

- [ ] **Step 4: run, expect pass**

Run: `cd frontend && npx vitest run tests/unit/compositor-clip-layer.unit.spec.ts`
Expected: PASS, 5 tests. Then `npx vitest run tests/unit/` for the compositor-related specs (`compositor-*.unit.spec.ts`, `cloner.unit.spec.ts`, `frame-*.unit.spec.ts`) — all green as before.

- [ ] **Step 5: typecheck the touched file**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -E "useCompositorLayers|compositor/clip" || echo "no new errors in touched files"`
Expected: `no new errors in touched files` (the repo has a pre-existing error baseline elsewhere; only lines in the files you touched count).

- [ ] **Step 6: commit**

```bash
git add frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/compositor-clip-layer.unit.spec.ts
git commit -m "feat(frame): an image layer can hold a clip — frame cache, clock-picked frame, clone offset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: clips drive the Frame's clock, live loop and export

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
  - `liveMasterClock` + `hasAnimatedSlot` (~line 2903-2906)
  - `generateVideo` (~line 3470-3503)
  - `hasMotion` (~line 3437) — unchanged, it already reads `hasAnimatedSlot`
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue`
  - `masterClock` + `hasAnimatedSlot` (lines 556-559)
  - `downloadVideo` (line ~929, the `encodeFrames` call)
- Test: `frontend/tests/unit/compositor-master-clock.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `clipClocks` (Task 3), `hasPaint` from `~/lib/paint/resolve`, `deriveMasterClock`, `encodeFrames({ alpha })`.

- [ ] **Step 1: write the failing test**

Append to `frontend/tests/unit/compositor-master-clock.unit.spec.ts`:

```ts
import { clipClocks, createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

describe('deriveMasterClock with a living image beside a studio slot', () => {
  it('reconciles the clip period with the slot period', () => {
    const rose: ImageLayer = {
      ...createImageLayer('rose.png', 1),
      clip: { dir: 'sailor_clips/c', frames: 48, fps: 24, speed: 1, prompt: '', model: 'luma-ray-2-720p' }, // 2 s
    }
    const mc = deriveMasterClock([{ duration: 3, fps: 24 }, ...clipClocks([rose])])
    expect(mc).toEqual({ duration: 6, fps: 24 })
  })
  it('a clip alone gives the Frame a clock', () => {
    const rose: ImageLayer = {
      ...createImageLayer('rose.png', 1),
      clip: { dir: 'sailor_clips/c', frames: 120, fps: 24, speed: 2, prompt: '', model: 'seedance-2.0' }, // 2.5 s played
    }
    expect(deriveMasterClock(clipClocks([rose]))).toEqual({ duration: 2.5, fps: 24 })
  })
})
```

- [ ] **Step 2: run, expect failure**

Run: `cd frontend && npx vitest run tests/unit/compositor-master-clock.unit.spec.ts`
Expected: the two new tests PASS already if Task 3 is in (they only exercise pure code). That is fine: this task's real assertion is the wiring below, which is verified in the browser in Step 5. Keep the tests; they pin the reconciliation the wiring relies on.

- [ ] **Step 3: wire the modal**

In `CompositorModal.vue`:

1. Import `clipClocks` from `~/composables/useCompositorLayers` (add to the existing import list at line 12) and `hasPaint` from `~/lib/paint/resolve` if not already imported (grep first).
2. Replace the two computeds:
   ```ts
   const liveMasterClock = computed(() => deriveMasterClock(
     [
       ...layers.value.filter(l => l.live).map(l => ({ duration: l.live!.duration, fps: l.live!.fps })),
       ...clipClocks(localLayers.value as LocalLayer[]),
     ],
     ((compositor.value?.data?.properties as any)?.sailor_frame?.clock) ?? null))
   // "Something here plays on its own": a wired studio with a loop, or a living image.
   const hasAnimatedSlot = computed(() =>
     layers.value.some(l => l.live && l.live.duration > 0)
     || clipClocks(localLayers.value as LocalLayer[]).length > 0)
   ```
3. Confirm the live loop (the rAF near line 2957) takes the `mc && mc.duration > 0` branch and calls `renderStack(t, …)` after pulling wired frames; with no wired layers `animated` is empty and the render still runs. If the branch is instead gated on `animated.length`, change the gate to `mc.duration > 0`.
4. In `generateVideo`, the encode call becomes:
   ```ts
   const encoded = await encodeFrames({
     frames: storedMotionParams.value!.rendered, fps, width: W, height: H,
     // Transparent WebM when the frame has no background of its own; mp4 otherwise.
     alpha: !hasPaint(background.value),
   })
   ```

- [ ] **Step 4: wire the Frame card**

In `ArtifactFrameNode.vue`:

1. Add `clipClocks` to the import from `~/composables/useCompositorLayers` (line 9) and import `hasPaint` from `~/lib/paint/resolve` if not present.
2. Replace:
   ```ts
   const masterClock = computed(() => deriveMasterClock(
     [
       ...wiredLayers.value.filter(l => l.live).map(l => ({ duration: l.live!.duration, fps: l.live!.fps })),
       ...clipClocks(editor.localLayers.value),
     ],
     (props.data.properties as any)?.sailor_frame?.clock ?? null))
   const hasAnimatedSlot = computed(() =>
     wiredLayers.value.some(l => l.live && l.live.duration > 0)
     || clipClocks(editor.localLayers.value).length > 0)
   ```
3. In `downloadVideo`, the encode call becomes:
   ```ts
   encoded = await encodeFrames({ frames: bake.frames, fps: mc.fps, width: W, height: H, alpha: !hasPaint(editor.background.value) })
   ```

- [ ] **Step 5: verify in the browser (no paid call yet)**

Use the existing dev server on `:3002` (check `lsof -nP -iTCP -sTCP:LISTEN | grep node`; do not start another). Make a throwaway clip folder by hand so the wiring can be seen before the server route exists:

```bash
mkdir -p input/sailor_clips/clip_dev && .venv/bin/python - <<'EOF'
from PIL import Image, ImageDraw
for i in range(24):
    im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = 60 + 30 * (i / 23)
    d.ellipse((128 - r, 128 - r, 128 + r, 128 + r), fill=(240, 90, 120, 255))
    im.save(f'input/sailor_clips/clip_dev/{i:06d}.png')
print('ok')
EOF
```

Then in the Browser pane, open a Frame with an image layer, and in the page console attach the clip to it (the layer array lives on the node's `sailor_localLayers`; use the modal's own `setLocal` through the Vue devtools hook, or temporarily paste `{ clip: { dir: 'sailor_clips/clip_dev', frames: 24, fps: 24, speed: 1, prompt: '', model: 'dev' } }` into the layer via the agent surface). Expected: the layer pulses on the Design tab; with a 2×2 cloner the four copies pulse out of step; the Motion tab shows the clip's length; "Generate as video" is enabled. Take a screenshot as proof. Remove the dev folder afterwards: `rm -r input/sailor_clips/clip_dev`.

- [ ] **Step 6: commit**

```bash
git add frontend/app/components/vue-canvas/CompositorModal.vue frontend/app/components/vue-canvas/ArtifactFrameNode.vue frontend/tests/unit/compositor-master-clock.unit.spec.ts
git commit -m "feat(frame): living images join the master clock, the live loop and a transparent export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: the keying script

**Files:**
- Create: `scripts/clip_key.py`
- Test: `tests-unit/clip_key_test.py`

**Interfaces:**
- Produces a CLI with two subcommands, invoked by Task 6:
  - `clip_key.py flatten <still.png> <out.png>` → prints `KEY:#00ff00` or `KEY:#0000ff` on stdout.
  - `clip_key.py key <in.mp4> <still.png> <key-hex> <out_dir> <trim_last:0|1>` → writes `000000.png …` and `clip.json`, prints JSON `{"frames": N, "fps": F, "width": W, "height": H}`.
- Pure functions (tested): `pick_key_colour(rgba: np.ndarray) -> str`, `flatten_onto(rgba, key_rgb) -> np.ndarray`, `key_alpha(rgb, key_rgb, lo=20.0, hi=60.0) -> np.ndarray`, `suppress_spill(rgb, key_rgb, alpha) -> np.ndarray`, `guard_mask(still_alpha, size_wh, frac=0.04) -> np.ndarray`.

- [ ] **Step 1: write the failing tests**

```python
# tests-unit/clip_key_test.py
"""Keying maths for the Frame's living-image clip (scripts/clip_key.py)."""
import importlib.util
import os

import numpy as np
import pytest
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("clip_key", os.path.join(ROOT, "scripts", "clip_key.py"))
ck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ck)

GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


def rgba(w=8, h=8, colour=(200, 60, 90, 255)):
    a = np.zeros((h, w, 4), dtype=np.uint8)
    a[:, :] = colour
    return a


def test_pick_key_colour_prefers_green_for_a_pink_rose():
    assert ck.pick_key_colour(rgba()) == "#00ff00"


def test_pick_key_colour_switches_to_blue_when_leaves_are_green():
    a = rgba()
    a[0:2, :] = (30, 200, 40, 255)   # 25 % green pixels, well past the 3 % line
    assert ck.pick_key_colour(a) == "#0000ff"


def test_pick_key_colour_ignores_transparent_pixels():
    a = rgba()
    a[0:4, :] = (30, 200, 40, 0)     # green but fully transparent
    assert ck.pick_key_colour(a) == "#00ff00"


def test_flatten_onto_puts_key_behind_transparent_pixels():
    a = rgba()
    a[0, 0] = (0, 0, 0, 0)
    out = ck.flatten_onto(a, GREEN)
    assert out.shape == (8, 8, 3)
    assert tuple(out[0, 0]) == GREEN
    assert tuple(out[4, 4]) == (200, 60, 90)


def test_key_alpha_green_is_transparent_and_rose_is_opaque():
    rgb = np.zeros((2, 2, 3), dtype=np.uint8)
    rgb[0, 0] = GREEN
    rgb[1, 1] = (200, 60, 90)
    alpha = ck.key_alpha(rgb, GREEN)
    assert alpha[0, 0] == pytest.approx(0.0)
    assert alpha[1, 1] == pytest.approx(1.0)


def test_key_alpha_is_soft_between_lo_and_hi():
    # A pixel part-way between green and pink lands strictly between 0 and 1.
    rgb = np.zeros((1, 1, 3), dtype=np.uint8)
    rgb[0, 0] = (60, 200, 60)
    alpha = ck.key_alpha(rgb, GREEN)
    assert 0.0 < alpha[0, 0] < 1.0


def test_suppress_spill_pulls_green_out_of_edge_pixels_only():
    rgb = np.zeros((1, 2, 3), dtype=np.uint8)
    rgb[0, 0] = (120, 220, 120)   # spilled edge pixel
    rgb[0, 1] = (120, 220, 120)   # same colour, but fully opaque interior
    alpha = np.array([[0.5, 1.0]])
    out = ck.suppress_spill(rgb, GREEN, alpha)
    assert out[0, 0, 1] == 120       # G clamped to (R+B)/2 on the edge
    assert out[0, 1, 1] == 220       # interior untouched


def test_guard_mask_dilates_the_still_alpha_by_a_fraction_of_width():
    still = np.zeros((100, 100), dtype=np.uint8)
    still[40:60, 40:60] = 255
    g = ck.guard_mask(still, (100, 100), frac=0.04)   # 4 px reach
    assert g[50, 50] == 1.0
    assert g[50, 63] == 1.0          # within 4 px of the square
    assert g[50, 70] == 0.0          # well outside


def test_guard_mask_resizes_to_the_frame_size():
    still = np.zeros((10, 10), dtype=np.uint8)
    still[:, :] = 255
    g = ck.guard_mask(still, (20, 30), frac=0.0)
    assert g.shape == (30, 20)
    assert g.min() == 1.0


def test_key_frames_end_to_end_writes_transparent_pngs(tmp_path):
    # Three synthetic frames: a pink square on green, the square drifting right.
    frames = []
    for i in range(3):
        f = np.zeros((32, 32, 3), dtype=np.uint8); f[:, :] = GREEN
        f[8:24, 8 + i:24 + i] = (200, 60, 90)
        frames.append(f)
    still = np.zeros((32, 32, 4), dtype=np.uint8); still[8:24, 8:24] = (200, 60, 90, 255)
    out = tmp_path / "clip"
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(out), max_edge=32, trim_last=False)
    assert meta == {"frames": 3, "fps": 24.0, "width": 32, "height": 32}
    im = Image.open(out / "000002.png").convert("RGBA")
    px = np.asarray(im)
    assert px[0, 0, 3] == 0            # green corner → transparent
    assert px[16, 17, 3] == 255        # inside the drifted square → opaque
    assert (out / "clip.json").exists()


def test_key_frames_trim_last_drops_the_returning_frame(tmp_path):
    frames = [np.full((8, 8, 3), 255, dtype=np.uint8) for _ in range(4)]
    still = np.full((8, 8, 4), 255, dtype=np.uint8)
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(tmp_path / "c"), max_edge=8, trim_last=True)
    assert meta["frames"] == 3
```

- [ ] **Step 2: run, expect failure**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/clip_key_test.py -q`
Expected: FAIL, `scripts/clip_key.py` does not exist.

- [ ] **Step 3: implement**

```python
#!/usr/bin/env python
"""Key a video model's opaque frames back to transparency for the Frame's living image.

Invoked by frontend/server/api/frame/animate.post.ts. Two subcommands:

  clip_key.py flatten <still.png> <out.png>
      Composite the RGBA still onto a flat key colour (green, or blue when the still
      has visible green in it). Prints  KEY:#rrggbb  on stdout.

  clip_key.py key <in.mp4> <still.png> <#rrggbb> <out_dir> <trim_last 0|1>
      Decode the clip, key every frame against the colour, multiply by a dilated copy of
      the still's own alpha (the guard), resize to the still's longest edge, write
      000000.png … and clip.json into out_dir. Prints one JSON line with frames/fps/size.

Pure functions are module-level so tests-unit/clip_key_test.py can call them directly.
Uses the venv's imageio + imageio_ffmpeg for decoding — no system ffmpeg needed.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
GREEN_SHARE_LIMIT = 0.03      # more visible green than this ⇒ key on blue instead
KEY_LO, KEY_HI = 20.0, 60.0   # chroma distance: fully keyed below LO, fully kept above HI
GUARD_FRAC = 0.04             # guard reach as a fraction of the still's width


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(v) for v in rgb)


def _from_hex(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def pick_key_colour(rgba: np.ndarray) -> str:
    """Green unless the still's opaque pixels are noticeably green themselves."""
    a = rgba[..., 3] > 128
    if not a.any():
        return _hex(GREEN)
    hsv = np.asarray(Image.fromarray(rgba[..., :3], "RGB").convert("HSV")).astype(np.float32)
    hue = hsv[..., 0] * (360.0 / 255.0)
    sat = hsv[..., 1] / 255.0
    greenish = (np.abs(hue - 120.0) <= 30.0) & (sat > 0.4) & a
    share = greenish.sum() / max(1, a.sum())
    return _hex(BLUE) if share > GREEN_SHARE_LIMIT else _hex(GREEN)


def flatten_onto(rgba: np.ndarray, key_rgb) -> np.ndarray:
    """RGBA → RGB with the key colour behind every transparent pixel (straight alpha)."""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    fg = rgba[..., :3].astype(np.float32)
    bg = np.asarray(key_rgb, dtype=np.float32).reshape(1, 1, 3)
    return np.clip(fg * a + bg * (1.0 - a), 0, 255).astype(np.uint8)


def _cbcr(rgb: np.ndarray):
    r = rgb[..., 0].astype(np.float32); g = rgb[..., 1].astype(np.float32); b = rgb[..., 2].astype(np.float32)
    cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return cb, cr


def key_alpha(rgb: np.ndarray, key_rgb, lo: float = KEY_LO, hi: float = KEY_HI) -> np.ndarray:
    """Alpha in [0,1] from the chroma distance to the key colour: 0 at/below `lo`, 1 at/above `hi`,
    a smooth ramp between. Luma is ignored on purpose so shading on the flat ground still keys."""
    cb, cr = _cbcr(rgb)
    kcb, kcr = _cbcr(np.asarray(key_rgb, dtype=np.uint8).reshape(1, 1, 3))
    d = np.sqrt((cb - kcb) ** 2 + (cr - kcr) ** 2)
    t = np.clip((d - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def suppress_spill(rgb: np.ndarray, key_rgb, alpha: np.ndarray) -> np.ndarray:
    """On partly transparent pixels, clamp the key channel to the mean of the other two so a
    green (or blue) fringe does not ride into the composite. Opaque pixels are untouched."""
    out = rgb.astype(np.float32).copy()
    kch = int(np.argmax(np.asarray(key_rgb)))
    others = [c for c in range(3) if c != kch]
    edge = alpha < 0.999
    mean_other = (out[..., others[0]] + out[..., others[1]]) * 0.5
    out[..., kch] = np.where(edge, np.minimum(out[..., kch], mean_other), out[..., kch])
    return np.clip(out, 0, 255).astype(np.uint8)


def guard_mask(still_alpha: np.ndarray, size_wh, frac: float = GUARD_FRAC) -> np.ndarray:
    """The still's alpha, resized to the frame and grown outward by `frac` of the frame width.
    Returns float32 in [0,1], shape (h, w)."""
    w, h = int(size_wh[0]), int(size_wh[1])
    im = Image.fromarray(still_alpha.astype(np.uint8), "L").resize((w, h), Image.BILINEAR)
    reach = int(round(frac * w))
    if reach > 0:
        im = im.filter(ImageFilter.MaxFilter(2 * reach + 1))
    return (np.asarray(im).astype(np.float32) > 127.0).astype(np.float32)


def _fit(w, h, max_edge):
    m = max(w, h)
    if m <= max_edge:
        return w, h
    s = max_edge / float(m)
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def key_frames(frames, fps: float, still_rgba: np.ndarray, key_rgb, out_dir: str,
               max_edge: int, trim_last: bool) -> dict:
    """Key every RGB frame, guard it with the still, write PNGs + clip.json. Returns meta."""
    if trim_last and len(frames) > 1:
        frames = frames[:-1]           # first == last on a first/last-frame model: don't hold it twice
    os.makedirs(out_dir, exist_ok=True)
    fh, fw = frames[0].shape[0], frames[0].shape[1]
    ow, oh = _fit(fw, fh, max_edge)
    guard = guard_mask(still_rgba[..., 3], (ow, oh))
    n = 0
    for i, f in enumerate(frames):
        if (f.shape[1], f.shape[0]) != (ow, oh):
            f = np.asarray(Image.fromarray(f, "RGB").resize((ow, oh), Image.LANCZOS))
        a = key_alpha(f, key_rgb) * guard
        rgb = suppress_spill(f, key_rgb, a)
        rgba = np.dstack([rgb, np.clip(a * 255.0, 0, 255).astype(np.uint8)])
        rgba[a <= 0.0, :3] = 0        # zero hidden colour: smaller PNGs, no stray key tint
        Image.fromarray(rgba, "RGBA").save(os.path.join(out_dir, "%06d.png" % i), optimize=True)
        n += 1
    meta = {"frames": n, "fps": float(fps), "width": ow, "height": oh}
    with open(os.path.join(out_dir, "clip.json"), "w") as fh_:
        json.dump({**meta, "key": _hex(key_rgb)}, fh_)
    return meta


def _read_video(path):
    import imageio.v2 as iio
    reader = iio.get_reader(path, "ffmpeg")
    fps = float(reader.get_meta_data().get("fps") or 24.0)
    frames = [np.asarray(fr)[..., :3] for fr in reader]
    reader.close()
    if not frames:
        raise RuntimeError("the clip has no frames")
    return frames, fps


def main(argv):
    if len(argv) >= 4 and argv[1] == "flatten":
        still = np.asarray(Image.open(argv[2]).convert("RGBA"))
        key = pick_key_colour(still)
        Image.fromarray(flatten_onto(still, _from_hex(key)), "RGB").save(argv[3])
        print("KEY:" + key)
        return 0
    if len(argv) >= 7 and argv[1] == "key":
        frames, fps = _read_video(argv[2])
        still = np.asarray(Image.open(argv[3]).convert("RGBA"))
        key = _from_hex(argv[4])
        max_edge = max(still.shape[0], still.shape[1])
        meta = key_frames(frames, fps, still, key, argv[5], max_edge, argv[6] == "1")
        print(json.dumps(meta))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # one line on stderr is what the route surfaces to the panel
        print(f"clip_key failed: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 4: run, expect pass**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/clip_key_test.py -q`
Expected: `11 passed`. If `test_key_alpha_is_soft_between_lo_and_hi` fails, the sample colour sits outside the ramp; adjust the sample to `(80, 200, 80)` rather than the constants. Also confirm decode works once by hand on any small mp4 in `input/` or `output/`: `.venv/bin/python scripts/clip_key.py key <some.mp4> <some_rgba.png> '#00ff00' /tmp/clipcheck 0` prints a JSON line.

- [ ] **Step 5: commit**

```bash
git add scripts/clip_key.py tests-unit/clip_key_test.py
git commit -m "feat(scripts): clip_key — flatten a still onto a key colour, key a clip back to transparency

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: the Animate route

**Files:**
- Create: `frontend/app/data/clip-models.ts`
- Create: `frontend/server/api/frame/animate.post.ts`
- Modify: `frontend/server/utils/falRun.ts` (add `firstFalVideoUrl` beside `firstFalImageUrl`, line 136)
- Modify: `frontend/server/lib/nitroApiPaths.ts` (`NITRO_API_PREFIXES`, line 31: add `'/api/frame'`)
- Test: `frontend/tests/unit/clip-models.unit.spec.ts`

**Interfaces:**
- Consumes: `runFal(app, input)`, `uploadToFalStorage(bytes, name, contentType)`, `runReplicate(model, input, token, opts)`, `requireReplicateToken()`, `firstOutputUrl(out)`, `assertRateLimit(event, name, max, windowMs)`, `VIDEO_MODEL_USD` from `~~/app/data/video-prices`, the Task 5 script.
- Produces:
  ```ts
  // app/data/clip-models.ts
  export interface ClipModel { id: 'seedance-2.0' | 'hailuo-h3' | 'luma-ray-2-720p'; label: string; durations: number[]; defaultDuration: number; provider: 'fal' | 'replicate'; loopsItself: boolean }
  export const CLIP_MODELS: ClipModel[]
  export function clipModel(id: string): ClipModel | null
  export function clipPriceUsd(id: string, seconds: number): number | null   // VIDEO_MODEL_USD row × seconds / 5
  // POST /api/frame/animate  body { image: dataUrl, prompt, model, seconds }  →  { dir, frames, fps, model, prompt }
  ```

- [ ] **Step 1: write the failing test**

```ts
// frontend/tests/unit/clip-models.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { CLIP_MODELS, clipModel, clipPriceUsd } from '~/data/clip-models'

describe('clip models', () => {
  it('offers exactly the three rows the spec names, with sentence-case labels', () => {
    expect(CLIP_MODELS.map(m => m.id)).toEqual(['luma-ray-2-720p', 'seedance-2.0', 'hailuo-h3'])
    expect(CLIP_MODELS.map(m => m.label)).toEqual(['Luma, loops by itself', 'Seedance', 'Hailuo'])
  })
  it('lengths follow what each model accepts', () => {
    expect(clipModel('luma-ray-2-720p')!.durations).toEqual([5, 9])
    expect(clipModel('seedance-2.0')!.durations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(clipModel('hailuo-h3')!.durations).toEqual([5, 6, 10])
    expect(CLIP_MODELS.every(m => m.durations.includes(m.defaultDuration))).toBe(true)
  })
  it('only Luma loops by itself', () => {
    expect(CLIP_MODELS.filter(m => m.loopsItself).map(m => m.id)).toEqual(['luma-ray-2-720p'])
  })
  it('prices scale with length from the 5 s row', () => {
    expect(clipPriceUsd('seedance-2.0', 5)).toBeCloseTo(0.6)
    expect(clipPriceUsd('seedance-2.0', 10)).toBeCloseTo(1.2)
    expect(clipPriceUsd('nope', 5)).toBeNull()
  })
})
```

- [ ] **Step 2: run, expect failure**

Run: `cd frontend && npx vitest run tests/unit/clip-models.unit.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: implement the catalog**

```ts
// frontend/app/data/clip-models.ts
// The three image-to-video models the Frame's Animate section offers for a living image.
// Durations mirror comfy_api_nodes/video_models.py (Seedance's list trimmed to ≤ 12 s: a
// loop longer than that is rarely what a layer wants and costs accordingly).
import { VIDEO_MODEL_USD } from '~/data/video-prices'

export interface ClipModel {
  id: 'seedance-2.0' | 'hailuo-h3' | 'luma-ray-2-720p'
  label: string
  durations: number[]
  defaultDuration: number
  provider: 'fal' | 'replicate'
  /** Luma has a native loop flag; the others loop by first = last frame. */
  loopsItself: boolean
}

export const CLIP_MODELS: ClipModel[] = [
  { id: 'luma-ray-2-720p', label: 'Luma, loops by itself', durations: [5, 9], defaultDuration: 5, provider: 'replicate', loopsItself: true },
  { id: 'seedance-2.0', label: 'Seedance', durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], defaultDuration: 5, provider: 'fal', loopsItself: false },
  { id: 'hailuo-h3', label: 'Hailuo', durations: [5, 6, 10], defaultDuration: 5, provider: 'fal', loopsItself: false },
]

export function clipModel(id: string): ClipModel | null {
  return CLIP_MODELS.find(m => m.id === id) ?? null
}

/** Price for one attempt, scaled from the catalog's per-5-second row. */
export function clipPriceUsd(id: string, seconds: number): number | null {
  const row = VIDEO_MODEL_USD[id]
  if (!row) return null
  return row.usd * (Math.max(1, seconds) / 5)
}
```

- [ ] **Step 4: run, expect pass**

Run: `cd frontend && npx vitest run tests/unit/clip-models.unit.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: add the fal video reader and the Nitro prefix**

In `server/utils/falRun.ts` after `firstFalImageUrl`:

```ts
/** First video URL from a fal video result ({ video: { url } }). */
export function firstFalVideoUrl(result: unknown): string | null {
  const url = (result as { video?: { url?: string } })?.video?.url
  return typeof url === 'string' && url ? url : null
}
```

In `server/lib/nitroApiPaths.ts`, add `'/api/frame',` to `NITRO_API_PREFIXES` (any position in the array). Check the file's header comment for a reachability guard test and run it if one exists (`grep -rn nitroApiPaths frontend/tests/unit`).

- [ ] **Step 6: write the route**

```ts
// frontend/server/api/frame/animate.post.ts
/**
 * Animate a Frame image layer: make a looping, transparent clip from a still.
 *
 *   1. flatten the RGBA still onto a key colour (scripts/clip_key.py flatten)
 *   2. call the video model with the still as first AND last frame (Luma: loop flag)
 *   3. key every returned frame back to transparency (scripts/clip_key.py key)
 *   4. write input/sailor_clips/<id>/000000.png … + clip.json
 *
 * The model call goes through runFal / runReplicate so the ledger hold, prompt
 * moderation, polling and release-on-failure are the shared ones. The Python steps
 * are execFile'd from the repo venv, like voice-clone/from-youtube.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRateLimit } from '../../lib/rateLimit'
import { runFal, firstFalVideoUrl } from '../../utils/falRun'
import { uploadToFalStorage } from '../../utils/falStorage'
import { clipModel } from '~~/app/data/clip-models'

interface Body { image?: string; prompt?: string; model?: string; seconds?: number }

const ROOT = path.resolve(process.cwd(), '..')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const SCRIPT = path.join(ROOT, 'scripts', 'clip_key.py')
const CLIPS_DIR = path.join(ROOT, 'input', 'sailor_clips')
const PROMPT_SUFFIX = (key: 'green' | 'blue') =>
  `, plain flat ${key} background, no shadows, camera locked, gentle motion`
const LUMA_AR = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const

function py(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
      resolve(out || '')
    })
  })
}

function dataUrlBytes(dataUrl: string): Buffer {
  const i = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:image/') || i < 0) throw createError({ statusCode: 400, message: 'image must be a PNG data URL' })
  return Buffer.from(dataUrl.slice(i + 1), 'base64')
}

/** Closest Luma aspect to the still (Luma needs one even for image-to-video). */
function lumaAspect(w: number, h: number): string {
  const r = w / Math.max(1, h)
  let best = LUMA_AR[0] as string, err = Infinity
  for (const ar of LUMA_AR) {
    const [a, b] = ar.split(':').map(Number)
    const e = Math.abs(Math.log(r / (a / b)))
    if (e < err) { err = e; best = ar }
  }
  return best
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'frame-animate', 6, 600_000)
  const body = await readBody<Body>(event)
  const spec = clipModel(body?.model ?? '')
  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })
  if (!spec) throw createError({ statusCode: 400, message: 'unknown model' })
  const seconds = spec.durations.includes(Number(body.seconds)) ? Number(body.seconds) : spec.defaultDuration
  const prompt = (body.prompt ?? '').trim()

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sailor-clip-'))
  try {
    // 1. flatten onto the key colour
    const stillPath = path.join(tmp, 'still.png')
    const flatPath = path.join(tmp, 'flat.png')
    await writeFile(stillPath, dataUrlBytes(body.image))
    const keyLine = (await py(['flatten', stillPath, flatPath], 60_000)).split('\n').find(l => l.startsWith('KEY:'))
    if (!keyLine) throw createError({ statusCode: 500, message: 'Could not prepare the still' })
    const keyHex = keyLine.slice(4).trim()
    const keyName = keyHex === '#0000ff' ? 'blue' : 'green'
    const fullPrompt = (prompt || 'the subject moves gently') + PROMPT_SUFFIX(keyName)

    // the flattened still must be a URL for both providers
    const flatBytes = await readFile(flatPath)
    const stillUrl = await uploadToFalStorage(new Uint8Array(flatBytes), 'still.png', 'image/png')

    // 2. the model
    let videoUrl: string | null = null
    if (spec.id === 'seedance-2.0') {
      const out = await runFal('bytedance/seedance-2.0/image-to-video', {
        prompt: fullPrompt, duration: String(seconds), resolution: '720p',
        image_url: stillUrl, end_image_url: stillUrl,
      }, { pollDeadlineMs: 900_000 })
      videoUrl = firstFalVideoUrl(out)
    } else if (spec.id === 'hailuo-h3') {
      const out = await runFal('minimax/h3/image-to-video', {
        prompt: fullPrompt, duration: seconds, resolution: '768P', prompt_expansion_mode: 'balanced',
        image_url: stillUrl, end_image_url: stillUrl,
      }, { pollDeadlineMs: 900_000 })
      videoUrl = firstFalVideoUrl(out)
    } else {
      const token = requireReplicateToken()
      const { width, height } = await pngSize(flatBytes)
      const out = await runReplicate('luma/ray-2-720p', {
        prompt: fullPrompt, aspect_ratio: lumaAspect(width, height), duration: seconds, loop: true,
        start_image_url: stillUrl,
      }, token, { timeoutMs: 900_000 })
      videoUrl = firstOutputUrl(out)
    }
    if (!videoUrl) throw createError({ statusCode: 502, message: 'The model returned no video' })

    // 3. key it back to transparency
    const mp4Path = path.join(tmp, 'clip.mp4')
    const res = await fetch(videoUrl)
    if (!res.ok) throw createError({ statusCode: 502, message: `Could not download the clip (${res.status})` })
    await writeFile(mp4Path, Buffer.from(await res.arrayBuffer()))
    const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const outDir = path.join(CLIPS_DIR, id)
    const metaLine = (await py(['key', mp4Path, stillPath, keyHex, outDir, spec.loopsItself ? '0' : '1'], 300_000))
      .split('\n').map(l => l.trim()).filter(Boolean).pop()
    const meta = JSON.parse(metaLine || '{}') as { frames?: number; fps?: number }
    if (!meta.frames || !meta.fps) throw createError({ statusCode: 500, message: 'Keying produced no frames' })

    return { dir: `sailor_clips/${id}`, frames: meta.frames, fps: meta.fps, model: spec.id, prompt }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

/** PNG header width/height (IHDR is always the first chunk). */
async function pngSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  if (bytes.length < 24) return { width: 1, height: 1 }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
```

`runReplicate`, `requireReplicateToken` and `firstOutputUrl` are auto-imported from `server/utils/replicate.ts` (the remove-bg route uses them the same way). If the Nitro auto-import does not pick them up, import explicitly from `../../utils/replicate`.

- [ ] **Step 7: smoke the route without paying**

Confirm it 400s cleanly and reaches the Python step (no model call yet):

```bash
curl -s -X POST http://127.0.0.1:3002/api/frame/animate -H 'content-type: application/json' -d '{"model":"seedance-2.0"}' ; echo
```
Expected: `{"statusCode":400,"message":"image is required"}` (or the app's error envelope). Then with a real 8×8 transparent PNG data URL and `"model":"nope"` → `unknown model`. Do NOT send a valid model here; the paid call is Task 8.

- [ ] **Step 8: commit**

```bash
git add frontend/app/data/clip-models.ts frontend/tests/unit/clip-models.unit.spec.ts frontend/server/utils/falRun.ts frontend/server/lib/nitroApiPaths.ts frontend/server/api/frame/animate.post.ts
git commit -m "feat(frame): /api/frame/animate — still → keyed video → transparent clip folder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: the Animate panel

**Files:**
- Create: `frontend/app/composables/useLayerAnimate.ts`
- Create: `frontend/app/components/vue-canvas/compositor/CompositorAnimatePanel.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — mount the panel directly after the Displacement map block (~line 8840, before the Mask select), import at the top beside `CompositorClonerPanel` (line 95)
- Test: `frontend/tests/unit/frame-animate-panel.unit.spec.ts`

**Interfaces:**
- Consumes: `ImageClip`, `CLIP_SPEED_MIN/MAX` (Task 1), `CLIP_MODELS`, `clipModel`, `clipPriceUsd` (Task 6), the route (Task 6), `ensureLayerImages` (Task 3), the modal's `selectedLocal` / `setLocal(id, patch)` / `renderStack()`.
- Produces:
  ```ts
  // useLayerAnimate.ts
  export function useLayerAnimate(): {
    busy: Ref<boolean>; error: Ref<string>
    animate(layer: ImageLayer, opts: { prompt: string; model: string; seconds: number }): Promise<ImageClip>
  }
  // CompositorAnimatePanel.vue
  props: { layer: ImageLayer; busy: boolean; error: string }
  emits: { generate: [{ prompt: string; model: string; seconds: number }], speed: [number], remove: [] }
  ```

- [ ] **Step 1: write the failing test**

```ts
// @vitest-environment happy-dom
// frontend/tests/unit/frame-animate-panel.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
import { createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const living = (): ImageLayer => ({
  ...still(),
  clip: { dir: 'sailor_clips/c', frames: 24, fps: 24, speed: 1, prompt: 'petals sway', model: 'seedance-2.0' },
})
const mountP = (layer: ImageLayer, busy = false, error = '') => mount(Panel, { props: { layer, busy, error } })

describe('CompositorAnimatePanel', () => {
  it('shows prompt, model, length and a priced Generate button for a still', () => {
    const w = mountP(still())
    expect(w.find('textarea, input[type="text"]').exists()).toBe(true)
    const models = w.find('select[data-role="model"]')
    expect(models.findAll('option').map(o => o.text())).toEqual(['Luma, loops by itself', 'Seedance', 'Hailuo'])
    const btn = w.find('button[data-role="generate"]')
    expect(btn.text()).toMatch(/Generate/)
    expect(btn.text()).toMatch(/\$0\.40/)          // Luma default, 5 s
    expect(w.find('[data-role="speed"]').exists()).toBe(false)
    expect(w.find('button[data-role="remove"]').exists()).toBe(false)
  })
  it('length options follow the chosen model', async () => {
    const w = mountP(still())
    await w.find('select[data-role="model"]').setValue('hailuo-h3')
    expect(w.find('select[data-role="length"]').findAll('option').map(o => o.text())).toEqual(['5 s', '6 s', '10 s'])
    await w.find('select[data-role="length"]').setValue('10')
    expect(w.find('button[data-role="generate"]').text()).toMatch(/\$0\.60/)   // 0.30 × 2
  })
  it('emits generate with prompt, model and seconds', async () => {
    const w = mountP(still())
    await w.find('textarea, input[type="text"]').setValue('petals open and settle')
    await w.find('select[data-role="model"]').setValue('seedance-2.0')
    await w.find('select[data-role="length"]').setValue('6')
    await w.find('button[data-role="generate"]').trigger('click')
    expect(w.emitted('generate')![0][0]).toEqual({ prompt: 'petals open and settle', model: 'seedance-2.0', seconds: 6 })
  })
  it('disables Generate while busy and shows the error text', () => {
    const w = mountP(still(), true, 'The model returned no video')
    expect((w.find('button[data-role="generate"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.text()).toContain('The model returned no video')
  })
  it('with a clip: shows speed and remove, prefilled from the clip, and emits both', async () => {
    const w = mountP(living())
    expect(w.find('[data-role="speed"]').exists()).toBe(true)
    expect((w.find('textarea, input[type="text"]').element as HTMLInputElement).value).toBe('petals sway')
    const speed = w.findAllComponents({ name: 'StudioSlider' }).find(s => s.props('label') === 'Speed')!
    speed.vm.$emit('update:modelValue', 2)
    expect(w.emitted('speed')![0][0]).toBe(2)
    await w.find('button[data-role="remove"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: run, expect failure**

Run: `cd frontend && npx vitest run tests/unit/frame-animate-panel.unit.spec.ts`
Expected: FAIL, component not found.

- [ ] **Step 3: implement the composable**

```ts
// frontend/app/composables/useLayerAnimate.ts
// Client side of /api/frame/animate: turn an image layer's still into a looping,
// transparent clip. The route does the model call and the keying; this only ships the
// still up and hands the clip back. The caller attaches it with setLocal.
import { ref } from 'vue'
import type { ImageClip } from '~/lib/compositor/clip'
import { imageLayerUrl, type ImageLayer } from '~/composables/useCompositorLayers'

async function stillAsDataUrl(layer: ImageLayer): Promise<string> {
  const res = await fetch(imageLayerUrl(layer.filename))
  if (!res.ok) throw new Error('Could not read the layer image')
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the layer image'))
    r.readAsDataURL(blob)
  })
}

export function useLayerAnimate() {
  const busy = ref(false)
  const error = ref('')

  async function animate(layer: ImageLayer, opts: { prompt: string; model: string; seconds: number }): Promise<ImageClip> {
    busy.value = true; error.value = ''
    try {
      const image = await stillAsDataUrl(layer)
      const res = await $fetch<{ dir: string; frames: number; fps: number; model: string; prompt: string }>('/api/frame/animate', {
        method: 'POST', body: { image, prompt: opts.prompt, model: opts.model, seconds: opts.seconds },
      })
      return { dir: res.dir, frames: res.frames, fps: res.fps, speed: 1, prompt: res.prompt, model: res.model }
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Animate failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  return { busy, error, animate }
}
```

- [ ] **Step 4: implement the panel**

```vue
<!-- frontend/app/components/vue-canvas/compositor/CompositorAnimatePanel.vue -->
<script setup lang="ts">
// Animate section for a selected image layer: prompt / model / length / Generate, and
// once a clip exists, Speed + Remove clip. Pure presentation — the modal owns the call.
import { computed, ref, watch } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { CLIP_MODELS, clipModel, clipPriceUsd } from '~/data/clip-models'
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN } from '~/lib/compositor/clip'
import type { ImageLayer } from '~/composables/useCompositorLayers'

const props = defineProps<{ layer: ImageLayer; busy: boolean; error: string }>()
const emit = defineEmits<{
  generate: [payload: { prompt: string; model: string; seconds: number }]
  speed: [value: number]
  remove: []
}>()

const prompt = ref(props.layer.clip?.prompt ?? '')
const model = ref(props.layer.clip?.model ?? CLIP_MODELS[0]!.id)
const seconds = ref(clipModel(model.value)?.defaultDuration ?? 5)

const spec = computed(() => clipModel(model.value) ?? CLIP_MODELS[0]!)
watch(model, () => { if (!spec.value.durations.includes(seconds.value)) seconds.value = spec.value.defaultDuration })
watch(() => props.layer.id, () => {
  prompt.value = props.layer.clip?.prompt ?? ''
  model.value = props.layer.clip?.model ?? CLIP_MODELS[0]!.id
})

const price = computed(() => {
  const usd = clipPriceUsd(model.value, seconds.value)
  return usd == null ? '' : `$${usd.toFixed(2)}`
})
const hasClip = computed(() => !!props.layer.clip)
const fieldCls = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
</script>

<template>
  <div class="mt-3">
    <div class="panel-label">Animate</div>
    <div class="mt-2 flex flex-col gap-2">
      <div>
        <div class="panel-label mb-1.5">Prompt</div>
        <textarea v-model="prompt" rows="2" :class="fieldCls" placeholder="What should move, and how" />
      </div>
      <div>
        <div class="panel-label mb-1.5">Model</div>
        <select v-model="model" data-role="model" :class="fieldCls">
          <option v-for="m in CLIP_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
      </div>
      <div>
        <div class="panel-label mb-1.5">Length</div>
        <select v-model.number="seconds" data-role="length" :class="fieldCls">
          <option v-for="d in spec.durations" :key="d" :value="d">{{ d }} s</option>
        </select>
      </div>
      <button type="button" data-role="generate"
        class="text-xs px-2 py-1.5 rounded border border-white/[0.06] bg-[#2563eb]/30 text-white hover:bg-[#2563eb]/40 disabled:opacity-50"
        :disabled="busy"
        @click="emit('generate', { prompt: prompt.trim(), model, seconds })">
        {{ busy ? 'Generating…' : `Generate${price ? ' · ' + price : ''}` }}
      </button>
      <div v-if="error" class="text-[11px] text-red-300/90">{{ error }}</div>
      <template v-if="hasClip">
        <div data-role="speed">
          <StudioSlider :model-value="layer.clip!.speed" @update:model-value="(v: number) => emit('speed', v)"
            label="Speed" :min="CLIP_SPEED_MIN" :max="CLIP_SPEED_MAX" :step="0.05" :bindable="false" />
        </div>
        <button type="button" data-role="remove"
          class="text-xs px-2 py-1 rounded border border-white/[0.06] bg-white/[0.04] text-white/80 hover:bg-white/[0.06] self-start"
          @click="emit('remove')">
          Remove clip
        </button>
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 5: mount it in the modal**

In `CompositorModal.vue`:

1. Import beside `CompositorClonerPanel` (line 95):
   ```ts
   import CompositorAnimatePanel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
   import { useLayerAnimate } from '~/composables/useLayerAnimate'
   ```
2. Script, near `const layerEdit = useLayerImageEdit()` (line 632):
   ```ts
   const layerAnimate = useLayerAnimate()
   async function animateLayer(layer: any, opts: { prompt: string; model: string; seconds: number }) {
     if (!layer || layer.kind !== 'image' || layerAnimate.busy.value) return
     try {
       const clip = await layerAnimate.animate(layer, opts)
       setLocal(layer.id, { clip } as any)
       await ensureLayerImages(localLayers.value as LocalLayer[])
       renderStack()
     } catch { /* error text is on layerAnimate.error; the layer is untouched */ }
   }
   function setClipSpeed(layer: any, speed: number) {
     if (!layer?.clip) return
     setLocal(layer.id, { clip: { ...layer.clip, speed: Math.max(0.25, Math.min(4, speed)) } } as any)
   }
   function removeClip(layer: any) { if (layer?.clip) setLocal(layer.id, { clip: undefined } as any) }
   ```
   (`renderStack` is the modal's existing repaint; if its name differs at that point in the file, use the one `setLocal` already triggers and drop the explicit call.)
3. Template, directly after the Displacement map block's closing `</div>` (before the Mask select, ~line 8841):
   ```html
   <!-- Animate: make this still a looping, transparent clip -->
   <CompositorAnimatePanel
     v-if="selectedLocal?.kind === 'image'"
     :layer="selectedLocal as any"
     :busy="layerAnimate.busy.value"
     :error="layerAnimate.error.value"
     @generate="(o) => animateLayer(selectedLocal, o)"
     @speed="(v) => setClipSpeed(selectedLocal, v)"
     @remove="removeClip(selectedLocal)"
   />
   ```

- [ ] **Step 6: run, expect pass**

Run: `cd frontend && npx vitest run tests/unit/frame-animate-panel.unit.spec.ts`
Expected: PASS, 5 tests. Then `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -E "CompositorAnimatePanel|useLayerAnimate|CompositorModal" || echo clean` → `clean` (pre-existing errors elsewhere in CompositorModal are not yours; compare against `git stash`-free baseline by checking the same grep on `HEAD` with `git show HEAD:…` only if in doubt).

- [ ] **Step 7: verify the panel in the browser, no paid call**

On the `:3002` server, open a Frame, select an image layer, confirm the Animate section renders under Displacement map with the priced button, that changing model changes the length options, and that with the Task 4 dev clip attached the Speed slider and Remove clip appear and Remove returns the still. Screenshot. Do not press Generate.

- [ ] **Step 8: commit**

```bash
git add frontend/app/composables/useLayerAnimate.ts frontend/app/components/vue-canvas/compositor/CompositorAnimatePanel.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/unit/frame-animate-panel.unit.spec.ts
git commit -m "feat(frame): Animate section on an image layer — prompt, model, length, speed, remove

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: one paid run on the rose, and the write-up

This task is run by the parent session, not a subagent, because it spends money and needs Julien's Frame.

**Files:**
- Modify: `docs/STATE.md` (add the living-image entry)
- Dashboard artifact (see Global constraints)

- [ ] **Step 1: pick the cheapest probe**

In Julien's rose Frame, select the rose image layer, model "Luma, loops by itself", length 5 s, prompt `petals sway gently and settle`. Press Generate once. Expected cost about $0.40. Note the actual ledger charge.

- [ ] **Step 2: judge the result on four points**

- Edges: zoom on a petal edge in the Design tab. Green fringe = raise `KEY_HI` or lower spill tolerance in `scripts/clip_key.py`; eaten petals = lower `KEY_LO`.
- Loop seam: play in the Motion tab and watch the wrap. A visible jump on Luma means its loop flag did not hold; try Seedance once (first = last frame, about $0.60 for 5 s) before touching code.
- Clones: with the 2×2 cloner and Phase 1, the four roses move out of step.
- Export: background No Fill → "Generate as video" → the output is a `.webm`; drop it on a coloured layer or open it in a browser to confirm transparency.

- [ ] **Step 3: write it up**

In `docs/STATE.md`, one entry: what landed, the real cost of the probe, what the edges and the seam looked like, and what is still owed (video matting model if edges disappoint, hosted-mode storage of clip folders). Then update the dashboard artifact per the Global constraints. Commit `docs/STATE.md` with the private index:

```bash
git add docs/STATE.md
git commit -m "docs(state): living image clip — paid probe on the rose, edges and seam noted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review

- **Spec coverage.** §1 layer field → Task 3. §2 playback, cache, master clock, rate mismatch, card parity → Tasks 1, 3, 4. §3 clones + Phase → Tasks 1, 2, 3. §4 route, key colour, model calls, keying, guard, resize, folder, price → Tasks 5, 6. §5 panel (prompt, model, length, speed, priced Generate, remove) → Task 7. Cost confirmation: the modal has no confirm dialog for its other paid tools (background removal, image edit call the route directly), so the price on the button is the gate, matching them; noted here as the one deviation from the spec's wording. §6 failure leaves the layer untouched (Task 7 `animateLayer` only sets the clip on success), missing folder paints the still (Task 3 `loadClip` refuses a partial folder) — the "small warning on the layer row" is NOT built; it is listed as owed in Task 8's write-up. Alpha export → Task 4. §7 out of scope respected. §8 tests → Tasks 1-7 plus the hand run in Task 8.
- **Placeholders.** None; every step carries its code or exact command.
- **Type consistency.** `ImageClip` fields (`dir, frames, fps, speed, prompt, model`) are identical in Tasks 1, 3, 4, 6 (route return adds none; `speed: 1` is set client-side in Task 7's composable). `clipFrameFor(layer, tSec, k, n)` and `clipClocks(layers)` match between Tasks 3 and 4. `CloneTransform.k/.n` (Task 2) are read as `_cloneSlot` in Task 3. `Cloner.phase` (Task 2) is read in Task 3's `clipFrameFor`. The panel's emitted `{ prompt, model, seconds }` (Task 7) matches `useLayerAnimate.animate` and the route body (Task 6).
