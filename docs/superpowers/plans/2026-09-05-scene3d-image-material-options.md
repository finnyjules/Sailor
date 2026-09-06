# 3D Studio — Image Material Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 3D Studio's `image` material from a three-control stub (upload, roughness, metalness) into a fully art-directable surface — control over how the picture wraps, how densely it repeats, how it is cropped and rotated, how it is tinted and adjusted, whether it is transparent or self-lit, and how it is projected onto geometry that has no usable UVs.

**Architecture:** The `image` material builds a `MeshStandardMaterial` whose `.map` is a texture loaded from the ComfyUI input directory (`app/lib/scene3d/materials.ts`, `case 'image':`). Everything this plan adds falls into three layers:

1. **Texture-transform layer** (new `app/lib/scene3d/imageMap.ts`) — wrap mode, tiling, offset, rotation, flip, fit. These are per-`THREE.Texture` properties (`repeat`, `offset`, `rotation`, `center`, `wrapS/wrapT`), so they cost nothing at draw time and need no shader work. **This layer requires the image material to own its texture rather than share the module-level `imageCache` — Task 3 makes that change, and it also fixes a live bug.**
2. **Material-property layer** (`materials.ts`) — tint, transparency, cutout, glow, flat/unlit. Plain `THREE.Material` fields set at build time and updated in place.
3. **Shader layer** (new `app/lib/scene3d/imageShader.ts`) — colour adjustments and projection modes, injected with `onBeforeCompile` in the style the `gradient`, `fresnel` and `opalescent` materials already use.

Declaration follows the studio's existing three-seam contract for every control: a `SceneControl` in `app/lib/scene3d/controls.ts` (the schema — agent vocabulary, motion targets, Collection bindings), an entry in `app/lib/scene3d/panelPresentation.ts` (which card the row lands in and in what order), and — only for controls that are not a plain slider/select/switch/colour — a `#control-ui.*` slot in `Scene3DStudioSurface.vue`. The panel is permissive: a new control whose `group` is `'Material'` draws in the Material card even if nobody adds it to `MATERIAL_BODY`, so `panelPresentation.ts` edits are about ORDER and CARD PLACEMENT, not about visibility.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4, three.js r171 (`MeshStandardMaterial`, `MeshBasicMaterial`, `onBeforeCompile`), Vitest (`tests/unit/**/*.unit.spec.ts`, node environment), Nitro server routes, fal (for the texture generator).

## Global Constraints

- **Vue has priority over LiteGraph.** Every change in this plan is frontend/Vue or `lib/scene3d`; nothing touches `custom_nodes/sailor_bridge`.
- **UI copy is sentence case and never exposes an internal identifier.** Every `select` whose stored values are internal (`'clamp'`, `'planar'`, `'cover'`) MUST carry an `optionLabels` array with display text. No label, hint, or blurb starts lowercase.
- **Never model a boolean as a two-option select.** `ControlSpec` has `kind: 'switch'`; a select would write the string `'on'` into a boolean field and corrupt the document. See the "Booleans" section of the module doc at the top of `app/lib/scene3d/controls.ts`.
- **`agent` and `animatable` move together.** A control declared only so the inspector can draw it carries `agent: false, animatable: false`. Controls in this plan are agent-visible and animatable by default (they are genuine creative dials) EXCEPT where a step says otherwise.
- **Colour conventions:** action blue is an accent only; purple is banned.
- **Never write `texture.needsUpdate = true` to make a UV-transform change take effect.** `needsUpdate` re-uploads the pixel data to the GPU. `repeat` / `offset` / `rotation` / `center` are picked up automatically because `Texture.matrixAutoUpdate` defaults to true. The ONE exception is `wrapS` / `wrapT`, which are sampler parameters set at upload time and DO require `needsUpdate` — and only when the wrap mode actually changed.
- **Unit test command:** `cd frontend && npx vitest run tests/unit/<file>`
- **Typecheck command:** `cd frontend && npx nuxt typecheck` (there is no `vue-tsc` binary and no `typecheck` npm script in this repo).
- **Dev servers:** frontend `cd frontend && npm run dev`; use `127.0.0.1`, never `localhost` (localhost returns 426). ComfyUI: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python main.py --listen 127.0.0.1 --port 8188`.
- **Commit hygiene:** stage only the files each task names. Never `git stash` — other sessions may be working in this tree.

## File Structure

**New files**

- `frontend/app/lib/scene3d/imageMap.ts` — the whole texture-transform layer. Exports `imageTilingXY`, `imageFitTransform`, `applyImageTransform`. Imports `three` (for the wrap constants and `THREE.Texture`) and `./config`. No DOM access, so it is fully unit-testable in the node environment.
- `frontend/app/lib/scene3d/imageShader.ts` — the GLSL the image material injects: the colour-adjustment chunk and the projection chunk, plus the uniform bucket factory. Exports `imageUniforms`, `IMAGE_FRAGMENT_PARS`, `IMAGE_PROJECT_VERTEX_GLSL`, `imageMapFragment`, `imageEmissiveMapFragment`, `writeImageUniforms`. Pure strings and plain objects — no `three` import needed beyond types, no DOM.
- `frontend/server/api/scene3d/gen-texture.post.ts` — text → a seamless surface image via fal. Sibling of the existing `gen-image.post.ts`.
- `frontend/tests/unit/scene3d-image-map.unit.spec.ts`
- `frontend/tests/unit/scene3d-image-shader.unit.spec.ts`

**Modified files**

- `frontend/app/lib/scene3d/config.ts` — the new `SceneMaterial` fields, their entries in `MATERIAL_DEFAULTS`, the new ranges, and the `parseMaterial` copy-when-present lines.
- `frontend/app/lib/scene3d/materials.ts` — per-material texture ownership, `case 'image':` build, the `case 'image':` in-place update branch, `identityKey`, `disposeMaterial`.
- `frontend/app/lib/scene3d/controls.ts` — one `SceneControl` per new option, plus a widened `when` on two existing controls.
- `frontend/app/lib/scene3d/panelPresentation.ts` — `MATERIAL_BODY.image`, two new sub-cards, `SCENE_PANEL_ORDER`, `scenePanelChrome`.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — the Texture block gains a "Generate a texture" affordance (Task 14 only).
- `frontend/server/utils/scene3dGen.ts` — a second prompt shaper for seamless textures.
- Existing specs: `scene3d-config.unit.spec.ts`, `scene3d-materials.unit.spec.ts`, `scene3d-controls.unit.spec.ts`, `scene3d-panel-parity.unit.spec.ts`.

**Slice boundaries** — the plan is one subsystem, but there are three natural stopping points if you want to ship progressively: after Task 5 (placement is complete and useful on its own), after Task 10 (look is complete), and after Task 13 (projection, seamless tiling and generation).

---

### Task 1: The data model

Every field the rest of the plan reads, declared once, defaulted once, and made to survive a document save/load round-trip. Nothing renders differently after this task — it is the foundation the other thirteen build on, and it is testable on its own through the document parser.

**Files:**
- Modify: `frontend/app/lib/scene3d/config.ts` (add fields to `SceneMaterial`; add entries to `MATERIAL_DEFAULTS` at line ~530; add ranges next to `TEXTURE_TILING_RANGE` at line ~606; add parse lines in `parseMaterial` next to the existing `image` / `textureTiling` lines at ~1103)
- Test: `frontend/tests/unit/scene3d-config.unit.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the optional `SceneMaterial` fields `imageWrap`, `imageTiling`, `imageTilingY`, `imageTilingLinked`, `imageOffsetX`, `imageOffsetY`, `imageRotation`, `imageFlipX`, `imageFlipY`, `imageFit`, `imageTint`, `imageAlpha`, `imageCutout`, `imageGlow`, `imageBrightness`, `imageContrast`, `imageSaturation`, `imageProjection`, `imageProjectionAxis`, `imageBoxBlend`, `imageSeamless`; the exported types `ImageWrap`, `ImageFit`, `ImageProjection`, `ImageAxis`; the exported constant arrays `IMAGE_WRAPS`, `IMAGE_FITS`, `IMAGE_PROJECTIONS`, `IMAGE_AXES`; the exported range `IMAGE_TILING_RANGE`; and the matching `MATERIAL_DEFAULTS` keys (same names, no `image` prefix change).

- [x] **Step 1: Write the failing test**

Append to `frontend/tests/unit/scene3d-config.unit.spec.ts`:

```ts
import {
  IMAGE_WRAPS, IMAGE_FITS, IMAGE_PROJECTIONS, IMAGE_AXES, IMAGE_TILING_RANGE,
} from '~/lib/scene3d/config'

describe('image material options', () => {
  it('defaults describe a plain, untransformed picture', () => {
    expect(MATERIAL_DEFAULTS.imageWrap).toBe('clamp')
    expect(MATERIAL_DEFAULTS.imageTiling).toBe(1)
    expect(MATERIAL_DEFAULTS.imageTilingLinked).toBe(true)
    expect(MATERIAL_DEFAULTS.imageOffsetX).toBe(0)
    expect(MATERIAL_DEFAULTS.imageOffsetY).toBe(0)
    expect(MATERIAL_DEFAULTS.imageRotation).toBe(0)
    expect(MATERIAL_DEFAULTS.imageFlipX).toBe(false)
    expect(MATERIAL_DEFAULTS.imageFlipY).toBe(false)
    expect(MATERIAL_DEFAULTS.imageFit).toBe('stretch')
    expect(MATERIAL_DEFAULTS.imageTint).toBe('#ffffff')
    expect(MATERIAL_DEFAULTS.imageAlpha).toBe(false)
    expect(MATERIAL_DEFAULTS.imageCutout).toBe(0)
    expect(MATERIAL_DEFAULTS.imageGlow).toBe(0)
    expect(MATERIAL_DEFAULTS.imageBrightness).toBe(0)
    expect(MATERIAL_DEFAULTS.imageContrast).toBe(1)
    expect(MATERIAL_DEFAULTS.imageSaturation).toBe(1)
    expect(MATERIAL_DEFAULTS.imageProjection).toBe('uv')
    expect(MATERIAL_DEFAULTS.imageProjectionAxis).toBe('y')
    expect(MATERIAL_DEFAULTS.imageBoxBlend).toBe(0.25)
    expect(MATERIAL_DEFAULTS.imageSeamless).toBe(0)
  })

  it('every option list contains its own default', () => {
    expect(IMAGE_WRAPS).toContain(MATERIAL_DEFAULTS.imageWrap)
    expect(IMAGE_FITS).toContain(MATERIAL_DEFAULTS.imageFit)
    expect(IMAGE_PROJECTIONS).toContain(MATERIAL_DEFAULTS.imageProjection)
    expect(IMAGE_AXES).toContain(MATERIAL_DEFAULTS.imageProjectionAxis)
    expect(IMAGE_TILING_RANGE.min).toBeGreaterThan(0)
    expect(IMAGE_TILING_RANGE.max).toBeGreaterThan(IMAGE_TILING_RANGE.min)
  })

  it('round-trips every image option through the document parser', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    Object.assign(obj.material, {
      type: 'image', image: 'a.png',
      imageWrap: 'mirror', imageTiling: 3, imageTilingY: 5, imageTilingLinked: false,
      imageOffsetX: 0.25, imageOffsetY: -0.25, imageRotation: 45,
      imageFlipX: true, imageFlipY: true, imageFit: 'cover',
      imageTint: '#ff8800', imageAlpha: true, imageCutout: 0.4, imageGlow: 2,
      imageBrightness: 0.2, imageContrast: 1.4, imageSaturation: 0.5,
      imageProjection: 'cylindrical', imageProjectionAxis: 'z', imageBoxBlend: 0.5,
      imageSeamless: 0.2,
    })
    doc.objects.push(obj)
    const back = parseDoc(JSON.parse(JSON.stringify(doc)))
    expect(back.objects[0]!.material).toMatchObject({
      imageWrap: 'mirror', imageTiling: 3, imageTilingY: 5, imageTilingLinked: false,
      imageOffsetX: 0.25, imageOffsetY: -0.25, imageRotation: 45,
      imageFlipX: true, imageFlipY: true, imageFit: 'cover',
      imageTint: '#ff8800', imageAlpha: true, imageCutout: 0.4, imageGlow: 2,
      imageBrightness: 0.2, imageContrast: 1.4, imageSaturation: 0.5,
      imageProjection: 'cylindrical', imageProjectionAxis: 'z', imageBoxBlend: 0.5,
      imageSeamless: 0.2,
    })
  })

  it('drops junk option values rather than storing them', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    Object.assign(obj.material, { type: 'image', imageWrap: 'nope', imageFit: 7, imageProjection: null })
    doc.objects.push(obj)
    const back = parseDoc(JSON.parse(JSON.stringify(doc)))
    expect(back.objects[0]!.material.imageWrap).toBeUndefined()
    expect(back.objects[0]!.material.imageFit).toBeUndefined()
    expect(back.objects[0]!.material.imageProjection).toBeUndefined()
  })
})
```

If `parseDoc` and `createPrimitive` are not already imported at the top of that spec, add them to the existing `from '~/lib/scene3d/config'` import. Check the file's existing imports first — most of them are already there.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts`
Expected: FAIL — `IMAGE_WRAPS` is not exported, and `MATERIAL_DEFAULTS.imageWrap` is `undefined`.

- [x] **Step 3: Add the option lists and the range**

In `frontend/app/lib/scene3d/config.ts`, immediately after the existing `export const TEXTURE_TILING_RANGE = ...` line:

```ts
// ── Image material: how the picture lands on the surface ─────────────────────
// Every one of these is OPTIONAL on SceneMaterial and absent by default, so a
// document saved before this feature loads and renders exactly as it did.
export type ImageWrap = 'clamp' | 'tile' | 'mirror'
export const IMAGE_WRAPS: ImageWrap[] = ['clamp', 'tile', 'mirror']

export type ImageFit = 'stretch' | 'cover' | 'contain'
export const IMAGE_FITS: ImageFit[] = ['stretch', 'cover', 'contain']

/** How the picture is mapped onto the surface. 'uv' samples the mesh's own UV
 *  attribute (what the material has always done); the other four IGNORE it and
 *  derive coordinates from object-space position — the point of the feature, since
 *  ExtrudeGeometry (text, SVG import) and ConvexGeometry either stretch their UVs
 *  or have none at all. 'box' is a three-sample triplanar blend and is therefore
 *  its own shader program (see identityKey in materials.ts); the other four share
 *  one program and switch on a uniform. */
export type ImageProjection = 'uv' | 'planar' | 'cylindrical' | 'spherical' | 'box'
export const IMAGE_PROJECTIONS: ImageProjection[] = ['uv', 'planar', 'cylindrical', 'spherical', 'box']

export type ImageAxis = 'x' | 'y' | 'z'
export const IMAGE_AXES: ImageAxis[] = ['x', 'y', 'z']

/** Same shape and the same bounds as TEXTURE_TILING_RANGE — deliberately a separate
 *  constant, because the ambientCG set's tiling and the uploaded picture's tiling are
 *  independent features that may drift apart. */
export const IMAGE_TILING_RANGE = { min: 0.25, max: 12, step: 0.25 } as const
```

- [x] **Step 4: Add the fields to `SceneMaterial`**

In `frontend/app/lib/scene3d/config.ts`, directly below the existing `image?: string` field on `SceneMaterial`:

```ts
  // ── `image` material only: placement, look, and projection ──────────────────
  // Read by materials.ts's `case 'image':` and by lib/scene3d/imageMap.ts. Every
  // field is absent by default and every reader falls back to MATERIAL_DEFAULTS, so
  // a document written before this block renders identically.
  /** Sampler behaviour outside 0..1. 'clamp' smears the edge pixel (the historical
   *  behaviour, and the only sane one at tiling 1); 'tile' repeats; 'mirror' repeats
   *  every other copy flipped, which is what hides the seam on a photograph. */
  imageWrap?: ImageWrap
  /** How many times the picture repeats across the surface. Drives BOTH axes while
   *  `imageTilingLinked` is not false. */
  imageTiling?: number
  /** Vertical repeats. Read ONLY when `imageTilingLinked === false`. */
  imageTilingY?: number
  /** Absent or true = one tiling number drives both axes. */
  imageTilingLinked?: boolean
  /** Slides the crop, in picture widths/heights. -1..1. */
  imageOffsetX?: number
  imageOffsetY?: number
  /** Degrees, -180..180, about the middle of the picture. */
  imageRotation?: number
  imageFlipX?: boolean
  imageFlipY?: boolean
  /** How the picture's own aspect ratio is reconciled with the surface. 'stretch'
   *  is the historical behaviour (squash to fit); 'cover' fills and crops; 'contain'
   *  fits the whole picture in and leaves the rest to the wrap mode. Needs the file's
   *  natural pixel size, so it only settles once the image has decoded. */
  imageFit?: ImageFit
  /** Multiplies the picture's colour. '#ffffff' (the default) leaves it untouched.
   *  A SEPARATE field from `color`: the material has always ignored `color` for this
   *  type, and reading it now would suddenly tint every existing image material with
   *  whatever colour its document happened to carry. */
  imageTint?: string
  /** Honour the file's own alpha channel. Off by default because turning transparency
   *  on moves the material into the sorted render list. */
  imageAlpha?: boolean
  /** alphaTest — fragments below this alpha leave the shader entirely, giving a hard
   *  cutout with no sorting cost. 0 = off. Only meaningful with `imageAlpha`. */
  imageCutout?: number
  /** Binds the picture as an emissive map at this intensity, so it glows on its own.
   *  0 = off. Ignored while `unlit` is on (a MeshBasicMaterial has no emissive slot). */
  imageGlow?: number
  /** Colour adjustments applied in the fragment shader after the map is sampled.
   *  Brightness -1..1 (0 = off), contrast 0..2 (1 = off), saturation 0..2 (1 = off). */
  imageBrightness?: number
  imageContrast?: number
  imageSaturation?: number
  /** See ImageProjection. */
  imageProjection?: ImageProjection
  /** Which axis 'planar' faces down and 'cylindrical' spins around. */
  imageProjectionAxis?: ImageAxis
  /** How softly the three box-projection samples cross-fade at an edge. 0..1. */
  imageBoxBlend?: number
  /** Cross-fade width, in picture widths, used to make a photograph tile without a
   *  visible seam. 0 = off (no pre-pass, the file's own pixels are bound). */
  imageSeamless?: number
```

Note the `unlit` field already exists on `SceneMaterial` (declared for `shaderFill`) — this plan REUSES it for the image material's Flat toggle rather than adding a second boolean. Do not add a new field for it.

- [x] **Step 5: Add the defaults**

In `MATERIAL_DEFAULTS`, immediately after the existing `textureTiling: 1,` line:

```ts
  imageWrap: 'clamp' as ImageWrap,
  imageTiling: 1,
  imageTilingLinked: true,
  imageOffsetX: 0,
  imageOffsetY: 0,
  imageRotation: 0,
  imageFlipX: false,
  imageFlipY: false,
  imageFit: 'stretch' as ImageFit,
  imageTint: '#ffffff',
  imageAlpha: false,
  imageCutout: 0,
  imageGlow: 0,
  imageBrightness: 0,
  imageContrast: 1,
  imageSaturation: 1,
  imageProjection: 'uv' as ImageProjection,
  imageProjectionAxis: 'y' as ImageAxis,
  imageBoxBlend: 0.25,
  imageSeamless: 0,
```

- [x] **Step 6: Add the parse lines**

In `parseMaterial`, directly below the existing `if (typeof m?.image === 'string') out.image = m.image` line:

```ts
    // Image options: the same copy-only-when-present rule every optional field above
    // follows, so an absent field stays absent and the reader's MATERIAL_DEFAULTS
    // fallback applies. An option-valued field is dropped entirely unless the stored
    // value is one this build knows — a junk or future value must never reach the
    // material factory's switch statements.
    if (typeof m?.imageWrap === 'string' && IMAGE_WRAPS.includes(m.imageWrap)) out.imageWrap = m.imageWrap
    if (typeof m?.imageFit === 'string' && IMAGE_FITS.includes(m.imageFit)) out.imageFit = m.imageFit
    if (typeof m?.imageProjection === 'string' && IMAGE_PROJECTIONS.includes(m.imageProjection)) out.imageProjection = m.imageProjection
    if (typeof m?.imageProjectionAxis === 'string' && IMAGE_AXES.includes(m.imageProjectionAxis)) out.imageProjectionAxis = m.imageProjectionAxis
    if (typeof m?.imageTiling === 'number') out.imageTiling = num(m.imageTiling, MATERIAL_DEFAULTS.imageTiling)
    if (typeof m?.imageTilingY === 'number') out.imageTilingY = num(m.imageTilingY, MATERIAL_DEFAULTS.imageTiling)
    if (typeof m?.imageTilingLinked === 'boolean') out.imageTilingLinked = m.imageTilingLinked
    if (typeof m?.imageOffsetX === 'number') out.imageOffsetX = num(m.imageOffsetX, MATERIAL_DEFAULTS.imageOffsetX)
    if (typeof m?.imageOffsetY === 'number') out.imageOffsetY = num(m.imageOffsetY, MATERIAL_DEFAULTS.imageOffsetY)
    if (typeof m?.imageRotation === 'number') out.imageRotation = num(m.imageRotation, MATERIAL_DEFAULTS.imageRotation)
    if (typeof m?.imageFlipX === 'boolean') out.imageFlipX = m.imageFlipX
    if (typeof m?.imageFlipY === 'boolean') out.imageFlipY = m.imageFlipY
    if (typeof m?.imageTint === 'string') out.imageTint = m.imageTint
    if (typeof m?.imageAlpha === 'boolean') out.imageAlpha = m.imageAlpha
    if (typeof m?.imageCutout === 'number') out.imageCutout = num(m.imageCutout, MATERIAL_DEFAULTS.imageCutout)
    if (typeof m?.imageGlow === 'number') out.imageGlow = num(m.imageGlow, MATERIAL_DEFAULTS.imageGlow)
    if (typeof m?.imageBrightness === 'number') out.imageBrightness = num(m.imageBrightness, MATERIAL_DEFAULTS.imageBrightness)
    if (typeof m?.imageContrast === 'number') out.imageContrast = num(m.imageContrast, MATERIAL_DEFAULTS.imageContrast)
    if (typeof m?.imageSaturation === 'number') out.imageSaturation = num(m.imageSaturation, MATERIAL_DEFAULTS.imageSaturation)
    if (typeof m?.imageBoxBlend === 'number') out.imageBoxBlend = num(m.imageBoxBlend, MATERIAL_DEFAULTS.imageBoxBlend)
    if (typeof m?.imageSeamless === 'number') out.imageSeamless = num(m.imageSeamless, MATERIAL_DEFAULTS.imageSeamless)
```

- [x] **Step 7: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts`
Expected: PASS.

- [x] **Step 8: Typecheck**

Run: `cd frontend && npx nuxt typecheck`
Expected: no new errors. Compare against the baseline you captured before starting — this repo has pre-existing errors unrelated to this work, so what matters is that the count does not grow.

- [x] **Step 9: Commit**

```bash
git add frontend/app/lib/scene3d/config.ts frontend/tests/unit/scene3d-config.unit.spec.ts
git commit -m "feat(scene3d): image material option fields, defaults and parsing"
```

---

### Task 2: The texture-transform layer

A pure module that turns a `SceneMaterial` into the four numbers three needs on a `Texture`. Written and tested before anything is wired, because the arithmetic (particularly cover/contain and flip) is where the bugs live and it is far easier to pin down in isolation than through a renderer.

**Files:**
- Create: `frontend/app/lib/scene3d/imageMap.ts`
- Test: `frontend/tests/unit/scene3d-image-map.unit.spec.ts`

**Interfaces:**
- Consumes: `SceneMaterial`, `MATERIAL_DEFAULTS` from Task 1.
- Produces:
  - `imageTilingXY(mat: SceneMaterial): [number, number]`
  - `imageFitTransform(mat: SceneMaterial, natural?: NaturalSize | null): { rx: number; ry: number; ox: number; oy: number }`
  - `applyImageTransform(tex: THREE.Texture, mat: SceneMaterial, natural?: NaturalSize | null): void`
  - `interface NaturalSize { w: number; h: number }`

- [x] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-image-map.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { imageTilingXY, imageFitTransform, applyImageTransform } from '~/lib/scene3d/imageMap'
import type { SceneMaterial } from '~/lib/scene3d/config'

const img = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'image', color: '#ffffff', roughness: 0.6, metalness: 0, image: 'a.png', ...patch })

describe('imageTilingXY', () => {
  it('drives both axes from one number while linked', () => {
    expect(imageTilingXY(img({ imageTiling: 3 }))).toEqual([3, 3])
    expect(imageTilingXY(img({ imageTiling: 3, imageTilingY: 9 }))).toEqual([3, 3])
  })

  it('reads the second number only once the link is off', () => {
    expect(imageTilingXY(img({ imageTiling: 3, imageTilingY: 9, imageTilingLinked: false }))).toEqual([3, 9])
  })

  it('falls back to one repeat with nothing set', () => {
    expect(imageTilingXY(img())).toEqual([1, 1])
  })
})

describe('imageFitTransform', () => {
  it('stretches by default — an identity transform', () => {
    expect(imageFitTransform(img(), { w: 1600, h: 900 })).toEqual({ rx: 1, ry: 1, ox: 0, oy: 0 })
  })

  it('is an identity transform until the natural size is known', () => {
    expect(imageFitTransform(img({ imageFit: 'cover' }), null)).toEqual({ rx: 1, ry: 1, ox: 0, oy: 0 })
  })

  it('covers a wide picture by cropping its sides', () => {
    // 2:1 picture: show the full height, and a centred half of the width.
    const t = imageFitTransform(img({ imageFit: 'cover' }), { w: 200, h: 100 })
    expect(t.rx).toBeCloseTo(0.5)
    expect(t.ry).toBeCloseTo(1)
    expect(t.ox).toBeCloseTo(0.25)
    expect(t.oy).toBeCloseTo(0)
  })

  it('contains a wide picture by letterboxing it', () => {
    // 2:1 picture: full width, occupying the middle half of the height.
    const t = imageFitTransform(img({ imageFit: 'contain' }), { w: 200, h: 100 })
    expect(t.rx).toBeCloseTo(1)
    expect(t.ry).toBeCloseTo(2)
    expect(t.ox).toBeCloseTo(0)
    expect(t.oy).toBeCloseTo(-0.5)
  })

  it('mirrors the maths for a tall picture', () => {
    const cover = imageFitTransform(img({ imageFit: 'cover' }), { w: 100, h: 200 })
    expect(cover.rx).toBeCloseTo(1)
    expect(cover.ry).toBeCloseTo(0.5)
    expect(cover.oy).toBeCloseTo(0.25)
    const contain = imageFitTransform(img({ imageFit: 'contain' }), { w: 100, h: 200 })
    expect(contain.rx).toBeCloseTo(2)
    expect(contain.ox).toBeCloseTo(-0.5)
  })
})

describe('applyImageTransform', () => {
  it('clamps by default and never re-uploads the pixels', () => {
    const tex = new THREE.Texture()
    const before = tex.version
    applyImageTransform(tex, img())
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping)
    expect(tex.repeat.x).toBe(1)
    expect(tex.offset.x).toBe(0)
    // First application stamps the wrap mode, which is a sampler parameter — one bump.
    expect(tex.version).toBe(before + 1)
    // Re-applying the SAME wrap must not bump it again: needsUpdate re-uploads the image.
    const after = tex.version
    applyImageTransform(tex, img({ imageTiling: 4 }))
    expect(tex.repeat.x).toBe(4)
    expect(tex.version).toBe(after)
  })

  it('maps each wrap mode onto its three constant', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageWrap: 'tile' }))
    expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    applyImageTransform(tex, img({ imageWrap: 'mirror' }))
    expect(tex.wrapS).toBe(THREE.MirroredRepeatWrapping)
  })

  it('composes fit, tiling and offset', () => {
    const tex = new THREE.Texture()
    applyImageTransform(
      tex,
      img({ imageFit: 'cover', imageTiling: 2, imageOffsetX: 0.1 }),
      { w: 200, h: 100 },
    )
    expect(tex.repeat.x).toBeCloseTo(1)   // fit 0.5 * tiling 2
    expect(tex.repeat.y).toBeCloseTo(2)   // fit 1   * tiling 2
    expect(tex.offset.x).toBeCloseTo(0.35) // fit 0.25 + user 0.1
  })

  it('flips by walking the same band backwards', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageTiling: 2, imageOffsetX: 0.1, imageFlipX: true }))
    expect(tex.repeat.x).toBeCloseTo(-2)
    expect(tex.offset.x).toBeCloseTo(2.1)
  })

  it('rotates about the middle of the picture', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageRotation: 90 }))
    expect(tex.rotation).toBeCloseTo(Math.PI / 2)
    expect(tex.center.x).toBe(0.5)
    expect(tex.center.y).toBe(0.5)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-image-map.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/scene3d/imageMap`.

- [x] **Step 3: Write the module**

Create `frontend/app/lib/scene3d/imageMap.ts`:

```ts
import * as THREE from 'three'
import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

/**
 * The `image` material's texture transform: wrap mode, tiling, fit, offset, rotation
 * and flip, all expressed as properties of the bound THREE.Texture rather than as
 * shader work. Everything here is arithmetic over the document — no DOM, no GPU — so
 * it is unit-testable in the node environment the studio's specs run in.
 *
 * OWNERSHIP: `repeat`/`offset`/`rotation` live on the Texture, not on the Material, so
 * the material this is applied to MUST own its Texture exclusively. The image material
 * used to hand out a shared, per-filename cached Texture; Task 3 of the image-options
 * plan changed that, and this module cannot be used with a shared one.
 */

export interface NaturalSize { w: number; h: number }

const WRAP: Record<string, THREE.Wrapping> = {
  clamp: THREE.ClampToEdgeWrapping,
  tile: THREE.RepeatWrapping,
  mirror: THREE.MirroredRepeatWrapping,
}

/** Horizontal and vertical repeats. The link switch means "one number drives both",
 *  so the second field is not merely defaulted when linked — it is ignored, and the
 *  value the user last typed into it survives being unlinked and relinked. */
export function imageTilingXY(mat: SceneMaterial): [number, number] {
  const x = mat.imageTiling ?? MATERIAL_DEFAULTS.imageTiling
  if (mat.imageTilingLinked === false) return [x, mat.imageTilingY ?? MATERIAL_DEFAULTS.imageTiling]
  return [x, x]
}

/**
 * Reconcile the picture's own aspect ratio with the surface it is being sampled over.
 *
 * The UV square is treated as 1:1 — which is what it is for every primitive the studio
 * builds, and the only assumption available for an imported mesh whose UVs are opaque.
 * A texture coordinate is `uv * repeat + offset`, so a picture is made to occupy a
 * NARROWER band of the UV range by giving it a LARGER repeat on that axis, and the
 * offset then re-centres the band.
 *
 * Returns an identity transform for 'stretch' and for a picture whose pixel size is
 * not known yet — a texture that has not finished decoding has no `image.width`, and
 * the material re-applies this from the loader's onLoad once it does.
 */
export function imageFitTransform(
  mat: SceneMaterial, natural?: NaturalSize | null,
): { rx: number; ry: number; ox: number; oy: number } {
  const identity = { rx: 1, ry: 1, ox: 0, oy: 0 }
  const fit = mat.imageFit ?? MATERIAL_DEFAULTS.imageFit
  if (fit === 'stretch') return identity
  if (!natural || !(natural.w > 0) || !(natural.h > 0)) return identity
  const a = natural.w / natural.h
  if (a === 1) return identity
  if (fit === 'cover') {
    // Fill the square and crop the long axis: the long axis shows a centred 1/a slice.
    return a > 1
      ? { rx: 1 / a, ry: 1, ox: (1 - 1 / a) / 2, oy: 0 }
      : { rx: 1, ry: a, ox: 0, oy: (1 - a) / 2 }
  }
  // contain: the whole picture fits, and the short axis is letterboxed. Whatever the
  // wrap mode does outside 0..1 is what fills the letterbox — 'clamp' smears the edge
  // pixel, 'tile'/'mirror' repeat the picture into it.
  return a > 1
    ? { rx: 1, ry: a, ox: 0, oy: (1 - a) / 2 }
    : { rx: 1 / a, ry: 1, ox: (1 - 1 / a) / 2, oy: 0 }
}

/**
 * Write the whole transform onto a texture the caller owns.
 *
 * NB `needsUpdate`: `repeat`/`offset`/`rotation`/`center` are picked up for free —
 * `Texture.matrixAutoUpdate` is true by default, so three rebuilds the UV matrix each
 * frame. `wrapS`/`wrapT` are different: they are sampler parameters applied when the
 * texture is uploaded, so a change to them DOES need `needsUpdate` — and `needsUpdate`
 * re-uploads the pixels, which is far too expensive to do on every slider tick. Hence
 * the stamp: bump only when the wrap mode actually moved.
 */
export function applyImageTransform(
  tex: THREE.Texture, mat: SceneMaterial, natural?: NaturalSize | null,
): void {
  const key = mat.imageWrap ?? MATERIAL_DEFAULTS.imageWrap
  const wrap = WRAP[key] ?? THREE.ClampToEdgeWrapping
  if (tex.userData.imageWrapApplied !== key) {
    tex.userData.imageWrapApplied = key
    tex.wrapS = tex.wrapT = wrap
    tex.needsUpdate = true
  }

  const [tx, ty] = imageTilingXY(mat)
  const fit = imageFitTransform(mat, natural)
  let rx = fit.rx * tx
  let ry = fit.ry * ty
  let ox = fit.ox + (mat.imageOffsetX ?? MATERIAL_DEFAULTS.imageOffsetX)
  let oy = fit.oy + (mat.imageOffsetY ?? MATERIAL_DEFAULTS.imageOffsetY)

  // A flip walks the SAME band of the picture in the opposite direction: negate the
  // repeat and advance the offset to the far end of the band, so the visible crop is
  // unchanged and only its direction reverses.
  if (mat.imageFlipX === true) { ox += rx; rx = -rx }
  if (mat.imageFlipY === true) { oy += ry; ry = -ry }

  tex.repeat.set(rx, ry)
  tex.offset.set(ox, oy)
  tex.center.set(0.5, 0.5)
  tex.rotation = (mat.imageRotation ?? MATERIAL_DEFAULTS.imageRotation) * Math.PI / 180
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-image-map.unit.spec.ts`
Expected: PASS, all fourteen assertions.

- [x] **Step 5: Commit**

```bash
git add frontend/app/lib/scene3d/imageMap.ts frontend/tests/unit/scene3d-image-map.unit.spec.ts
git commit -m "feat(scene3d): image map transform module (wrap, tiling, fit, offset, rotation, flip)"
```

---

### Task 3: Own the texture, and ship edges + tiling

The first visible change. It also fixes a live bug: the image material's `.map` comes from the module-level `imageCache`, shared by filename across every material — so `disposeMaterial`'s `map.dispose()` frees a texture other objects may still be drawing with. Two objects showing the same file, delete one, and the other goes blank. Per-material ownership is required anyway (`repeat` lives on the Texture, not the Material), so the fix and the feature are one change.

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (the `imageMaterials` set at ~line 110; `getImageTexture`'s error handler at ~line 160; `case 'image':` at ~line 1088; the `case 'image':` update branch at ~line 1361; `disposeMaterial` at ~line 1386 and ~1414)
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts`
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`, `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: `applyImageTransform`, `NaturalSize` from Task 2; the fields and defaults from Task 1.
- Produces: `m.userData.imageSpec` (the live `SceneMaterial`, re-stamped by `updateMaterial`, read by the loader's async `onLoad`); `m.userData.imageNatural` (`NaturalSize | undefined`, filled once the file decodes); the `when` predicate `isImageMaterial` in `controls.ts`; the control keys `object.material.imageWrap`, `object.material.imageTiling`, `object.material.imageTilingLinked`, `object.material.imageTilingY`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image material texture ownership', () => {
  it('stamps the live spec so the async loader can re-apply the transform', () => {
    const mat = base({ type: 'image', image: 'a.png', imageTiling: 3 })
    const m = materialFor(mat)
    expect(m.userData.imageSpec).toBe(mat)
    const next = base({ type: 'image', image: 'a.png', imageTiling: 5 })
    expect(updateMaterial(m, next)).toBe(true)
    expect(m.userData.imageSpec).toBe(next)
  })

  it('applies the transform to a map it owns, without rebuilding', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    // Node has no DOM, so the loader never binds a map — stand one in, exactly as the
    // normal-map sharing test below does, and prove updateMaterial retiles it in place.
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageTiling: 4, imageWrap: 'tile' }))).toBe(true)
    expect(m.map.repeat.x).toBe(4)
    expect(m.map.wrapS).toBe(THREE.RepeatWrapping)
  })

  it('disposing one image material leaves another on the same file untouched', () => {
    const a = materialFor(base({ type: 'image', image: 'shared.png' })) as THREE.MeshStandardMaterial
    const b = materialFor(base({ type: 'image', image: 'shared.png' })) as THREE.MeshStandardMaterial
    a.map = new THREE.Texture()
    b.map = new THREE.Texture()
    expect(a.map).not.toBe(b.map)
    const disposed = vi.fn()
    b.map.addEventListener('dispose', disposed)
    disposeMaterial(a)
    expect(disposed).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL — `m.userData.imageSpec` is `undefined`.

- [x] **Step 3: Give the image material its own texture**

In `frontend/app/lib/scene3d/materials.ts`, add the import at the top with the other `./` imports:

```ts
import { applyImageTransform, type NaturalSize } from './imageMap'
```

Delete the `imageMaterials` set and its doc comment (~line 109-110):

```ts
/** Materials currently holding an image texture — used to drop `map` on load failure. */
const imageMaterials = new Set<THREE.MeshStandardMaterial>()
```

…and simplify `getImageTexture`'s error handler, which was walking that set. It now serves only `normalImage` and relief lookups, which have no `.map` to drop:

```ts
      () => {
        // Only the SHARED cache's users reach here now — a user-supplied normal map, or a
        // relief source. The image material has owned its own Texture (and its own error
        // handler) since the image-options work, so there is no `.map` to drop from here.
        imageCache.delete(key)
        errorSubs.forEach((cb) => cb(filename))
      },
```

Add the owned-texture loader immediately above `materialFor`:

```ts
/**
 * A Texture the image material owns OUTRIGHT, rather than the shared per-filename
 * `imageCache`.
 *
 * Required by the feature: `repeat`, `offset`, `rotation` and `wrapS/wrapT` live on the
 * TEXTURE, so two objects showing the same file at different tilings need two Textures.
 * And it fixes a bug the shared cache had all along — `disposeMaterial` calls
 * `map.dispose()`, which freed a texture every other material on that filename was still
 * drawing with, blanking them.
 *
 * The cost is the same one `bindTextureMaps` already accepts one function below: the
 * browser's HTTP cache dedupes the BYTES, so only the decode is repeated per material.
 *
 * Cloning a cached Texture is NOT an alternative: `Texture.clone()` copies `.image` by
 * value at clone time, so a clone taken before the async load resolves stays empty forever.
 */
function ownedImageTexture(m: THREE.Material, filename: string): THREE.Texture | null {
  if (!hasDOM || !filename) return null
  const tex = new THREE.TextureLoader().load(
    inputViewUrl(filename),
    (loaded) => {
      // A material disposed while its file was still downloading must not be touched —
      // same hazard, and the same guard, as reliefHealPending and applyTextureSet.
      if (m.userData.disposed) return
      // The natural pixel size exists only now, so Fit's cover/contain were identity
      // transforms until this point and settle here. `imageSpec` is the LIVE material —
      // the user may have moved four sliders while the file was in flight.
      const src = loaded.image as { width?: number; height?: number } | undefined
      if (src?.width && src?.height) m.userData.imageNatural = { w: src.width, h: src.height }
      const spec = m.userData.imageSpec as SceneMaterial | undefined
      if (spec) applyImageTransform(loaded, spec, m.userData.imageNatural as NaturalSize | undefined)
    },
    undefined,
    () => {
      const s = m as THREE.MeshStandardMaterial
      if (s.map === tex) { s.map = null; s.needsUpdate = true }
      tex.dispose()
      errorSubs.forEach((cb) => cb(filename))
    },
  )
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
```

Replace the body of `case 'image':` in `materialFor`:

```ts
    case 'image': {
      const t = new THREE.MeshStandardMaterial({
        // White base so the picture shows untinted. The doc's `color` is deliberately NOT
        // read here — see SceneMaterial.imageTint, which is the tint control for this type.
        color: '#ffffff',
        roughness: mat.roughness,
        metalness: mat.metalness,
      })
      // The live spec, re-stamped by updateMaterial below and read by the loader's onLoad
      // (which fires long after this function returns). Same pattern shaderFill uses with
      // `userData.shaderSpec` for refreshSceneShaderFields.
      t.userData.imageSpec = mat
      const tex = ownedImageTexture(t, mat.image ?? '')
      if (tex) {
        t.map = tex
        // Natural size is unknown until the file decodes, so Fit is an identity transform
        // on this first pass; onLoad re-applies with the real dimensions.
        applyImageTransform(tex, mat, null)
      }
      t.userData.imageFilename = mat.image ?? ''
      m = t
      break
    }
```

Replace the `case 'image':` branch inside `updateMaterial`:

```ts
    case 'image': {
      const s = m as THREE.MeshStandardMaterial
      s.roughness = mat.roughness; s.metalness = mat.metalness
      // Re-stamp before touching the map: the async onLoad reads this, and a file still in
      // flight must settle onto the CURRENT dials, not the ones it was built with.
      m.userData.imageSpec = mat
      if (s.map) applyImageTransform(s.map, mat, m.userData.imageNatural as NaturalSize | undefined)
      return true
    }
```

In `disposeMaterial`, delete the line that removed the material from the set:

```ts
  if (m.userData.matType === 'image') imageMaterials.delete(m as THREE.MeshStandardMaterial)
```

…and drop the `imageCache` eviction from the `map.dispose()` line, which is now both dead and wrong (the image material no longer takes its `map` from that cache):

```ts
  if (map) map.dispose()
```

Delete the `I4 fix` comment block above that line, which described the eviction being removed, and leave `userData.imageFilename` in place — Task 14 reads it.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: PASS.

- [x] **Step 5: Declare the two controls**

In `frontend/app/lib/scene3d/controls.ts`, add the predicate next to the other per-type ones (after `isShaderFillMaterial`):

```ts
// The uploaded-picture branch. Everything under `object.material.image*` is this type
// only — a different material type keeps the stored values and ignores them, exactly as
// `texture`/`textureTiling` behave outside standard/glass/opalescent.
const isImageMaterial = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) === 'image'
```

Add `IMAGE_WRAPS`, `IMAGE_TILING_RANGE` to the existing `from './config'` import, then add the controls just below the `object.material.textureTiling` slider:

```ts
  // --- Image material: how the picture lands on the surface -------------------------
  select('object.material.imageWrap', 'Edges', [...IMAGE_WRAPS], MATERIAL_DEFAULTS.imageWrap, 'Material',
    'What happens outside the picture: hold the edge pixel, repeat it, or repeat it mirrored so the seam disappears',
    { when: isImageMaterial, optionLabels: ['Clamp', 'Tile', 'Mirror'] }),
  slider('object.material.imageTiling', 'Tiling', IMAGE_TILING_RANGE.min, IMAGE_TILING_RANGE.max, IMAGE_TILING_RANGE.step,
    'Material', MATERIAL_DEFAULTS.imageTiling,
    'How many times the picture repeats across the surface', { when: isImageMaterial }),
  {
    key: 'object.material.imageTilingLinked', label: 'Link tiling', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageTilingLinked, group: 'Material',
    hint: 'One tiling number drives both directions', when: isImageMaterial,
  } as SceneControl,
  slider('object.material.imageTilingY', 'Vertical tiling', IMAGE_TILING_RANGE.min, IMAGE_TILING_RANGE.max,
    IMAGE_TILING_RANGE.step, 'Material', MATERIAL_DEFAULTS.imageTiling,
    'How many times the picture repeats top to bottom', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageTilingLinked', equals: false },
    }),
```

- [x] **Step 6: Place the rows**

In `frontend/app/lib/scene3d/panelPresentation.ts`, replace the `image` entry of `MATERIAL_BODY`:

```ts
  image: [
    'ui.material.image',
    'object.material.imageWrap',
    'object.material.imageTiling', 'object.material.imageTilingLinked', 'object.material.imageTilingY',
    'object.material.roughness', 'object.material.metalness',
  ],
```

- [x] **Step 7: Update the panel characterization expectations**

`tests/unit/scene3d-panel-parity.unit.spec.ts` pins the exact row list per material type. Replace the `image` entry (around line 342):

```ts
  image: {
    Material: [
      `${M}type`, 'ui.material.image',
      `${M}imageWrap`,
      `${M}imageTiling`, `${M}imageTilingLinked`,
      // NB imageTilingY is showIf-hidden while imageTilingLinked is true (its default), so it
      // does NOT appear in the default rendered list — same as gradient palette rows.
      `${M}roughness`, `${M}metalness`,
    ],
  },
```

- [x] **Step 8: Run the full scene3d unit suite**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS. The controls spec asserts unique keys, that every group is in `SCENE_SECTIONS`, and that every select default is one of its own options — all three hold for the new entries.

- [x] **Step 9: Verify it live**

Start the frontend (`cd frontend && npm run dev`) and ComfyUI (`cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python main.py --listen 127.0.0.1 --port 8188`). Open a 3D Studio node, add a box, set its material type to Image, upload any picture. Confirm:
- Tiling at 1 with Edges on Clamp looks exactly as it did before this change.
- Raising Tiling to 4 with Edges on Clamp smears the edge pixel into fifteen streaks — this is correct, and is why Tile exists.
- Switching Edges to Tile shows a 4×4 grid; Mirror shows the same grid with alternate copies flipped and no visible seam.
- Turning Link tiling off reveals Vertical tiling, and the two axes move independently.
- Add a SECOND box using the same uploaded file, give it a different tiling, and confirm the first box does not change. Delete the second box and confirm the first still draws (this is the disposal bug the task fixes).

Take a screenshot of the two boxes at different tilings for the commit message trailer or the task report.

- [x] **Step 10: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/controls.ts \
  frontend/app/lib/scene3d/panelPresentation.ts \
  frontend/tests/unit/scene3d-materials.unit.spec.ts frontend/tests/unit/scene3d-panel-parity.unit.spec.ts
git commit -m "feat(scene3d): image material owns its texture, gains edges and tiling"
```

---

### Task 4: Offset, rotation and flip

Pure additions to the already-tested transform layer, plus five control declarations. No new machinery.

**Files:**
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`SCENE_PANEL_ORDER`, `SUB_CARDS`, `scenePanelChrome`)
- Test: `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: `applyImageTransform` (already handles offset/rotation/flip — Task 2 wrote and tested them); `isImageMaterial` from Task 3.
- Produces: the control keys `object.material.imageOffsetX`, `object.material.imageOffsetY`, `object.material.imageRotation`, `object.material.imageFlipX`, `object.material.imageFlipY`; the panel card `Material/Image placement`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`:

```ts
describe('image placement sub-card', () => {
  it('collects the placement rows in its own collapsed card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box')
    o.material.type = 'image'
    const card = rendered(doc, o, SCENE_PANEL_SECTIONS).find((c) => c.title === 'Image placement')
    expect(card?.keys).toEqual([
      `${M}imageOffsetX`, `${M}imageOffsetY`, `${M}imageRotation`,
      `${M}imageFlipX`, `${M}imageFlipY`,
    ])
    expect(scenePanelChrome('image')['Image placement']).toEqual({ open: false })
  })
})
```

Match the helper names the spec already uses — it has a `rendered(doc, obj, sections)` helper and an `M` constant for the `object.material.` prefix. If `rendered`'s third argument is named differently in the file, use the file's own convention rather than this one.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-panel-parity.unit.spec.ts`
Expected: FAIL — no card titled "Image placement".

- [x] **Step 3: Declare the controls**

In `frontend/app/lib/scene3d/controls.ts`, below the `imageTilingY` slider from Task 3:

```ts
  slider('object.material.imageOffsetX', 'Horizontal offset', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageOffsetX,
    'Slides the picture across the surface, in picture widths', { when: isImageMaterial }),
  slider('object.material.imageOffsetY', 'Vertical offset', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageOffsetY,
    'Slides the picture up and down the surface, in picture heights', { when: isImageMaterial }),
  slider('object.material.imageRotation', 'Rotation', -180, 180, 1, 'Material', MATERIAL_DEFAULTS.imageRotation,
    'Turns the picture about its own middle', { when: isImageMaterial }),
  {
    key: 'object.material.imageFlipX', label: 'Flip horizontally', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageFlipX, group: 'Material',
    hint: 'Mirrors the picture left to right', when: isImageMaterial,
  } as SceneControl,
  {
    key: 'object.material.imageFlipY', label: 'Flip vertically', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageFlipY, group: 'Material',
    hint: 'Mirrors the picture top to bottom', when: isImageMaterial,
  } as SceneControl,
```

- [x] **Step 4: Add the sub-card**

In `frontend/app/lib/scene3d/panelPresentation.ts`, add to `SCENE_PANEL_ORDER` directly after `'Material'`:

```ts
  'Material/Image placement',
```

Add to `SUB_CARDS`:

```ts
  'Material/Image placement': [
    'object.material.imageOffsetX', 'object.material.imageOffsetY', 'object.material.imageRotation',
    'object.material.imageFlipX', 'object.material.imageFlipY',
  ],
```

Add to the record `scenePanelChrome` returns, next to the other collapsed sub-blocks:

```ts
    'Image placement': { open: false },
```

`panelCardOf` routes a key to its sub-card before falling through to `group === 'Material'`, so no other change is needed — and because the five keys are in `SUB_CARDS`, they must NOT also be listed in `MATERIAL_BODY.image`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts \
  frontend/tests/unit/scene3d-panel-parity.unit.spec.ts
git commit -m "feat(scene3d): image offset, rotation and flip controls"
```

---

### Task 5: Fit — stretch, cover, contain

The last of the placement work, and the only piece that depends on data that arrives asynchronously: a picture's aspect ratio is unknown until the file decodes. Task 2 already wrote and tested the arithmetic, and Task 3 already wired the loader's `onLoad` to re-apply once `imageNatural` is filled — so this task is the control plus a test that the async settle actually happens.

**Files:**
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`MATERIAL_BODY.image`)
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`, `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: `imageFitTransform` (Task 2), `m.userData.imageNatural` (Task 3).
- Produces: the control key `object.material.imageFit`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image fit', () => {
  it('is an identity transform until the natural size lands, then crops', () => {
    const mat = base({ type: 'image', image: 'a.png', imageFit: 'cover' })
    const m = materialFor(mat) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    // No natural size yet — a wide picture must not be pre-cropped on a guess.
    expect(updateMaterial(m, mat)).toBe(true)
    expect(m.map.repeat.x).toBe(1)
    // The loader's onLoad fills this; simulate it and re-run the in-place update.
    m.userData.imageNatural = { w: 200, h: 100 }
    expect(updateMaterial(m, mat)).toBe(true)
    expect(m.map.repeat.x).toBeCloseTo(0.5)
    expect(m.map.offset.x).toBeCloseTo(0.25)
  })

  it('does not force a rebuild when only the fit changes', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageFit: 'contain' }))).toBe(true)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL on the second assertion of the first test — with no `imageFit` control wired the material builds, but `repeat.x` stays 1 after `imageNatural` is set, because Task 2's `imageFitTransform` is only reached through `applyImageTransform`, which Task 3 wired. If this test passes immediately, that is the correct outcome: Tasks 2 and 3 already carry the behaviour, and this task is control declaration only. Record which it was and continue.

- [x] **Step 3: Declare the control**

In `frontend/app/lib/scene3d/controls.ts`, add `IMAGE_FITS` to the `./config` import and place the control immediately BEFORE `object.material.imageWrap` (fit decides the crop; edges decide what happens outside it, so fit reads first):

```ts
  select('object.material.imageFit', 'Fit', [...IMAGE_FITS], MATERIAL_DEFAULTS.imageFit, 'Material',
    'How the picture shape is reconciled with the surface: squash it to fit, fill and crop, or fit the whole thing in',
    { when: isImageMaterial, optionLabels: ['Stretch', 'Cover', 'Contain'] }),
```

- [x] **Step 4: Place the row**

In `frontend/app/lib/scene3d/panelPresentation.ts`, update `MATERIAL_BODY.image`:

```ts
  image: [
    'ui.material.image',
    'object.material.imageFit', 'object.material.imageWrap',
    'object.material.imageTiling', 'object.material.imageTilingLinked', 'object.material.imageTilingY',
    'object.material.roughness', 'object.material.metalness',
  ],
```

…and the matching expectation in `tests/unit/scene3d-panel-parity.unit.spec.ts`:

```ts
  image: {
    Material: [
      `${M}type`, 'ui.material.image',
      `${M}imageFit`, `${M}imageWrap`,
      `${M}imageTiling`, `${M}imageTilingLinked`,
      // NB imageTilingY is showIf-hidden while imageTilingLinked is true (its default), so it
      // does NOT appear in the default rendered list — same as gradient palette rows.
      `${M}roughness`, `${M}metalness`,
    ],
  },
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts \
  frontend/tests/unit/scene3d-materials.unit.spec.ts frontend/tests/unit/scene3d-panel-parity.unit.spec.ts
git commit -m "feat(scene3d): image fit — stretch, cover, contain"
```

---

### Task 6: Tint

The image material hard-codes a white base and hides the colour row, so there is no way to wash a picture with a colour. `THREE.Material.color` multiplies the map, which is exactly a tint — it just needs its own field, because reading the document's existing `color` would suddenly tint every image material already out there with whatever colour its document happened to carry.

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (`case 'image':` in `materialFor` and in `updateMaterial`)
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`SUB_CARDS`, `SCENE_PANEL_ORDER`, `scenePanelChrome`)
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`, `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageTint` (Task 1), `isImageMaterial` (Task 3), `stripAlpha` (already in `materials.ts` — the studio's colour picker emits 8-digit hex, which `THREE.Color.set` cannot parse).
- Produces: the control key `object.material.imageTint`; the panel card `Material/Image look`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image tint', () => {
  it('defaults to white so an untinted picture is unchanged', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })

  it('multiplies the picture by the tint, in place', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageTint: '#ff8800' }))).toBe(true)
    expect(`#${m.color.getHexString()}`).toBe('#ff8800')
  })

  it('accepts the eight-digit hex the studio colour picker emits', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageTint: '#ff8800cc' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ff8800')
  })

  it('ignores the document colour, which this type has never read', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', color: '#00ff00' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL on the second test — the colour stays `#ffffff`.

- [x] **Step 3: Read the tint at build time**

In `materialFor`'s `case 'image':`, replace the colour argument:

```ts
      const t = new THREE.MeshStandardMaterial({
        // The picture's tint — white leaves it untouched. Deliberately NOT the document's
        // `color`: this type has never read it, and starting to would retint every image
        // material already saved with whatever colour its document carried.
        color: stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint),
        roughness: mat.roughness,
        metalness: mat.metalness,
      })
```

- [x] **Step 4: Update it in place**

In `updateMaterial`'s `case 'image':`, add the colour write above the roughness line:

```ts
    case 'image': {
      const s = m as THREE.MeshStandardMaterial
      s.color.set(stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint))
      s.roughness = mat.roughness; s.metalness = mat.metalness
      m.userData.imageSpec = mat
      if (s.map) applyImageTransform(s.map, mat, m.userData.imageNatural as NaturalSize | undefined)
      return true
    }
```

- [x] **Step 5: Declare the control and its card**

In `frontend/app/lib/scene3d/controls.ts`, after the flip switches:

```ts
  color('object.material.imageTint', 'Tint', MATERIAL_DEFAULTS.imageTint, 'Material', { when: isImageMaterial }),
```

In `frontend/app/lib/scene3d/panelPresentation.ts`, add to `SCENE_PANEL_ORDER` after `'Material/Image placement'`:

```ts
  'Material/Image look',
```

Add to `SUB_CARDS`:

```ts
  'Material/Image look': ['object.material.imageTint'],
```

Add to `scenePanelChrome`'s record:

```ts
    'Image look': { open: false },
```

- [x] **Step 6: Extend the panel characterization**

Add to `tests/unit/scene3d-panel-parity.unit.spec.ts`, next to the placement test from Task 4:

```ts
  it('collects the look rows in their own collapsed card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box')
    o.material.type = 'image'
    const card = rendered(doc, o, SCENE_PANEL_SECTIONS).find((c) => c.title === 'Image look')
    expect(card?.keys).toEqual([`${M}imageTint`])
  })
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/controls.ts \
  frontend/app/lib/scene3d/panelPresentation.ts \
  frontend/tests/unit/scene3d-materials.unit.spec.ts frontend/tests/unit/scene3d-panel-parity.unit.spec.ts
git commit -m "feat(scene3d): image tint"
```

---

### Task 7: Flat — an unlit image

A photograph, a logo, a UI screenshot on a plane very often wants to be shown as it is, not shaded by the scene's lights. `shaderFill` already has this toggle and the machinery for it; this task extends the same field (`unlit`) and the same class-boundary pattern to `image`.

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (`case 'image':` in `materialFor`, `baseIdentityKey`, `case 'image':` in `updateMaterial`)
- Modify: `frontend/app/lib/scene3d/controls.ts` (widen `isShaderFillMaterial`'s use on the `unlit` control, and widen `hasPbrSurface`)
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`MATERIAL_BODY.image`)
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`, `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: the existing `SceneMaterial.unlit` field and the existing `object.material.unlit` control.
- Produces: `baseIdentityKey` for `image` now reads `image:<file>:<unlit>`; a new `when` predicate `hasUnlitToggle` in `controls.ts`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('unlit image', () => {
  it('builds a Basic material so scene lights do not shade the picture', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true }))
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(m).not.toBeInstanceOf(THREE.MeshStandardMaterial)
  })

  it('still applies the tint and the map transform when unlit', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true, imageTint: '#ff0000' })) as THREE.MeshBasicMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ff0000')
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', unlit: true, imageTiling: 3 }))).toBe(true)
    expect(m.map.repeat.x).toBe(3)
  })

  it('rebuilds when the lit/unlit class boundary is crossed', () => {
    const lit = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(lit, base({ type: 'image', image: 'a.png', unlit: true }))).toBe(false)
  })

  it('skips roughness and metalness on the Basic variant, which has neither', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', unlit: true, roughness: 0.2 }))).toBe(true)
    expect((m as unknown as { roughness?: number }).roughness).toBeUndefined()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL — a `MeshStandardMaterial` is built regardless of `unlit`.

- [x] **Step 3: Build the right class**

Replace the body of `case 'image':` in `materialFor`:

```ts
    case 'image': {
      // `unlit` picks the CLASS, exactly as it does for shaderFill: Basic shows the
      // picture's own pixels flat (a photo, a logo, a screenshot), Standard lets the
      // scene's lights shade it. MeshBasicMaterial has no roughness/metalness slot, so
      // neither is written on that branch — and applyRelief/applyScreen already skip a
      // material with no bumpMap, so the relief section degrades on its own.
      const tint = stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint)
      const t: THREE.Material = mat.unlit === true
        ? new THREE.MeshBasicMaterial({ color: tint })
        : new THREE.MeshStandardMaterial({ color: tint, roughness: mat.roughness, metalness: mat.metalness })
      t.userData.imageSpec = mat
      const tex = ownedImageTexture(t, mat.image ?? '')
      if (tex) {
        ;(t as THREE.MeshStandardMaterial).map = tex
        applyImageTransform(tex, mat, null)
      }
      t.userData.imageFilename = mat.image ?? ''
      m = t
      break
    }
```

- [x] **Step 4: Put the boundary in the identity key**

In `baseIdentityKey`:

```ts
    // `unlit` picks the THREE material CLASS (Basic vs Standard) — that boundary needs a
    // rebuild, exactly as it does for shaderFill below.
    case 'image': return `image:${mat.image ?? ''}:${mat.unlit === true ? 1 : 0}`
```

- [x] **Step 5: Guard the in-place update**

In `updateMaterial`'s `case 'image':`:

```ts
    case 'image': {
      const s = m as THREE.MeshStandardMaterial
      s.color.set(stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint))
      // roughness/metalness exist only on the Standard (lit) variant. The identity guard
      // above already rebuilt if `unlit` moved, so this branch is guaranteed to still be
      // holding the class it was built as.
      if (mat.unlit !== true) { s.roughness = mat.roughness; s.metalness = mat.metalness }
      m.userData.imageSpec = mat
      if (s.map) applyImageTransform(s.map, mat, m.userData.imageNatural as NaturalSize | undefined)
      return true
    }
```

- [x] **Step 6: Offer the toggle**

In `frontend/app/lib/scene3d/controls.ts`, add the predicate below `isImageMaterial`:

```ts
// The Unlit switch exists on the two types that have a Basic-vs-Standard choice at all:
// shaderFill (a catalog effect that often wants to glow flat) and image (a photo or logo
// that usually wants to be shown as it is). Every other type has no such choice.
const hasUnlitToggle = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isShaderFillMaterial(doc, obj) || isImageMaterial(doc, obj)
```

Change the `object.material.unlit` control's `when` from `isShaderFillMaterial` to `hasUnlitToggle`.

In `hasPbrSurface`, add the image type to the unlit exclusion so Roughness and Metalness disappear on a flat picture. Replace the two type branches:

```ts
const hasPbrSurface = (doc: SceneDoc, obj?: SceneObject): boolean => {
  if (!isEditableMaterial(doc, obj)) return false
  const t = materialTypeOf(obj)
  const unlit = !!obj && obj.kind !== 'light' && obj.material.unlit === true
  if (t === 'standard' || t === 'glass' || t === 'opalescent') return true
  // image and shaderFill both build a MeshBasicMaterial when unlit, which has neither slot.
  if (t === 'image' || t === 'shaderFill') return !unlit
  return false
}
```

- [x] **Step 7: Place the row**

In `MATERIAL_BODY.image`, add `'object.material.unlit'` directly after `'ui.material.image'`, and update the parity expectation to match:

```ts
  image: [
    'ui.material.image', 'object.material.unlit',
    'object.material.imageFit', 'object.material.imageWrap',
    'object.material.imageTiling', 'object.material.imageTilingLinked', 'object.material.imageTilingY',
    'object.material.roughness', 'object.material.metalness',
  ],
```

The parity spec's `image` expectation gains `${M}unlit` in the same position. Note that Roughness and Metalness now drop out of the rendered list once `unlit` is true — if the parity spec has a case that renders an image material, add a second case covering the unlit state:

```ts
  it('an unlit image drops the two PBR rows', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box')
    o.material.type = 'image'
    o.material.unlit = true
    const keys = panel(doc, o).filter((c) => c.key.startsWith(M)).map((c) => c.key)
    expect(keys).not.toContain(`${M}roughness`)
    expect(keys).not.toContain(`${M}metalness`)
  })
```

- [x] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS. Pay attention to `scene3d-controls-switches.unit.spec.ts` and `scene3d-agent-controls.unit.spec.ts` — widening `unlit`'s `when` changes which material types report it as available.

- [x] **Step 9: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/controls.ts \
  frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): flat (unlit) image material"
```

---

### Task 8: Transparency — image alpha, cutout, opacity

A PNG with an alpha channel currently renders solid: the image material never sets `transparent`, and `opacity` is gated to the physical types. This task turns on all three, with the cutout path (`alphaTest`) offered because it gives hard-edged stickers and cut-out foliage with no sorting cost at all.

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts`
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`SUB_CARDS['Material/Transparency']`)
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageAlpha`, `.imageCutout`, `.opacity` (Task 1 and the existing field).
- Produces: a shared helper `applyImageTransparency(m: THREE.Material, mat: SceneMaterial): void` in `materials.ts`, called from both the build and the update path; the control keys `object.material.imageAlpha`, `object.material.imageCutout`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image transparency', () => {
  it('is opaque by default, exactly as before', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(m.transparent).toBe(false)
    expect(m.alphaTest).toBe(0)
    expect(m.opacity).toBe(1)
  })

  it('honours the file alpha when asked', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageAlpha: true }))
    expect(m.transparent).toBe(true)
  })

  it('turns a cutout into alphaTest rather than blending', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageAlpha: true, imageCutout: 0.5 }))
    expect(m.alphaTest).toBe(0.5)
  })

  it('ignores the cutout while the file alpha is off', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageCutout: 0.5 }))
    expect(m.alphaTest).toBe(0)
  })

  it('makes the whole surface see-through from opacity', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', opacity: 0.4 }))
    expect(m.opacity).toBe(0.4)
    expect(m.transparent).toBe(true)
  })

  it('recompiles only when a define boundary is actually crossed', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    m.version = 0
    // A move within the opaque range must not recompile.
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageTiling: 2 }))
    expect(m.version).toBe(0)
    // Crossing into transparency must.
    updateMaterial(m, base({ type: 'image', image: 'a.png', opacity: 0.5 }))
    expect(m.version).toBeGreaterThan(0)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL — `transparent` stays false with `imageAlpha: true`.

- [x] **Step 3: Write the shared helper**

In `frontend/app/lib/scene3d/materials.ts`, directly above `ownedImageTexture`:

```ts
/**
 * The image material's transparency, shared by the build and the in-place update so the
 * two can never disagree.
 *
 * Two independent paths, deliberately:
 *  - `imageAlpha` honours the FILE's own alpha channel. It moves the material into the
 *    sorted, blended render list, which is why it is off by default rather than always on.
 *  - `imageCutout` is `alphaTest`: fragments below the threshold leave the shader with
 *    `discard`, so a sticker or a cut-out leaf gets a hard edge, writes depth, and needs no
 *    sorting at all. Only meaningful alongside `imageAlpha` — with no alpha channel every
 *    fragment is 1.0 and the test never fires — so it is gated on it.
 *  - `opacity` fades the whole surface, and forces `transparent` on its own.
 *
 * Both `transparent` and a zero-crossing of `alphaTest` are PROGRAM DEFINE boundaries that
 * three does not manage for us (unlike transmission/clearcoat/sheen, whose setters
 * self-recompile). Bump `needsUpdate` on a crossing and NEVER on a plain slider move
 * inside a range, or every tick recompiles the shader.
 */
function applyImageTransparency(m: THREE.Material, mat: SceneMaterial): void {
  const wasTransparent = m.transparent
  const wasCutting = m.alphaTest > 0
  const useAlpha = mat.imageAlpha === true
  const opacity = mat.opacity ?? MATERIAL_DEFAULTS.opacity
  m.opacity = opacity
  m.alphaTest = useAlpha ? (mat.imageCutout ?? MATERIAL_DEFAULTS.imageCutout) : 0
  // A pure cutout is NOT transparent: it discards, writes depth, and sorts like an opaque
  // surface — which is the whole reason to reach for it.
  m.transparent = opacity < 1 || (useAlpha && m.alphaTest === 0)
  if (m.transparent !== wasTransparent || (m.alphaTest > 0) !== wasCutting) m.needsUpdate = true
}
```

- [x] **Step 4: Call it from both paths**

At the end of `case 'image':` in `materialFor`, before `m = t`:

```ts
      applyImageTransparency(t, mat)
```

And in `updateMaterial`'s `case 'image':`, after the `imageSpec` stamp:

```ts
      applyImageTransparency(m, mat)
```

- [x] **Step 5: Declare the controls**

In `frontend/app/lib/scene3d/controls.ts`, after the tint:

```ts
  {
    key: 'object.material.imageAlpha', label: 'Use image transparency', kind: 'switch',
    default: MATERIAL_DEFAULTS.imageAlpha, group: 'Material',
    hint: 'Honours the see-through parts of the file, such as a PNG with a cut-out background',
    when: isImageMaterial,
  } as SceneControl,
  slider('object.material.imageCutout', 'Cutout', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageCutout,
    'Anything fainter than this is cut away completely, giving a hard edge instead of a soft blend', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageAlpha', equals: true },
    }),
```

Widen the existing `object.material.opacity` slider's `when` so the image type gets it. Add the predicate below `hasUnlitToggle`:

```ts
// Opacity is a plain Material field every class has, so it reads on the physical types and
// on image. (transmission/ior/thickness and the rest of the physical block stay
// standard+glass only — a picture has no volumetric interior.)
const hasOpacity = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isPhysicalMaterial(doc, obj) || isImageMaterial(doc, obj)
```

…and change the opacity control's `when: isPhysicalMaterial` to `when: hasOpacity`.

- [x] **Step 6: Place the rows**

In `frontend/app/lib/scene3d/panelPresentation.ts`, prepend the two new keys to the existing `'Material/Transparency'` sub-card so they lead the block for an image material:

```ts
  'Material/Transparency': [
    'object.material.imageAlpha', 'object.material.imageCutout',
    'ui.material.prism', 'object.material.opacity', 'object.material.transmission',
    'object.material.ior', 'object.material.thickness', 'object.material.dispersion',
    'object.material.attenuationColor', 'object.material.attenuationDistance',
  ],
```

The card is already in `SCENE_PANEL_ORDER` and already has chrome; the `when` gates decide which of its rows an image material actually shows (`imageAlpha`, `imageCutout`, `opacity`).

- [x] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS. Update the transparency-card expectation in `scene3d-panel-parity.unit.spec.ts` if it pins the card's exact contents for standard/glass — the two new keys are gated to `image`, so a standard material's rendered list is unchanged, but a spec that asserts the raw `SUB_CARDS` array will need the two extra entries.

- [x] **Step 8: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/controls.ts \
  frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): image transparency, cutout and opacity"
```

---

### Task 9: Glow

Bind the picture as an emissive map so it lights itself — signage, screens, neon, a light-box. Distinct from Flat: a glowing picture still takes scene light and still casts into bloom, where a flat one simply ignores lighting.

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts`
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`SUB_CARDS['Material/Image look']`)
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageGlow`, the owned texture from Task 3.
- Produces: a helper `applyImageGlow(m: THREE.Material, mat: SceneMaterial): void` in `materials.ts`; the control key `object.material.imageGlow`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image glow', () => {
  it('is off by default', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(m.emissiveMap).toBeNull()
    expect(m.emissiveIntensity).toBe(1)
  })

  it('binds the same texture as the emissive map and drives its intensity', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 2 }))).toBe(true)
    expect(m.emissiveMap).toBe(m.map)
    expect(m.emissiveIntensity).toBe(2)
    // The emissive colour must be white, or the map is multiplied into black and nothing glows.
    expect(`#${m.emissive.getHexString()}`).toBe('#ffffff')
  })

  it('unbinds when the glow returns to zero', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 2 }))
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 0 }))
    expect(m.emissiveMap).toBeNull()
    expect(`#${m.emissive.getHexString()}`).toBe('#000000')
  })

  it('is a no-op on the flat variant, which has no emissive slot', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true, imageGlow: 2 }))
    expect((m as unknown as { emissiveMap?: unknown }).emissiveMap).toBeUndefined()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: FAIL — `emissiveMap` is never bound.

- [x] **Step 3: Write the helper**

In `frontend/app/lib/scene3d/materials.ts`, below `applyImageTransparency`:

```ts
/**
 * Bind the picture as its own emissive map, so it lights itself — a screen, a sign, a
 * light-box. Reuses the SAME Texture object as `.map` rather than loading a second copy:
 * the UV transform, the wrap mode and the tiling all travel with it for free, which is
 * exactly what you want (the glow must line up with the picture).
 *
 * Binding an emissive map with a BLACK `emissive` colour renders nothing at all — three
 * multiplies the two — so the colour is driven to white alongside the map and back to
 * black when the glow is off, rather than being exposed as a second control.
 *
 * A no-op on MeshBasicMaterial (the flat variant): there is no emissive slot, and there is
 * no lighting model for one to feed.
 */
function applyImageGlow(m: THREE.Material, mat: SceneMaterial): void {
  const s = m as THREE.MeshStandardMaterial
  if (!('emissiveMap' in s)) return
  const glow = mat.imageGlow ?? MATERIAL_DEFAULTS.imageGlow
  const on = glow > 0 && !!s.map
  const wasOn = !!s.emissiveMap
  s.emissiveMap = on ? s.map : null
  s.emissive.set(on ? '#ffffff' : '#000000')
  s.emissiveIntensity = on ? glow : 1
  // USE_EMISSIVEMAP is a program define three does not manage on assignment.
  if (on !== wasOn) s.needsUpdate = true
}
```

- [x] **Step 4: Call it from both paths**

In `materialFor`'s `case 'image':`, after `applyImageTransparency(t, mat)`:

```ts
      applyImageGlow(t, mat)
```

In `updateMaterial`'s `case 'image':`, after `applyImageTransparency(m, mat)`:

```ts
      applyImageGlow(m, mat)
```

Note the ordering matters in the build path: `applyImageGlow` reads `.map`, so it must run after the texture is bound.

- [x] **Step 5: Declare the control**

In `frontend/app/lib/scene3d/controls.ts`, after the tint:

```ts
  slider('object.material.imageGlow', 'Glow', 0, 5, 0.05, 'Material', MATERIAL_DEFAULTS.imageGlow,
    'Makes the picture light itself, like a screen or a sign', {
      when: isImageMaterial,
      showIf: { key: 'object.material.unlit', notEquals: true },
    }),
```

- [x] **Step 6: Place the row**

In `SUB_CARDS`, extend the look card:

```ts
  'Material/Image look': ['object.material.imageTint', 'object.material.imageGlow'],
```

…and extend the Task 6 parity expectation to `[`${M}imageTint`, `${M}imageGlow`]`.

- [x] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts frontend/app/lib/scene3d/controls.ts \
  frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): image glow (emissive map)"
```

---

### Task 10: Adjustments — brightness, contrast, saturation

The first shader work. Three uniforms and a five-line function injected after the map is sampled. It is deliberately ALWAYS injected, with identity defaults, so that moving any of the three never crosses a program boundary and never recompiles mid-drag.

**Files:**
- Create: `frontend/app/lib/scene3d/imageShader.ts`
- Modify: `frontend/app/lib/scene3d/materials.ts`
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts`
- Test: `frontend/tests/unit/scene3d-image-shader.unit.spec.ts`, `frontend/tests/unit/scene3d-materials.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageBrightness`, `.imageContrast`, `.imageSaturation`.
- Produces:
  - `imageUniforms(mat: SceneMaterial): ImageUniforms` — a fresh uniform bucket.
  - `interface ImageUniforms { uImgBrightness: { value: number }; uImgContrast: { value: number }; uImgSaturation: { value: number } }`
  - `writeImageUniforms(u: ImageUniforms, mat: SceneMaterial): void`
  - `IMAGE_ADJUST_GLSL: string` — the function definition.
  - `IMAGE_ADJUST_CALL: string` — the one line spliced in after `<map_fragment>`.
  - `m.userData.imageUniforms` on the built material, mutated in place by `updateMaterial`.

- [x] **Step 1: Write the failing test**

Create `frontend/tests/unit/scene3d-image-shader.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { imageUniforms, writeImageUniforms, IMAGE_ADJUST_GLSL, IMAGE_ADJUST_CALL } from '~/lib/scene3d/imageShader'
import type { SceneMaterial } from '~/lib/scene3d/config'

const img = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'image', color: '#ffffff', roughness: 0.6, metalness: 0, image: 'a.png', ...patch })

describe('image adjustment uniforms', () => {
  it('defaults to an identity adjustment', () => {
    const u = imageUniforms(img())
    expect(u.uImgBrightness.value).toBe(0)
    expect(u.uImgContrast.value).toBe(1)
    expect(u.uImgSaturation.value).toBe(1)
  })

  it('writes in place, keeping the uniform objects the program holds by reference', () => {
    const u = imageUniforms(img())
    const b = u.uImgBrightness
    writeImageUniforms(u, img({ imageBrightness: 0.3, imageContrast: 1.5, imageSaturation: 0 }))
    expect(u.uImgBrightness).toBe(b)
    expect(b.value).toBe(0.3)
    expect(u.uImgContrast.value).toBe(1.5)
    expect(u.uImgSaturation.value).toBe(0)
  })
})

describe('image adjustment GLSL', () => {
  it('declares each uniform exactly once', () => {
    for (const name of ['uImgBrightness', 'uImgContrast', 'uImgSaturation']) {
      expect(IMAGE_ADJUST_GLSL.match(new RegExp(`uniform float ${name};`, 'g'))?.length).toBe(1)
    }
  })

  it('exposes a function the call line actually invokes', () => {
    expect(IMAGE_ADJUST_GLSL).toContain('vec3 sailorImageAdjust(')
    expect(IMAGE_ADJUST_CALL).toContain('sailorImageAdjust(')
  })

  it('keeps the include it splices onto', () => {
    expect(IMAGE_ADJUST_CALL.startsWith('#include <map_fragment>')).toBe(true)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-image-shader.unit.spec.ts`
Expected: FAIL — cannot resolve `~/lib/scene3d/imageShader`.

- [x] **Step 3: Write the shader module**

Create `frontend/app/lib/scene3d/imageShader.ts`:

```ts
import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

/**
 * The GLSL the `image` material injects through `onBeforeCompile`, and the uniform bucket
 * behind it. Strings and plain objects only — no `three` import, no DOM — so the whole
 * module is unit-testable in the node environment.
 *
 * The adjustment chunk is injected UNCONDITIONALLY, with identity defaults, rather than
 * only when an adjustment is non-neutral. That is deliberate: making injection conditional
 * would put the three sliders on a program-define boundary, so the first pixel of a
 * brightness drag would recompile the shader. Three extra arithmetic ops per fragment is a
 * far better trade than a mid-drag stall.
 */

export interface ImageUniforms {
  uImgBrightness: { value: number }
  uImgContrast: { value: number }
  uImgSaturation: { value: number }
}

export function imageUniforms(mat: SceneMaterial): ImageUniforms {
  return {
    uImgBrightness: { value: mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness },
    uImgContrast: { value: mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast },
    uImgSaturation: { value: mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation },
  }
}

/** Mutate the bucket the compiled program holds BY REFERENCE. Never replace the inner
 *  objects — the program keeps the references it was compiled with. */
export function writeImageUniforms(u: ImageUniforms, mat: SceneMaterial): void {
  u.uImgBrightness.value = mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness
  u.uImgContrast.value = mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast
  u.uImgSaturation.value = mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation
}

/** Prepended to the fragment shader, ahead of `void main()`. Rec. 709 luma for the
 *  saturation pivot — the same weights the studio's post stack uses. */
export const IMAGE_ADJUST_GLSL = `
uniform float uImgBrightness;
uniform float uImgContrast;
uniform float uImgSaturation;
vec3 sailorImageAdjust( vec3 c ) {
  c = ( c - 0.5 ) * uImgContrast + 0.5;
  c += uImgBrightness;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uImgSaturation );
  return clamp( c, 0.0, 1.0 );
}
`

/**
 * Replaces `#include <map_fragment>`, keeping the include and appending the adjustment.
 *
 * NB the adjustment runs on `diffuseColor` AFTER the tint has been multiplied in (three
 * seeds `diffuseColor` from the material's `.color` before this chunk samples the map), so
 * Contrast and Saturation act on the tinted picture, not on the raw file. That is the
 * useful order — a tinted picture desaturating toward its tint rather than toward grey.
 */
export const IMAGE_ADJUST_CALL = `#include <map_fragment>
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );`
```

- [x] **Step 4: Inject it**

In `frontend/app/lib/scene3d/materials.ts`, add the import:

```ts
import { imageUniforms, writeImageUniforms, IMAGE_ADJUST_GLSL, IMAGE_ADJUST_CALL, type ImageUniforms } from './imageShader'
```

In `materialFor`'s `case 'image':`, after the material is constructed and before the texture is bound:

```ts
      // Colour adjustments: always injected, identity by default — see imageShader.ts on
      // why this is unconditional rather than gated on a non-neutral value.
      const iu = imageUniforms(mat)
      t.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, iu)
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', `${IMAGE_ADJUST_GLSL}\nvoid main() {`)
          .replace('#include <map_fragment>', IMAGE_ADJUST_CALL)
      }
      // Without this, three pools the compiled program with every OTHER material that has
      // the same feature defines — including materials with no injection at all.
      t.customProgramCacheKey = () => 'scene3d-image'
      t.userData.imageUniforms = iu
```

In `updateMaterial`'s `case 'image':`, after the `imageSpec` stamp:

```ts
      const iu = m.userData.imageUniforms as ImageUniforms | undefined
      if (iu) writeImageUniforms(iu, mat)
```

- [x] **Step 5: Add a materials-level test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image adjustments', () => {
  it('carries a live uniform bucket that updates without a rebuild', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    const u = m.userData.imageUniforms
    expect(u.uImgContrast.value).toBe(1)
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageContrast: 1.6 }))).toBe(true)
    expect(m.userData.imageUniforms).toBe(u)
    expect(u.uImgContrast.value).toBe(1.6)
  })

  it('injects the adjustment into the compiled fragment shader', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '', fragmentShader: 'void main() {\n#include <map_fragment>\n}' }
    m.onBeforeCompile!(shader as never, null as never)
    expect(shader.fragmentShader).toContain('sailorImageAdjust')
    expect(shader.fragmentShader).toContain('#include <map_fragment>')
    expect(shader.uniforms.uImgContrast).toBe(m.userData.imageUniforms.uImgContrast)
  })
})
```

- [x] **Step 6: Declare the controls**

In `frontend/app/lib/scene3d/controls.ts`, after the glow slider:

```ts
  slider('object.material.imageBrightness', 'Brightness', -1, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageBrightness,
    'Lifts or lowers the whole picture', { when: isImageMaterial }),
  slider('object.material.imageContrast', 'Contrast', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.imageContrast,
    'Pushes the light and dark parts of the picture apart', { when: isImageMaterial }),
  slider('object.material.imageSaturation', 'Saturation', 0, 2, 0.01, 'Material', MATERIAL_DEFAULTS.imageSaturation,
    'Drains the picture toward grey, or pushes its colours further', { when: isImageMaterial }),
```

- [x] **Step 7: Place the rows**

In `SUB_CARDS`:

```ts
  'Material/Image look': [
    'object.material.imageTint',
    'object.material.imageBrightness', 'object.material.imageContrast', 'object.material.imageSaturation',
    'object.material.imageGlow',
  ],
```

Update the Task 6/9 parity expectation to that exact five-key array.

- [x] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add frontend/app/lib/scene3d/imageShader.ts frontend/app/lib/scene3d/materials.ts \
  frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): image brightness, contrast and saturation"
```

---

### Task 11: Projection — flat, cylinder, sphere and box

The real gap. `.map` samples the mesh's own UV attribute, and much of the geometry the studio produces has poor UVs or none: `ExtrudeGeometry` (text, SVG import) stretches its sidewalls badly, and `ConvexGeometry` has no UV attribute at all — `mesh.ts` already patches that with a spherical fallback. This task derives the texture coordinate from object-space position instead, so a picture can be projected onto any shape regardless of its UVs.

Projection is computed in the FRAGMENT shader, not the vertex shader, because the angular modes wrap: a triangle straddling the seam of a cylindrical projection would interpolate `u` from 0.99 back to 0.01 and smear the entire picture across it. Per-fragment confines that artifact to a thin line. The cost is carrying two varyings and reproducing the texture matrix in a uniform of our own — three only declares `mapTransform` in the vertex shader.

**Files:**
- Modify: `frontend/app/lib/scene3d/imageShader.ts`
- Modify: `frontend/app/lib/scene3d/materials.ts`
- Modify: `frontend/app/lib/scene3d/controls.ts`
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts`
- Test: `frontend/tests/unit/scene3d-image-shader.unit.spec.ts`, `frontend/tests/unit/scene3d-materials.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageProjection`, `.imageProjectionAxis`; the `geometry` argument `materialFor` already receives (the gradient material reads its bounding box the same way).
- Produces:
  - `ImageUniforms` gains `uImgProjMode: { value: number }`, `uImgProjAxis: { value: number }`, `uImgMapTx: { value: THREE.Matrix3 }`, `uImgBoundsMin: { value: THREE.Vector3 }`, `uImgBoundsSize: { value: THREE.Vector3 }`.
  - `imageUniforms(mat, geometry?)` — second argument added.
  - `IMAGE_PROJECT_VERTEX_GLSL`, `IMAGE_PROJECT_VERTEX_CALL`, `imageMapFragment(box: boolean): string` replace `IMAGE_ADJUST_CALL`.
  - `syncImageMapMatrix(u: ImageUniforms, tex: THREE.Texture | null): void`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-image-shader.unit.spec.ts`:

```ts
import { imageMapFragment, IMAGE_PROJECT_VERTEX_GLSL, IMAGE_PROJECT_VERTEX_CALL } from '~/lib/scene3d/imageShader'

describe('image projection GLSL', () => {
  it('numbers each mode, with the mesh UVs at zero so the default is a no-op', () => {
    expect(imageUniforms(img()).uImgProjMode.value).toBe(0)
    expect(imageUniforms(img({ imageProjection: 'planar' })).uImgProjMode.value).toBe(1)
    expect(imageUniforms(img({ imageProjection: 'cylindrical' })).uImgProjMode.value).toBe(2)
    expect(imageUniforms(img({ imageProjection: 'spherical' })).uImgProjMode.value).toBe(3)
    // Box is its own program, not a mode on this one — see identityKey.
    expect(imageUniforms(img({ imageProjection: 'box' })).uImgProjMode.value).toBe(0)
  })

  it('numbers the axis', () => {
    expect(imageUniforms(img({ imageProjectionAxis: 'x' })).uImgProjAxis.value).toBe(0)
    expect(imageUniforms(img({ imageProjectionAxis: 'y' })).uImgProjAxis.value).toBe(1)
    expect(imageUniforms(img({ imageProjectionAxis: 'z' })).uImgProjAxis.value).toBe(2)
  })

  it('passes object-space position and normal from the vertex shader', () => {
    expect(IMAGE_PROJECT_VERTEX_GLSL).toContain('varying vec3 vImgPos;')
    expect(IMAGE_PROJECT_VERTEX_GLSL).toContain('varying vec3 vImgNrm;')
    expect(IMAGE_PROJECT_VERTEX_CALL).toContain('vImgPos = position;')
    expect(IMAGE_PROJECT_VERTEX_CALL).toContain('vImgNrm = normal;')
  })

  it('replaces the map include rather than appending to it, and still adjusts', () => {
    const frag = imageMapFragment(false)
    expect(frag).not.toContain('#include <map_fragment>')
    expect(frag).toContain('texture2D( map,')
    expect(frag).toContain('sailorImageAdjust')
    expect(frag).toContain('uImgMapTx')
  })

  it('falls back to the mesh UVs at mode zero', () => {
    expect(imageMapFragment(false)).toContain('vMapUv')
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-image-shader.unit.spec.ts`
Expected: FAIL — `imageMapFragment` is not exported.

- [x] **Step 3: Extend the shader module**

Rewrite the exports of `frontend/app/lib/scene3d/imageShader.ts` as follows. The `ImageUniforms` interface, `imageUniforms`, `writeImageUniforms` and `IMAGE_ADJUST_GLSL` are edited; `IMAGE_ADJUST_CALL` is DELETED and replaced by `imageMapFragment`.

Because `IMAGE_ADJUST_CALL` goes away, DELETE the two assertions Task 10 wrote against it — the "exposes a function the call line actually invokes" and "keeps the include it splices onto" tests in `scene3d-image-shader.unit.spec.ts`. The replacements are in this task's Step 1.

```ts
import * as THREE from 'three'
import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

const PROJ_MODE: Record<string, number> = { uv: 0, planar: 1, cylindrical: 2, spherical: 3, box: 0 }
const PROJ_AXIS: Record<string, number> = { x: 0, y: 1, z: 2 }

export interface ImageUniforms {
  uImgBrightness: { value: number }
  uImgContrast: { value: number }
  uImgSaturation: { value: number }
  /** 0 mesh UVs, 1 flat, 2 cylinder, 3 sphere. 'box' is a separate PROGRAM (three
   *  texture samples), not a mode here, so it reports 0 and never reaches the branch. */
  uImgProjMode: { value: number }
  uImgProjAxis: { value: number }
  /** Our own copy of the texture's UV matrix. three declares `mapTransform` in the VERTEX
   *  shader only, and the projection has to reproduce the transform per fragment. Kept in
   *  step by syncImageMapMatrix. */
  uImgMapTx: { value: THREE.Matrix3 }
  /** Object-space bounds, so a projection spans the object rather than raw world units.
   *  Read from the geometry at BUILD time — `updateMaterial` gets no geometry, so a
   *  reshaped mesh picks these up on its next rebuild. The gradient material has read its
   *  bounds the same way, with the same limitation, since it shipped. */
  uImgBoundsMin: { value: THREE.Vector3 }
  uImgBoundsSize: { value: THREE.Vector3 }
  uImgBoxBlend: { value: number }
}

export function imageUniforms(mat: SceneMaterial, geometry?: THREE.BufferGeometry): ImageUniforms {
  const min = new THREE.Vector3(-0.5, -0.5, -0.5)
  const size = new THREE.Vector3(1, 1, 1)
  if (geometry) {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (bb) {
      min.copy(bb.min)
      size.subVectors(bb.max, bb.min)
      // A flat object (a plane, a decal card) has a zero extent on one axis; dividing by it
      // would produce infinities across the whole projection.
      size.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4))
    }
  }
  return {
    uImgBrightness: { value: mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness },
    uImgContrast: { value: mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast },
    uImgSaturation: { value: mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation },
    uImgProjMode: { value: PROJ_MODE[mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection] ?? 0 },
    uImgProjAxis: { value: PROJ_AXIS[mat.imageProjectionAxis ?? MATERIAL_DEFAULTS.imageProjectionAxis] ?? 1 },
    uImgMapTx: { value: new THREE.Matrix3() },
    uImgBoundsMin: { value: min },
    uImgBoundsSize: { value: size },
    uImgBoxBlend: { value: mat.imageBoxBlend ?? MATERIAL_DEFAULTS.imageBoxBlend },
  }
}

export function writeImageUniforms(u: ImageUniforms, mat: SceneMaterial): void {
  u.uImgBrightness.value = mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness
  u.uImgContrast.value = mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast
  u.uImgSaturation.value = mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation
  u.uImgProjMode.value = PROJ_MODE[mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection] ?? 0
  u.uImgProjAxis.value = PROJ_AXIS[mat.imageProjectionAxis ?? MATERIAL_DEFAULTS.imageProjectionAxis] ?? 1
  u.uImgBoxBlend.value = mat.imageBoxBlend ?? MATERIAL_DEFAULTS.imageBoxBlend
}

/** Copy the texture's own UV matrix into the uniform the fragment projection reads.
 *  `updateMatrix` must run first: three only refreshes it during rendering. */
export function syncImageMapMatrix(u: ImageUniforms, tex: THREE.Texture | null | undefined): void {
  if (!tex) return
  tex.updateMatrix()
  u.uImgMapTx.value.copy(tex.matrix)
}

export const IMAGE_PROJECT_VERTEX_GLSL = `
varying vec3 vImgPos;
varying vec3 vImgNrm;
`

/** Spliced in after `#include <begin_vertex>`, where `position` and `normal` are in scope. */
export const IMAGE_PROJECT_VERTEX_CALL = `#include <begin_vertex>
  vImgPos = position;
  vImgNrm = normal;`

export const IMAGE_ADJUST_GLSL = `
uniform float uImgBrightness;
uniform float uImgContrast;
uniform float uImgSaturation;
uniform float uImgProjMode;
uniform float uImgProjAxis;
uniform float uImgBoxBlend;
uniform mat3 uImgMapTx;
uniform vec3 uImgBoundsMin;
uniform vec3 uImgBoundsSize;
varying vec3 vImgPos;
varying vec3 vImgNrm;

vec3 sailorImageAdjust( vec3 c ) {
  c = ( c - 0.5 ) * uImgContrast + 0.5;
  c += uImgBrightness;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uImgSaturation );
  return clamp( c, 0.0, 1.0 );
}

/** Object-space position, normalised to 0..1 across the object's own bounds. */
vec3 sailorImageUnit( vec3 p ) {
  return ( p - uImgBoundsMin ) / uImgBoundsSize;
}

/** A flat projection facing down one axis. */
vec2 sailorImagePlanar( vec3 p, float axis ) {
  vec3 u = sailorImageUnit( p );
  if ( axis < 0.5 ) return u.zy;   // facing X
  if ( axis < 1.5 ) return u.xz;   // facing Y
  return u.xy;                      // facing Z
}

/** A cylinder spun about one axis: angle across, height up. The seam sits on the -X
 *  meridian, where atan wraps; that thin line is unavoidable in any angular projection. */
vec2 sailorImageCylindrical( vec3 p, float axis ) {
  vec3 u = sailorImageUnit( p ) - 0.5;
  vec2 around = axis < 0.5 ? vec2( u.y, u.z ) : ( axis < 1.5 ? vec2( u.z, u.x ) : vec2( u.x, u.y ) );
  float along = axis < 0.5 ? u.x : ( axis < 1.5 ? u.y : u.z );
  return vec2( atan( around.x, around.y ) / 6.2831853 + 0.5, along + 0.5 );
}

/** A sphere: longitude across, latitude up. Always Y-up — an axis choice here would only
 *  rotate the picture, which the Rotation control already does. */
vec2 sailorImageSpherical( vec3 p ) {
  vec3 d = normalize( sailorImageUnit( p ) - 0.5 );
  return vec2( atan( d.z, d.x ) / 6.2831853 + 0.5, acos( clamp( d.y, -1.0, 1.0 ) ) / 3.1415927 );
}

vec2 sailorImageProject( vec3 p, float mode, float axis ) {
  if ( mode < 1.5 ) return sailorImagePlanar( p, axis );
  if ( mode < 2.5 ) return sailorImageCylindrical( p, axis );
  return sailorImageSpherical( p );
}
`

/**
 * REPLACES `#include <map_fragment>` outright, rather than appending to it as the
 * adjustment alone did — the projection has to choose the coordinate before the sample,
 * which the stock chunk gives no seam for. `DECODE_VIDEO_TEXTURE` is dropped deliberately:
 * the image material binds still images from the input directory, never a video texture.
 *
 * `box` is the three-sample triplanar blend, and is a SEPARATE PROGRAM (see identityKey in
 * materials.ts) so a plain projection never pays for two extra texture fetches.
 */
export function imageMapFragment(box: boolean): string {
  const single = `
#ifdef USE_MAP
  vec2 sailorUv = uImgProjMode < 0.5
    ? vMapUv
    : ( uImgMapTx * vec3( sailorImageProject( vImgPos, uImgProjMode, uImgProjAxis ), 1.0 ) ).xy;
  diffuseColor *= texture2D( map, sailorUv );
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  const triplanar = `
#ifdef USE_MAP
  vec3 sailorN = abs( normalize( vImgNrm ) );
  sailorN = pow( sailorN, vec3( 1.0 + ( 1.0 - uImgBoxBlend ) * 16.0 ) );
  sailorN /= max( sailorN.x + sailorN.y + sailorN.z, 1e-4 );
  vec4 sailorX = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 0.0 ), 1.0 ) ).xy );
  vec4 sailorY = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 1.0 ), 1.0 ) ).xy );
  vec4 sailorZ = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 2.0 ), 1.0 ) ).xy );
  diffuseColor *= sailorX * sailorN.x + sailorY * sailorN.y + sailorZ * sailorN.z;
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  return box ? triplanar : single
}
```

- [x] **Step 4: Wire the injection**

In `frontend/app/lib/scene3d/materials.ts`, update the import and replace the `onBeforeCompile` block written in Task 10:

```ts
import {
  imageUniforms, writeImageUniforms, syncImageMapMatrix,
  IMAGE_ADJUST_GLSL, IMAGE_PROJECT_VERTEX_GLSL, IMAGE_PROJECT_VERTEX_CALL, imageMapFragment,
  type ImageUniforms,
} from './imageShader'
```

```ts
      // Projection + adjustments, injected unconditionally with identity defaults so that
      // moving any of these dials never crosses a program boundary. The ONE boundary is
      // 'box' (three texture samples instead of one), which identityKey rebuilds on.
      const isBox = (mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection) === 'box'
      const iu = imageUniforms(mat, geometry)
      t.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, iu)
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', `${IMAGE_PROJECT_VERTEX_GLSL}\nvoid main() {`)
          .replace('#include <begin_vertex>', IMAGE_PROJECT_VERTEX_CALL)
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', `${IMAGE_ADJUST_GLSL}\nvoid main() {`)
          .replace('#include <map_fragment>', imageMapFragment(isBox))
      }
      t.customProgramCacheKey = () => `scene3d-image:${isBox ? 'box' : 'single'}`
      t.userData.imageUniforms = iu
```

In `updateMaterial`'s `case 'image':`, the uniform write grows a matrix sync — the UV matrix is what carries tiling, offset, rotation and fit into a projected sample:

```ts
      const iu = m.userData.imageUniforms as ImageUniforms | undefined
      if (iu) {
        writeImageUniforms(iu, mat)
        syncImageMapMatrix(iu, s.map)
      }
```

Call `syncImageMapMatrix` in the build path too, immediately after `applyImageTransform(tex, mat, null)`, and add it to `ownedImageTexture`'s `onLoad` (right after its `applyImageTransform` call) so a projected picture settles when the fit lands:

```ts
      const u = m.userData.imageUniforms as ImageUniforms | undefined
      if (u) syncImageMapMatrix(u, loaded)
```

- [x] **Step 5: Add the box boundary to the identity key**

In `baseIdentityKey`:

```ts
    // `unlit` picks the CLASS, and 'box' picks the PROGRAM (three texture samples rather
    // than one) — both need a rebuild. Every other image option is a uniform or a Texture
    // property and updates in place.
    case 'image': {
      const box = (mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection) === 'box' ? 1 : 0
      return `image:${mat.image ?? ''}:${mat.unlit === true ? 1 : 0}:${box}`
    }
```

- [x] **Step 6: Add the materials-level test**

Add to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
describe('image projection', () => {
  it('reads the object bounds from the geometry it is built against', () => {
    const geo = new THREE.BoxGeometry(2, 4, 6)
    const m = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'planar' }), geo)
    const u = m.userData.imageUniforms
    expect(u.uImgBoundsSize.value.x).toBeCloseTo(2)
    expect(u.uImgBoundsSize.value.y).toBeCloseTo(4)
    expect(u.uImgBoundsSize.value.z).toBeCloseTo(6)
  })

  it('never divides by a zero extent on a flat object', () => {
    const geo = new THREE.PlaneGeometry(2, 2)
    const u = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'planar' }), geo).userData.imageUniforms
    expect(u.uImgBoundsSize.value.z).toBeGreaterThan(0)
  })

  it('switches between the four single-sample modes without a rebuild', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'spherical' }))).toBe(true)
    expect(m.userData.imageUniforms.uImgProjMode.value).toBe(3)
  })

  it('rebuilds for box, which is a different program', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'box' }))).toBe(false)
  })

  it('gives the box program its own cache key', () => {
    const plain = materialFor(base({ type: 'image', image: 'a.png' }))
    const box = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'box' }))
    expect(plain.customProgramCacheKey!()).not.toBe(box.customProgramCacheKey!())
  })
})
```

- [x] **Step 7: Declare the controls**

In `frontend/app/lib/scene3d/controls.ts`, add `IMAGE_PROJECTIONS`, `IMAGE_AXES` to the `./config` import, and place these BEFORE the Fit select (projection decides which coordinate is used; fit and tiling then shape it):

```ts
  select('object.material.imageProjection', 'Wrapping', [...IMAGE_PROJECTIONS], MATERIAL_DEFAULTS.imageProjection, 'Material',
    'How the picture is laid onto the shape. Use the model follows the shape own texture coordinates; the others ignore them and project the picture on from outside, which is what you want on text, imported shapes and anything with poor coordinates',
    {
      when: isImageMaterial,
      optionLabels: ['Use the model', 'Flat', 'Cylinder', 'Sphere', 'Box'],
    }),
  select('object.material.imageProjectionAxis', 'Facing', [...IMAGE_AXES], MATERIAL_DEFAULTS.imageProjectionAxis, 'Material',
    'Which way the flat projection faces, or which axis the cylinder spins around',
    {
      when: isImageMaterial,
      optionLabels: ['X', 'Y', 'Z'],
      showIf: { key: 'object.material.imageProjection', in: ['planar', 'cylindrical'] },
    }),
  slider('object.material.imageBoxBlend', 'Box blend', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.imageBoxBlend,
    'How softly the three box faces fade into each other at an edge', {
      when: isImageMaterial,
      showIf: { key: 'object.material.imageProjection', equals: 'box' },
    }),
```

- [x] **Step 8: Place the rows**

`MATERIAL_BODY.image` becomes:

```ts
  image: [
    'ui.material.image', 'object.material.unlit',
    'object.material.imageProjection', 'object.material.imageProjectionAxis', 'object.material.imageBoxBlend',
    'object.material.imageFit', 'object.material.imageWrap',
    'object.material.imageTiling', 'object.material.imageTilingLinked', 'object.material.imageTilingY',
    'object.material.roughness', 'object.material.metalness',
  ],
```

Update the parity spec's `image` expectation to the same list, remembering that `imageProjectionAxis` and `imageBoxBlend` are `showIf`-gated and so do NOT appear in the default (Use the model) rendered list — assert the default state's list without them, and add a case that sets `imageProjection = 'planar'` and expects `${M}imageProjectionAxis` to appear.

- [x] **Step 9: Run the tests and verify live**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

Then, in the running studio: add a Text primitive (whose extruded sidewall UVs are the worst case), give it an image material with a recognisable picture, and step through Wrapping. On "Use the model" the sidewalls smear; on "Flat" the picture reads cleanly on the face; on "Cylinder" it wraps around; on "Box" every face is covered with no smearing. Confirm Tiling and Rotation still work in each mode — that is what proves `uImgMapTx` is being synced.

- [x] **Step 10: Commit**

```bash
git add frontend/app/lib/scene3d/imageShader.ts frontend/app/lib/scene3d/materials.ts \
  frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): image projection — flat, cylinder, sphere and box"
```

---

### Task 12: Seamless edges

Mirror wrapping (Task 3) hides a seam by flipping alternate copies, which is right for an abstract texture and wrong for anything with a readable orientation. This task offers the other answer: a one-off canvas pre-pass that cross-fades the picture's opposite edges into each other, so the file itself tiles.

The pre-pass needs a real canvas, so the pixel work cannot run in the node test environment. The DECISION is pure and is what gets unit-tested; the pixels get live verification.

**Files:**
- Modify: `frontend/app/lib/scene3d/imageMap.ts` (the decision + the pre-pass)
- Modify: `frontend/app/lib/scene3d/materials.ts` (call it from `onLoad`)
- Modify: `frontend/app/lib/scene3d/controls.ts`, `frontend/app/lib/scene3d/panelPresentation.ts`
- Test: `frontend/tests/unit/scene3d-image-map.unit.spec.ts`

**Interfaces:**
- Consumes: `MATERIAL_DEFAULTS.imageSeamless`; `m.userData.imageNatural` (Task 3).
- Produces: `seamlessWidth(mat: SceneMaterial): number` (0 = off) and `seamlessCanvas(src: CanvasImageSource, w: number, h: number, width: number): HTMLCanvasElement | null` in `imageMap.ts`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-image-map.unit.spec.ts`:

```ts
import { seamlessWidth, seamlessCanvas } from '~/lib/scene3d/imageMap'

describe('seamless pre-pass', () => {
  it('is off by default and off at zero', () => {
    expect(seamlessWidth(img())).toBe(0)
    expect(seamlessWidth(img({ imageSeamless: 0 }))).toBe(0)
  })

  it('clamps the blend to less than half the picture, where it would overlap itself', () => {
    expect(seamlessWidth(img({ imageSeamless: 0.2 }))).toBeCloseTo(0.2)
    expect(seamlessWidth(img({ imageSeamless: 5 }))).toBeCloseTo(0.45)
    expect(seamlessWidth(img({ imageSeamless: -1 }))).toBe(0)
  })

  it('declines to build a canvas with no DOM rather than throwing', () => {
    expect(seamlessCanvas(null as never, 64, 64, 0.2)).toBeNull()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-image-map.unit.spec.ts`
Expected: FAIL — `seamlessWidth` is not exported.

- [x] **Step 3: Write the pre-pass**

Append to `frontend/app/lib/scene3d/imageMap.ts`:

```ts
const hasDOM = typeof document !== 'undefined'

/** The blend width as a fraction of the picture, clamped below half — at half the two
 *  fades meet in the middle and the picture is replaced by its own average. */
export function seamlessWidth(mat: SceneMaterial): number {
  const w = mat.imageSeamless ?? MATERIAL_DEFAULTS.imageSeamless
  if (!(w > 0)) return 0
  return Math.min(w, 0.45)
}

/**
 * Cross-fade a picture's opposite edges into each other so the file tiles without a seam.
 *
 * The classic offset-and-blend: draw the picture, then draw a copy shifted by a full width
 * (and again by a full height, and both) under a gradient alpha that runs from 0 in the
 * middle to 1 at the border. What lands at the left border is therefore a blend of the
 * left edge and the right edge, which is exactly what makes them meet.
 *
 * Returns null with no DOM (the node unit environment) rather than throwing, matching the
 * degradation the matcap and shader-field paths in materials.ts already use.
 */
export function seamlessCanvas(
  src: CanvasImageSource, w: number, h: number, width: number,
): HTMLCanvasElement | null {
  if (!hasDOM || !src || !(w > 0) || !(h > 0) || !(width > 0)) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, w, h)

  const bx = Math.max(1, Math.round(w * width))
  const by = Math.max(1, Math.round(h * width))

  // Horizontal: the copy shifted one full width left brings the RIGHT edge to the left
  // border, faded in over `bx` pixels. The mirrored shift does the other border.
  const band = (
    dx: number, dy: number, grad: CanvasGradient,
  ) => {
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    const mask = document.createElement('canvas')
    mask.width = w
    mask.height = h
    const mc = mask.getContext('2d')
    if (!mc) { ctx.restore(); return }
    mc.drawImage(src, dx, dy, w, h)
    mc.globalCompositeOperation = 'destination-in'
    mc.fillStyle = grad
    mc.fillRect(0, 0, w, h)
    ctx.drawImage(mask, 0, 0)
    ctx.restore()
  }

  const left = ctx.createLinearGradient(0, 0, bx, 0)
  left.addColorStop(0, 'rgba(0,0,0,1)')
  left.addColorStop(1, 'rgba(0,0,0,0)')
  const right = ctx.createLinearGradient(w, 0, w - bx, 0)
  right.addColorStop(0, 'rgba(0,0,0,1)')
  right.addColorStop(1, 'rgba(0,0,0,0)')
  const top = ctx.createLinearGradient(0, 0, 0, by)
  top.addColorStop(0, 'rgba(0,0,0,1)')
  top.addColorStop(1, 'rgba(0,0,0,0)')
  const bottom = ctx.createLinearGradient(0, h, 0, h - by)
  bottom.addColorStop(0, 'rgba(0,0,0,1)')
  bottom.addColorStop(1, 'rgba(0,0,0,0)')

  band(-w, 0, left)
  band(w, 0, right)
  band(0, -h, top)
  band(0, h, bottom)
  return c
}
```

Add `MATERIAL_DEFAULTS` to the module's existing `./config` import if it is not already there (it is — `imageTilingXY` uses it).

- [x] **Step 4: Call it once the file has decoded**

Add the import to `materials.ts` first — the module already imports `applyImageTransform` from this file:

```ts
import { applyImageTransform, seamlessWidth, seamlessCanvas, type NaturalSize } from './imageMap'
```

In `materials.ts`, inside `ownedImageTexture`'s `onLoad`, before the `applyImageTransform` call:

```ts
      // Seamless pre-pass: repaint the decoded picture into a canvas whose opposite edges
      // have been cross-faded, then point the SAME Texture at it. Done here rather than at
      // build time because it needs the decoded pixels, and only when the dial is non-zero
      // so an untouched picture keeps its own bytes and its own memory footprint.
      const width = seamlessWidth(spec ?? mat)
      if (width > 0 && src?.width && src?.height) {
        const blended = seamlessCanvas(loaded.image as CanvasImageSource, src.width, src.height, width)
        if (blended) { loaded.image = blended; loaded.needsUpdate = true }
      }
```

`spec` is already read from `m.userData.imageSpec` a few lines below in Task 3's version — move that read ABOVE this block so the pre-pass uses the live dial. `mat` is not in scope inside `ownedImageTexture`; pass nothing and read only `spec`, guarding for its absence:

```ts
      const spec = m.userData.imageSpec as SceneMaterial | undefined
      const width = spec ? seamlessWidth(spec) : 0
```

A change to the Seamless dial after the file has loaded needs a re-run of the pre-pass, and the simplest correct way to get one is a rebuild — so add it to the identity key:

```ts
    case 'image': {
      const box = (mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection) === 'box' ? 1 : 0
      // Seamless changes the PIXELS, not a uniform, so it rebuilds — it is a discrete
      // decision the user makes once, not a value they scrub, so the occasional reload is
      // the right trade (the same reasoning relief.invert follows).
      const seam = seamlessWidth(mat)
      return `image:${mat.image ?? ''}:${mat.unlit === true ? 1 : 0}:${box}:${seam}`
    }
```

- [x] **Step 5: Declare the control**

In `controls.ts`, after `imageWrap`:

```ts
  slider('object.material.imageSeamless', 'Seamless edges', 0, 0.45, 0.01, 'Material', MATERIAL_DEFAULTS.imageSeamless,
    'Blends the picture opposite edges into each other so it tiles with no visible join', {
      when: isImageMaterial,
    }),
```

Place it in `SUB_CARDS['Material/Image placement']` as the last entry, and extend the Task 4 parity expectation accordingly.

- [x] **Step 6: Run the tests and verify live**

Run: `cd frontend && npx vitest run tests/unit/scene3d-`
Expected: PASS.

Live: put a photograph on a box, set Edges to Tile and Tiling to 3 — the seams are obvious. Raise Seamless to about 0.15 and confirm they disappear without the picture being mirrored. Confirm that scrubbing Seamless reloads the picture (a brief flicker is expected and correct — it is a rebuild).

- [x] **Step 7: Commit**

```bash
git add frontend/app/lib/scene3d/imageMap.ts frontend/app/lib/scene3d/materials.ts \
  frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/
git commit -m "feat(scene3d): seamless edge blend for image materials"
```

---

### Task 13: Generate a texture from a prompt

The studio already generates a reference image for its image-to-3D flow (`/api/scene3d/gen-image`), but that prompt shaper asks for a single clean object on a plain background — the opposite of a surface texture. This task adds a sibling route with a texture-shaped prompt, and a button in the Texture block that lands the result in the ComfyUI input directory and assigns it.

**Files:**
- Modify: `frontend/server/utils/scene3dGen.ts` (a second prompt shaper)
- Create: `frontend/server/api/scene3d/gen-texture.post.ts`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (the `#control-ui.material.image` slot)
- Test: `frontend/tests/unit/scene3d-gen.unit.spec.ts`

**Interfaces:**
- Consumes: `runFal`, `firstFalImageUrl` (auto-imported from `server/utils/falRun.ts`), `assertRateLimit` from `../../lib/rateLimit`, and the existing `/api/image-fetch` route, which downloads a URL into the ComfyUI input directory and returns `{ name }`.
- Produces: `shapeTexturePrompt(prompt: string): string` in `server/utils/scene3dGen.ts`; the route `POST /api/scene3d/gen-texture` returning `{ imageUrl, seed }`.

- [x] **Step 1: Write the failing test**

Add to `frontend/tests/unit/scene3d-gen.unit.spec.ts`:

```ts
import { shapeTexturePrompt } from '~~/server/utils/scene3dGen'

describe('shapeTexturePrompt', () => {
  it('asks for a flat, evenly lit, tileable surface', () => {
    const p = shapeTexturePrompt('brushed copper')
    expect(p).toContain('brushed copper')
    expect(p.toLowerCase()).toContain('seamless')
    expect(p.toLowerCase()).toContain('flat')
  })

  it('returns an empty string for an empty ask, like its sibling', () => {
    expect(shapeTexturePrompt('   ')).toBe('')
  })

  it('does not reuse the single-object shaping', () => {
    expect(shapeTexturePrompt('wood')).not.toBe(shapeImagePrompt('wood'))
  })
})
```

Add `shapeImagePrompt` to the file's existing import from `~~/server/utils/scene3dGen` if it is not already there.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-gen.unit.spec.ts`
Expected: FAIL — `shapeTexturePrompt` is not exported.

- [x] **Step 3: Write the prompt shaper**

In `frontend/server/utils/scene3dGen.ts`, next to `shapeImagePrompt`:

```ts
/** The opposite shaping to shapeImagePrompt: not one object on a plain ground, but a flat
 *  swatch of SURFACE that can be tiled across a mesh. Straight-on, evenly lit and edge-to-
 *  edge, because anything with perspective, a vignette or a directional highlight bakes a
 *  fake light direction into the material. */
const TEXTURE_PROMPT_SUFFIX =
  ', seamless tileable surface texture, flat straight-on view, even diffuse lighting,'
  + ' no shadows, no vignette, no perspective, no objects, fills the entire frame edge to edge'

export function shapeTexturePrompt(prompt: string): string {
  const p = prompt.trim()
  return p ? `${p}${TEXTURE_PROMPT_SUFFIX}` : ''
}
```

- [x] **Step 4: Write the route**

Create `frontend/server/api/scene3d/gen-texture.post.ts`:

```ts
// POST /api/scene3d/gen-texture — text → a flat, tileable surface swatch via fal FLUX, for
// the 3D Studio's image material. Sibling of gen-image.post.ts, which shapes its prompt the
// other way (one clean object on a plain ground, as a reference for image-to-3D).
//
// Returns a public fal CDN URL. The CLIENT then posts that url to /api/image-fetch, which
// downloads it into ComfyUI's input directory and hands back the filename `material.image`
// needs — a generated texture must live in the input directory like an uploaded one, or it
// vanishes the moment the CDN link expires.
//
// runFal / firstFalImageUrl / shapeTexturePrompt are auto-imported by Nitro from server/utils.
import { assertRateLimit } from '../../lib/rateLimit'

interface Body {
  prompt?: string
  seed?: number
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-gen-texture', 30)
  const body = await readBody<Body>(event)
  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt is required' })
  const seed = Number.isFinite(body?.seed) ? Math.round(body!.seed as number) : Math.floor(Date.now() % 2_000_000_000)

  const result = await runFal('fal-ai/flux/dev', {
    prompt: shapeTexturePrompt(prompt),
    image_size: 'square_hd',
    num_images: 1,
    seed,
  })
  const imageUrl = firstFalImageUrl(result)
  if (!imageUrl) throw createError({ statusCode: 502, message: 'fal returned no image' })
  return { imageUrl, seed }
})
```

`server/lib/nitroApiPaths.ts` already allowlists the `/api/scene3d` prefix, so no entry is needed — but open that file and confirm the prefix is matched by prefix and not by exact path before moving on.

- [x] **Step 5: Add the button**

In `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, add the state next to the existing `texUploading` / `texUploadError` refs:

```ts
// Texture generation: prompt → fal → the ComfyUI input directory → material.image. Scoped
// to the object it was started FOR, exactly like the upload above — reselecting mid-request
// must not land the texture on the newly selected object.
const texGenPrompt = ref('')
const texGenerating = ref<string | null>(null)
const texGenError = reactive<Record<string, boolean>>({})

async function generateTexture() {
  const target = selected.value
  const prompt = texGenPrompt.value.trim()
  if (!prompt || !target || target.kind === 'light' || texGenerating.value) return
  texGenerating.value = target.id
  delete texGenError[target.id]
  try {
    const gen = await $fetch('/api/scene3d/gen-texture', { method: 'POST', body: { prompt } })
    // The fal URL is public but temporary; /api/image-fetch copies the bytes into ComfyUI's
    // input directory and returns the stored filename, which is what the material holds.
    const stored = await $fetch('/api/image-fetch', { method: 'POST', body: { url: gen.imageUrl } })
    const filename = stored?.name
    if (!filename) throw new Error('no filename')
    delete texLoadError[filename]
    target.material.image = filename
  } catch (err) {
    console.error('[scene3d-studio] gen-texture failed', err)
    texGenError[target.id] = true
  } finally {
    if (texGenerating.value === target.id) texGenerating.value = null
  }
}
```

Extend the `#control-ui.material.image` slot, below the existing upload row:

```vue
              <div class="space-y-1.5">
                <input
                  v-model="texGenPrompt"
                  type="text"
                  placeholder="Describe a surface, such as brushed copper"
                  class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 outline-none placeholder:text-white/30 focus:border-white/25"
                  @keydown.enter.prevent="generateTexture"
                />
                <StudioButton :disabled="!texGenPrompt.trim() || texGenerating === selected.id" @click="generateTexture">
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="texGenerating === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Sparkles v-else class="h-3.5 w-3.5" />
                    {{ texGenerating === selected.id ? 'Generating…' : 'Generate a texture' }}
                  </span>
                </StudioButton>
                <p v-if="texGenError[selected.id]" class="text-[11px] text-red-400/90">Texture generation failed — try again.</p>
              </div>
```

Add `Sparkles` to the existing `lucide-vue-next` import if it is not already there. Use `StudioButton` — never hand-roll a button on this surface.

- [x] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/scene3d-gen.unit.spec.ts && npx nuxt typecheck`
Expected: PASS, and no new typecheck errors.

- [x] **Step 7: Verify live**

This step spends money — one fal FLUX generation. Confirm with the user before running it, then: select an object, set its material to Image, type "brushed copper" and press Generate a texture. Confirm a texture appears on the object, that the thumbnail shows it, and that reloading the document still shows it (which proves it landed in the input directory rather than being held as a CDN link).

- [x] **Step 8: Commit**

```bash
git add frontend/server/utils/scene3dGen.ts frontend/server/api/scene3d/gen-texture.post.ts \
  frontend/app/components/vue-canvas/Scene3DStudioSurface.vue frontend/tests/unit/scene3d-gen.unit.spec.ts
git commit -m "feat(scene3d): generate a surface texture from a prompt"
```

---

### Task 14: Close-out

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (doc comment only)
- Modify: `docs/superpowers/plans/2026-09-05-scene3d-image-material-options.md` (tick every box)

- [x] **Step 1: Run the whole unit suite, not just the scene3d slice**

Run: `cd frontend && npm run test:unit`
Expected: PASS. Vitest counts can be unreliable under parallel load — if something fails, re-run that single file before believing it.

- [x] **Step 2: Typecheck**

Run: `cd frontend && npx nuxt typecheck`
Expected: no new errors against the baseline.

- [x] **Step 3: Write the map of the feature**

Add a doc comment above `case 'image':` in `materialFor` summarising where each option lives, so the next reader does not have to reconstruct it:

```ts
    // The uploaded-picture material. Its options live in four places, deliberately:
    //   • Texture properties (wrap, tiling, fit, offset, rotation, flip) — imageMap.ts,
    //     applied to the Texture THIS material owns. Free at draw time.
    //   • Material properties (tint, transparency, cutout, opacity, glow, flat) — here and
    //     in updateMaterial's `case 'image':`, via applyImageTransparency/applyImageGlow.
    //   • Uniforms (brightness, contrast, saturation, projection) — imageShader.ts,
    //     injected unconditionally with identity defaults so no dial recompiles.
    //   • Pixels (seamless) — imageMap.ts's seamlessCanvas, run once on decode.
    // Only THREE things rebuild: the file, `unlit` (Basic vs Standard class), 'box'
    // projection (a three-sample program) and `seamless` (different pixels). Everything
    // else updates in place, which is what keeps a slider drag from stalling.
```

- [ ] **Step 4: Verify the whole feature in one pass**

With both servers running, build one object that exercises every option: an image material on a torus knot, Wrapping set to Box, Tiling 3, Seamless 0.15, a warm Tint, Saturation down, Glow up, and Use image transparency on with a PNG that has a cut-out. Confirm no console errors, no shader-compile warnings, and that dragging each slider is smooth (a stall means something crossed a program boundary it should not have — check `identityKey`).

- [x] **Step 5: Commit**

```bash
git add frontend/app/lib/scene3d/materials.ts docs/superpowers/plans/2026-09-05-scene3d-image-material-options.md
git commit -m "docs(scene3d): image material option map and plan close-out"
```

---

## Notes for the implementer

**What deliberately did NOT go in.** Two things came up while scoping and were left out on purpose, so nobody re-derives them:

- **A per-map roughness or metalness image.** The image material takes scalars for both. Binding the picture as a roughness map is a different feature (a PBR set), and the studio already has one — the ambientCG texture-set picker on the standard/glass/opalescent types.
- **Frame-anchored projection.** Every projection here is object-anchored, matching the constraint `shaderFill` already states in `SceneMaterial.shader`'s doc: a frame anchor needs screen-space injection, which is its own piece of work.

**The one performance ceiling worth knowing.** Per-material texture ownership (Task 3) means N objects on the same picture decode it N times and hold N GPU copies. The bytes are deduped by the browser's HTTP cache; the VRAM is not. `bindTextureMaps` carries the same trade with a written-out remedy — a cache keyed by (file, transform) rather than by file — and if the image material ever hits that ceiling, the same remedy applies for the same reasons. It is a swap of `ownedImageTexture`'s body, not a redesign.
