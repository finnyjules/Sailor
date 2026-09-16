# AI restyle driven by a Style (moodboard) — depth + style · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax; each task is authored to the TDD loop (write the failing test, watch it fail, minimal impl, watch it pass, then the controller commits by hunk).

**Goal:** Let a 3D-object AI restyle be steered by one of the user's saved Styles (a *moodboard*: name + reference images + curated palette + prose read) as an OPTIONAL layer on top of today's prompt+depth restyle — attach one and the object is restyled in that look while keeping its geometry; attach none and it behaves exactly as today (byte-identical).

**Architecture:** The only new axis is the route's model + inputs. The doc gains ONE pointer field (`AiRestyleTreatment.styleId`), resolved at run time (pixels/data never enter the doc). When a Style with reference images is attached, the route dispatches `fal-ai/flux-general` (confirmed to accept a depth ControlNet + IP-adapter refs in one call); otherwise the existing depth-only model, unchanged. The S7.1 projection pipeline (`renderObjectPasses` bake → `resultRef`/`inputHash` cache → `restyleProjection.ts` material → `mix` blend → `__scene3dRestyleInject`) is UNTOUCHED — a moodboard only changes *what image the route requests*.

"Style" = **moodboard** (`MoodboardEntry`), NOT the trained Style-LoRAs. Those are out of scope.

**Tech Stack:** Nuxt 3 / Nitro (server routes, auto-imported `runFal`/`firstFalImageUrl`), Vue 3 `<script setup>`, three.js (untouched here), Vitest (unit), Playwright + SwiftShader WebGL (live, zero-spend), fal (`fal-ai/flux-general`). Pure builder/cache/data modules stay three-free and Vue-free.

```
runRestyle (Scene3DStudioSurface.vue)
  ├─ renderObjectPasses → { beauty, depth, viewProj, rect, size, forward }   (UNCHANGED)
  ├─ styleId set? → useMoodboards().byId → /api/moodboards/images → ≤3 data-URL refs + moodboardStyleBlock(reading)
  ├─ restyleInputHash(…, styleId, styleSig)  ── shouldRunRestyle short-circuit (UNCHANGED shape)
  └─ POST /api/scene3d/restyle { …, styleRefs[], styleText }
        └─ pickRestyleModel(requested, hasStyleRefs)  → flux-general when refs present, else today's model
        └─ restyleInput(model, …, styleRefs, styleText)  → controlnets[] + ip_adapters[] | today's depth/image payload
        └─ runFal (owns ALL metering; refuses an unpriced slug)   (UNCHANGED)
  → /api/image-fetch → cache texture under resultRef → stamp projector → project  (UNCHANGED)
```

## Global Constraints

- **Attribution (verbatim from spec):** commits sign `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **No-Style byte-identity (verbatim from spec):** `styleId === ''` (or an unresolvable id, or no refs) ⇒ the route uses the depth-only model and the exact today's payload ⇒ no behavior change; a scene with no restyle is byte-identical as before. The S7.1 projection path is identical regardless of Style.
- **Pixels never enter the doc:** `styleId` is a POINTER only; the moodboard's images/palette/prose resolve at run time via `useMoodboards().byId`. Only the small `styleId` string lives in the doc.
- **Subagents don't commit.** The controller commits by hunk via a private `GIT_INDEX_FILE`. Report each task's diff; do not run `git add`/`git commit`.
- **NEVER `npm run dev`.** It kills the shared `:3002`/ComfyUI. Unit tests run headless (`npx vitest run …`); Playwright runs against a fresh preview on the isolated preview port, driven by the controller — not the authoring subagent.
- **No fal / model call from the authoring subagent.** The paid acceptance run (Task 5) is env-gated (`SCENE3D_RESTYLE_LIVE=1`) and gated on the user's explicit go. CI never spends — the composite/projection is proven via `__scene3dRestyleInject` with a LOCAL image.
- **MODEL_COSTS row required per fal slug or runFal refuses.** Every id in `RESTYLE_MODELS` (now including `fal-ai/flux-general`) MUST have a `MODEL_COSTS` row; the allowlist↔pricing unit ties them.
- **fal enum/field strings pinned in the builder unit** (`fal-enum-mismatch-silent-fallover`): every enum/field string in the depth+style payload (`image_size`, `output_format`, the controlnet / ip-adapter `path`/`weight_name`/`image_encoder_path`) is pinned against its exact value in `scene3d-restyle-inputs.unit.spec.ts`.
- **GLSL float literals:** this slice adds NO shader code (the projection material is unchanged), so there are no new GLSL literals; if any are added, emit them as floats (`1.0`, not `1`).
- **Byte-scan new files for real NULs** (`grep $'\x00'` false-negatives in zsh — use perl): `perl -ne 'print "NUL at $.\n" if /\x00/' <file>` on any newly created file. `restyleCache.ts`'s `SEP` must stay the two-source-byte `\0` ESCAPE, never a raw NUL.
- **CI never spends:** the styled-path model-swap + payload logic is unit-tested with mocked `$fetch`; `runFal` is never reached.

**Base commit:** `764277540` (verify `git rev-parse HEAD` at start).

## File Structure

**Modified (source)**
- `frontend/app/data/scene3d-restyle-models.ts` — add the `fal-ai/flux-general` depth+style entry (`control: 'depth+style'`, `selectable: false`); widen `RestyleModel.control`; add `pickRestyleModel`.
- `frontend/server/utils/priceBook.ts` — add a `MODEL_COSTS` row for `fal-ai/flux-general`.
- `frontend/server/utils/restyleFalInputs.ts` — add the depth+style builder path + pinned fal repo/enum constants; fold `styleText` into the prompt for every path.
- `frontend/app/lib/scene3d/treatments.ts` — `AiRestyleTreatment.styleId`, its default `''`, and parse.
- `frontend/app/lib/scene3d/restyleCache.ts` — `restyleInputHash` folds `styleId` + `styleSig`; add `restyleStyleSig`.
- `frontend/server/api/scene3d/restyle.post.ts` — accept `styleRefs?`/`styleText?`; dispatch via `pickRestyleModel`; pass through to the builder.
- `frontend/app/lib/scene3d/treatmentControls.ts` — the `model` select lists only `selectable` models.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — resolve the moodboard in `runRestyle` + pass `styleRefs`/`styleText` + fold into the hash; the "Style" picker row (reuse `WidgetMoodboardChip` + a compact studio-native moodboard popover) storing/showing/clearing `styleId`.

**Modified (tests)**
- `frontend/tests/unit/scene3d-restyle-models.unit.spec.ts` — the three-entry allowlist + `pickRestyleModel`.
- `frontend/tests/unit/scene3d-restyle-inputs.unit.spec.ts` — the depth+style payload + pinned strings.
- `frontend/tests/unit/scene3d-restyle-cache.unit.spec.ts` — `styleId`/`styleSig` fold + `restyleStyleSig`.
- `frontend/tests/unit/scene3d-treatments.unit.spec.ts` — `styleId` parse round-trip + default.
- `frontend/tests/unit/scene3d-treatment-controls.unit.spec.ts` — the `model` select excludes flux-general.
- `frontend/tests/scene3d-restyle.spec.ts` — a styled doc still projects + orbits (zero-spend inject); the env-gated paid run gains a real-moodboard variant.

**No files created** (the picker popover lives inline in the surface, matching the existing `anchorAbove` popover pattern already used there).

---

## Task 1 · Confirm + wire the depth+style fal model (retires the residual risk)

Confirm the exact fal `flux-general` controlnet/ip-adapter repo paths, add the model to the allowlist + price book + builder, and pin every enum/field string in the unit. This is the ONLY task that touches the fal contract; everything after it is plumbing.

**Files**
- `frontend/app/data/scene3d-restyle-models.ts` — `RestyleModel` (lines 14–19), `RESTYLE_MODELS` (lines 21–24). Add the depth+style entry + `pickRestyleModel`.
- `frontend/server/utils/restyleFalInputs.ts` — `restyleInput` (lines 38–69), `restyleGuidanceScale` (lines 34–36). Add the depth+style branch + pinned constants + prompt fold.
- `frontend/server/utils/priceBook.ts` — `MODEL_COSTS` (line 405; restyle rows at 430–431).
- Tests: `scene3d-restyle-models.unit.spec.ts`, `scene3d-restyle-inputs.unit.spec.ts`.

**Interfaces**
- Produces `RestyleModel { id; label; control: 'depth' | 'image' | 'depth+style'; provider: 'fal'; selectable?: boolean }`.
- Produces `pickRestyleModel(requestedId: string | undefined, hasStyleRefs: boolean): RestyleModel`.
- Produces `restyleInput(m, prompt, beauty, depth, strength, seed, styleRefs?: string[], styleText?: string): FalCall` — depth+style branch emits `{ controlnets:[{path,control_image_url,conditioning_scale}], ip_adapters:[{path,image_url,scale,image_encoder_path,weight_name}], prompt, image_size, num_inference_steps, num_images, output_format, seed }`.

**Steps**

- [ ] **Step 1 — confirm the residual fal strings FIRST.** Verify against fal's `flux-general` docs (the controller has WebFetch; the authoring subagent makes no network calls) the exact values: the FLUX **depth ControlNet** repo for `controlnets[].path`, the FLUX **IP-adapter** repo for `ip_adapters[].path` + its `image_encoder_path` + `weight_name`, and that our already-computed depth crop is passed directly (no fal-side preprocess). The constants below are the plan's best-known candidates; if confirmation changes any, change the constant AND the pinned unit together (one edit).

- [ ] **Step 2 — failing test (allowlist + pricing tie).** Rewrite `scene3d-restyle-models.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RESTYLE_MODELS, pickRestyleModel } from '~/data/scene3d-restyle-models'
import { MODEL_COSTS } from '../../server/utils/priceBook'

describe('RESTYLE_MODELS ↔ MODEL_COSTS (allowlist / pricing tie)', () => {
  it('holds the two selectable models plus the route-internal depth+style model', () => {
    expect(RESTYLE_MODELS.map((m) => m.id)).toEqual([
      'fal-ai/flux-control-lora-depth',
      'fal-ai/flux/dev/image-to-image',
      'fal-ai/flux-general',
    ])
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux-control-lora-depth')!.control).toBe('depth')
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux/dev/image-to-image')!.control).toBe('image')
    const styled = RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux-general')!
    expect(styled.control).toBe('depth+style')
    expect(styled.selectable).toBe(false) // route-internal — never on the user model dropdown
    for (const m of RESTYLE_MODELS) expect(m.provider).toBe('fal')
  })

  it('every RESTYLE_MODELS id has a MODEL_COSTS row with positive credits (else runFal refuses)', () => {
    for (const m of RESTYLE_MODELS) {
      const row = MODEL_COSTS[m.id]
      expect(row, m.id).toBeTruthy()
      expect(row!.credits, m.id).toBeGreaterThan(0)
      expect(row!.usd, m.id).toBeGreaterThan(0)
    }
  })

  it('pickRestyleModel routes to depth+style ONLY when refs are present', () => {
    const depth = RESTYLE_MODELS.find((m) => m.control === 'depth')!
    const styled = RESTYLE_MODELS.find((m) => m.control === 'depth+style')!
    expect(pickRestyleModel('fal-ai/flux-control-lora-depth', true)).toBe(styled)
    expect(pickRestyleModel('fal-ai/flux-control-lora-depth', false)).toBe(depth)
    // A caller must never be able to pick the internal model directly (it's not selectable).
    expect(pickRestyleModel('fal-ai/flux-general', false)).toBe(depth)
    // Unknown / missing id falls back to the first entry.
    expect(pickRestyleModel(undefined, false)).toBe(RESTYLE_MODELS[0])
  })
})
```

- [ ] **Step 3 — run it, expect FAIL.** `npx vitest run tests/unit/scene3d-restyle-models.unit.spec.ts`

- [ ] **Step 4 — minimal impl (`scene3d-restyle-models.ts`).**

```ts
export interface RestyleModel {
  id: string
  label: string
  control: 'depth' | 'image' | 'depth+style'
  provider: 'fal'
  /** Shown on the inspector's Model dropdown. The depth+style model is route-internal (the route
   *  swaps to it when a Style with refs is attached), never a user pick — so `false`. Absent ⇒ true. */
  selectable?: boolean
}

export const RESTYLE_MODELS: RestyleModel[] = [
  { id: 'fal-ai/flux-control-lora-depth', label: 'Depth control (Flux)', control: 'depth', provider: 'fal' },
  { id: 'fal-ai/flux/dev/image-to-image', label: 'Image to image (Flux)', control: 'image', provider: 'fal' },
  // Route-internal: chosen by pickRestyleModel when a moodboard with reference images is attached.
  // Accepts a depth ControlNet + IP-adapter refs in one call (spec 2026-09-16, Approach A).
  { id: 'fal-ai/flux-general', label: 'Depth + Style (Flux)', control: 'depth+style', provider: 'fal', selectable: false },
]

/** Which model the route dispatches. A Style with reference images ⇒ the depth+style model; otherwise
 *  the requested selectable model (default the first). The internal depth+style model can never be
 *  chosen by `requestedId` — it is `selectable: false` and only reachable via `hasStyleRefs`. */
export function pickRestyleModel(requestedId: string | undefined, hasStyleRefs: boolean): RestyleModel {
  if (hasStyleRefs) {
    const styled = RESTYLE_MODELS.find((m) => m.control === 'depth+style')
    if (styled) return styled
  }
  return RESTYLE_MODELS.find((m) => m.id === requestedId && m.selectable !== false) ?? RESTYLE_MODELS[0]!
}
```

- [ ] **Step 5 — run it, expect PASS.** Controller commits.

- [ ] **Step 6 — failing test (depth+style payload + pinned strings).** Add to `scene3d-restyle-inputs.unit.spec.ts` (keep the existing depth/image cases — they must still pass unchanged, since `styleText` defaults `''` ⇒ no prompt fold):

```ts
import {
  restyleInput, restyleGuidanceScale,
  FLUX_DEPTH_CONTROLNET_PATH, FLUX_IP_ADAPTER_PATH, FLUX_IP_ADAPTER_ENCODER, FLUX_IP_ADAPTER_WEIGHT,
  RESTYLE_DEPTH_CONDITIONING_SCALE, RESTYLE_IP_ADAPTER_SCALE,
} from '../../server/utils/restyleFalInputs'

const STYLE_MODEL = RESTYLE_MODELS.find((m) => m.control === 'depth+style')!
const REF_A = 'data:image/png;base64,REFA'
const REF_B = 'data:image/png;base64,REFB'

describe('restyleInput — depth+style (fal-ai/flux-general)', () => {
  it('emits controlnets[depth] + one ip_adapter per ref + the prompt with styleText folded in', () => {
    const call = restyleInput(STYLE_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 42, [REF_A, REF_B], 'In the style of: warm.')
    expect(call).toEqual({
      app: 'fal-ai/flux-general',
      input: {
        prompt: 'a bronze statue. In the style of: warm.',
        controlnets: [{
          path: FLUX_DEPTH_CONTROLNET_PATH,
          control_image_url: DEPTH, // our crop is already a depth map — passed directly, no preprocess
          conditioning_scale: RESTYLE_DEPTH_CONDITIONING_SCALE,
        }],
        ip_adapters: [
          { path: FLUX_IP_ADAPTER_PATH, image_url: REF_A, scale: RESTYLE_IP_ADAPTER_SCALE, image_encoder_path: FLUX_IP_ADAPTER_ENCODER, weight_name: FLUX_IP_ADAPTER_WEIGHT },
          { path: FLUX_IP_ADAPTER_PATH, image_url: REF_B, scale: RESTYLE_IP_ADAPTER_SCALE, image_encoder_path: FLUX_IP_ADAPTER_ENCODER, weight_name: FLUX_IP_ADAPTER_WEIGHT },
        ],
        image_size: 'square_hd',
        num_inference_steps: 28,
        num_images: 1,
        output_format: 'png',
        seed: 42,
      },
    })
  })

  it('caps ip_adapters at MOODBOARD_MAX_REFS (3)', () => {
    const refs = ['a', 'b', 'c', 'd', 'e'].map((x) => `data:image/png;base64,${x}`)
    const call = restyleInput(STYLE_MODEL, 'p', BEAUTY, DEPTH, 0.6, 1, refs, '')
    expect(call.input.ip_adapters).toHaveLength(3)
  })

  it('pins the exact fal enum/repo strings (fal-enum-mismatch-silent-fallover guard)', () => {
    const call = restyleInput(STYLE_MODEL, 'p', BEAUTY, DEPTH, 0.6, 1, [REF_A], '')
    expect(call.input.image_size).toBe('square_hd')
    expect(call.input.output_format).toBe('png')
    expect(call.input.num_inference_steps).toBe(28)
    expect(FLUX_DEPTH_CONTROLNET_PATH).toBe('XLabs-AI/flux-controlnet-depth-v3')
    expect(FLUX_IP_ADAPTER_PATH).toBe('XLabs-AI/flux-ip-adapter')
    expect(FLUX_IP_ADAPTER_ENCODER).toBe('openai/clip-vit-large-patch14')
    expect(FLUX_IP_ADAPTER_WEIGHT).toBe('ip_adapter.safetensors')
  })

  it('styleText folds into the prompt for the depth path too (empty-board text-only nudge)', () => {
    const call = restyleInput(DEPTH_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 1, [], 'In the style of: warm.')
    expect(call.input.prompt).toBe('a bronze statue. In the style of: warm.')
    expect(call.input).not.toHaveProperty('ip_adapters') // no refs ⇒ still the depth-only payload
  })
})
```

- [ ] **Step 7 — run it, expect FAIL.**

- [ ] **Step 8 — minimal impl (`restyleFalInputs.ts`).**

```ts
import type { RestyleModel } from '~~/app/data/scene3d-restyle-models'
import type { FalCall } from './inpaintFalInputs'
import { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
const round2 = (n: number): number => Math.round(n * 100) / 100

// ── fal-ai/flux-general depth+style repos (spec 2026-09-16 residual). CONFIRM IN TASK 1 against fal's
// flux-general docs before the paid run; a wrong repo passes at submit and fails at result (the S7
// `control_lora_image_url` lesson), so the Task-5 paid run is the concrete end-to-end validator.
export const FLUX_DEPTH_CONTROLNET_PATH = 'XLabs-AI/flux-controlnet-depth-v3'
export const FLUX_IP_ADAPTER_PATH = 'XLabs-AI/flux-ip-adapter'
export const FLUX_IP_ADAPTER_ENCODER = 'openai/clip-vit-large-patch14'
export const FLUX_IP_ADAPTER_WEIGHT = 'ip_adapter.safetensors'
// Tuned defaults (no user dial — spec YAGNI). Depth control holds structure; IP-adapter carries look.
export const RESTYLE_DEPTH_CONDITIONING_SCALE = 0.6
export const RESTYLE_IP_ADAPTER_SCALE = 0.7

export function restyleGuidanceScale(strength: number): number {
  return round2(3.5 + clamp01(strength) * 6.5)
}

/** Fold the moodboard's palette+prose block into the prompt. Empty/whitespace styleText ⇒ the prompt
 *  is returned verbatim, so the no-Style payload is byte-identical to today. */
function foldStylePrompt(prompt: string, styleText: string): string {
  const s = styleText.trim()
  return s ? `${prompt}. ${s}` : prompt
}

export function restyleInput(
  m: RestyleModel, prompt: string, beauty: string, depth: string, strength: number, seed: number,
  styleRefs: string[] = [], styleText = '',
): FalCall {
  const s = clamp01(strength)
  const finalPrompt = foldStylePrompt(prompt, styleText)
  if (m.control === 'depth+style') {
    return {
      app: m.id,
      input: {
        prompt: finalPrompt,
        // Our depth crop is ALREADY a depth map → passed directly as the control image (no fal preprocess).
        controlnets: [{
          path: FLUX_DEPTH_CONTROLNET_PATH,
          control_image_url: depth,
          conditioning_scale: RESTYLE_DEPTH_CONDITIONING_SCALE,
        }],
        ip_adapters: styleRefs.slice(0, MOODBOARD_MAX_REFS).map((url) => ({
          path: FLUX_IP_ADAPTER_PATH,
          image_url: url,
          scale: RESTYLE_IP_ADAPTER_SCALE,
          image_encoder_path: FLUX_IP_ADAPTER_ENCODER,
          weight_name: FLUX_IP_ADAPTER_WEIGHT,
        })),
        image_size: 'square_hd',
        num_inference_steps: 28,
        num_images: 1,
        output_format: 'png',
        seed,
      },
    }
  }
  if (m.control === 'depth') {
    return {
      app: m.id,
      input: {
        prompt: finalPrompt,
        control_lora_image_url: depth,
        image_size: 'square_hd',
        strength: s,
        guidance_scale: restyleGuidanceScale(s),
        num_images: 1,
        output_format: 'png',
        seed,
      },
    }
  }
  return {
    app: m.id,
    input: {
      prompt: finalPrompt,
      image_url: beauty,
      strength: s,
      image_size: 'square_hd',
      num_images: 1,
      output_format: 'png',
      seed,
    },
  }
}
```

- [ ] **Step 9 — run it, expect PASS** (the pre-existing depth/image cases pass unchanged: `styleText=''` ⇒ `finalPrompt === prompt`). Controller commits.

- [ ] **Step 10 — add the MODEL_COSTS row** (the tie test from Step 2 already covers it). After line 431 in `priceBook.ts`:

```ts
  'fal-ai/flux-general': { usd: 0.05, credits: 10, confidence: 'estimate', note: 'FLUX general (depth ControlNet + IP-adapter, one call) — assumed ~$0.05/MP for the heavier graph; re-verify against a live invoice (restyle-style Task 5)' },
```

- [ ] **Step 11 — run the models unit again, expect PASS.** Controller commits.

---

## Task 2 · Data model, cache, and route wiring (byte-identity when no Style)

`styleId` on the treatment (+ parse/default), `restyleInputHash` folds `styleId`+`styleSig`, the route accepts `styleRefs`/`styleText` and dispatches via `pickRestyleModel`, and `runRestyle` resolves the moodboard (with graceful fallback for deleted/empty).

**Files**
- `frontend/app/lib/scene3d/treatments.ts` — `AiRestyleTreatment` (lines 303–321), `TREATMENT_DEFAULTS.aiRestyle` (line 391), `parseTreatment` case `'aiRestyle'` (lines 646–673).
- `frontend/app/lib/scene3d/restyleCache.ts` — `restyleInputHash` (lines 39–45), `SEP` (line 31).
- `frontend/server/api/scene3d/restyle.post.ts` — `Body` (25–32), handler (34–64).
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — imports (87–88), `runRestyle` (1991–2060).
- Tests: `scene3d-treatments.unit.spec.ts`, `scene3d-restyle-cache.unit.spec.ts`.

**Interfaces**
- `AiRestyleTreatment` gains `styleId: string` (default `''`).
- `restyleInputHash(m, prompt, strength, beauty, depth, styleId = '', styleSig = ''): string`.
- `restyleStyleSig(folder: string, files: string[], styleText: string): string`.
- Route `Body` gains `styleRefs?: string[]; styleText?: string`.

**Steps**

- [ ] **Step 1 — failing test (`styleId` parse).** Add to `scene3d-treatments.unit.spec.ts` near the aiRestyle cases:

```ts
it('aiRestyle defaults styleId to "" and round-trips a stored id; coerces a non-string to ""', () => {
  expect(createTreatment('aiRestyle')).toMatchObject({ styleId: '' })
  expect(parseTreatment({ id: 'r0', kind: 'aiRestyle' })).toMatchObject({ styleId: '' })
  expect(parseTreatment({ id: 'r1', kind: 'aiRestyle', styleId: 'warm-editorial' })).toMatchObject({ styleId: 'warm-editorial' })
  expect(parseTreatment({ id: 'r2', kind: 'aiRestyle', styleId: 42 })).toMatchObject({ styleId: '' })
})
```

- [ ] **Step 2 — run it, expect FAIL.**

- [ ] **Step 3 — minimal impl (`treatments.ts`).** (1) Add to the interface after `inputHash` (line 310): `styleId: string` with a one-line doc: `/** A MoodboardEntry id; '' = no Style (default). A POINTER only — the board's images/palette/prose resolve at run time (useMoodboards().byId); pixels never enter the doc. */`. (2) In `TREATMENT_DEFAULTS.aiRestyle` (line 391) add `styleId: ''` right after `inputHash: ''`. (3) In the `parseTreatment` `'aiRestyle'` return (lines 660–672), alongside `resultRef`/`inputHash`, add: `styleId: typeof r.styleId === 'string' ? r.styleId : '',`.

- [ ] **Step 4 — run it, expect PASS.** Controller commits.

- [ ] **Step 5 — failing test (cache fold).** Add to `scene3d-restyle-cache.unit.spec.ts`:

```ts
import { restyleInputHash, restyleStyleSig, shouldRunRestyle } from '~/lib/scene3d/restyleCache'

describe('restyleInputHash — Style fold', () => {
  it('no Style (both empty) is stable and equals the 5-arg call', () => {
    const withDefaults = restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH, '', '')
    expect(withDefaults).toBe(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH))
  })
  it('a styleId or a styleSig change yields a new key; both stable ⇒ same key', () => {
    const base = restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH, 'board-a', 'sigA')
    expect(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH, 'board-b', 'sigA')).not.toBe(base) // switch board
    expect(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH, 'board-a', 'sigB')).not.toBe(base) // edited board
    expect(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH, 'board-a', 'sigA')).toBe(base)     // unchanged
  })
})

describe('restyleStyleSig', () => {
  it('is deterministic and changes with folder, files, or styleText', () => {
    const base = restyleStyleSig('moodboard_1', ['00_a.png', '01_b.png'], 'In the style of: warm.')
    expect(restyleStyleSig('moodboard_1', ['00_a.png', '01_b.png'], 'In the style of: warm.')).toBe(base)
    expect(restyleStyleSig('moodboard_2', ['00_a.png', '01_b.png'], 'In the style of: warm.')).not.toBe(base)
    expect(restyleStyleSig('moodboard_1', ['00_a.png'], 'In the style of: warm.')).not.toBe(base)
    expect(restyleStyleSig('moodboard_1', ['00_a.png', '01_b.png'], 'In the style of: cool.')).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{8}$/)
  })
})
```

- [ ] **Step 6 — run it, expect FAIL.**

- [ ] **Step 7 — minimal impl (`restyleCache.ts`).**

```ts
export function restyleInputHash(
  m: RestyleModel, prompt: string, strength: number, beauty: string, depth: string,
  styleId = '', styleSig = '',
): string {
  const s = Math.round((Number.isFinite(strength) ? strength : 0) * 100) / 100
  // 'image' models key on the beauty crop; 'depth' AND 'depth+style' key on the depth crop.
  const control = m.control === 'image' ? beauty : depth
  return fnv1a([m.id, m.control, prompt, String(s), control, styleId, styleSig].join(SEP))
}

/** A fingerprint of the resolved Style reference set — the moodboard's folder + image filenames +
 *  its composed style text. Folded into restyleInputHash so switching the board, or editing its
 *  images / palette / prose, re-bills; an unchanged Style still short-circuits. */
export function restyleStyleSig(folder: string, files: string[], styleText: string): string {
  return fnv1a([folder, ...files, styleText].join(SEP))
}
```

- [ ] **Step 8 — run it, expect PASS** (the existing 5-arg cache tests still pass; the two appended empty fields are deterministic). Controller commits.

- [ ] **Step 9 — route: accept + dispatch** (no Nitro unit; covered by the `pickRestyleModel` unit + the Task-5 route call). Edit `restyle.post.ts`:

```ts
import { assertRateLimit } from '../../lib/rateLimit'
import { pickRestyleModel } from '~~/app/data/scene3d-restyle-models'
import { restyleInput } from '../../utils/restyleFalInputs'
import { MOODBOARD_MAX_REFS } from '../../../shared/taste/moodboard'

interface Body {
  prompt?: string
  beauty?: string
  depth?: string
  strength?: number
  model?: string
  seed?: number
  styleRefs?: string[] // ≤3 moodboard reference images as data-URLs, resolved client-side
  styleText?: string   // moodboardStyleBlock(reading): palette + prose + avoids
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-restyle', 20)
  const body = await readBody<Body>(event)

  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt (the restyle instruction) is required' })

  const styleRefs = Array.isArray(body?.styleRefs)
    ? body.styleRefs.filter((u): u is string => typeof u === 'string' && !!u).slice(0, MOODBOARD_MAX_REFS)
    : []
  const styleText = typeof body?.styleText === 'string' ? body.styleText : ''

  // A Style WITH reference images ⇒ the depth+style model; otherwise today's requested model.
  const model = pickRestyleModel(body?.model, styleRefs.length > 0)

  const beauty = typeof body?.beauty === 'string' ? body.beauty : ''
  const depth = typeof body?.depth === 'string' ? body.depth : ''
  // 'image' models consume the beauty crop; 'depth' and 'depth+style' consume the depth crop.
  const control = model.control === 'image' ? beauty : depth
  if (!control) {
    throw createError({ statusCode: 400, message: `${model.control === 'image' ? 'beauty' : 'depth'} control image is required` })
  }

  const strength = Math.max(0, Math.min(1, Number.isFinite(body?.strength) ? (body!.strength as number) : 0.6))
  const seed = Number.isFinite(body?.seed) ? Math.round(body!.seed as number) : Math.floor(Date.now() % 2_000_000_000)

  const { app, input } = restyleInput(model, prompt, beauty, depth, strength, seed, styleRefs, styleText)
  const out = await runFal(app, input, { pollDeadlineMs: 240_000 })
  const imageUrl = firstFalImageUrl(out)
  if (!imageUrl) throw createError({ statusCode: 502, message: 'fal returned no image' })

  return { imageUrl, model: model.id, seed }
})
```

- [ ] **Step 10 — typecheck the route** (`npx nuxi typecheck` or the repo's typecheck script). Controller commits.

- [ ] **Step 11 — `runRestyle`: resolve the moodboard + fold the hash** (no test-first: proven by Task 4's Playwright + the existing mocked-`$fetch` cache unit; the surface is not unit-mounted). Add imports after line 88:

```ts
import { restyleInputHash, restyleStyleSig, shouldRunRestyle } from '~/lib/scene3d/restyleCache'
import { useMoodboards } from '~/composables/useMoodboards'
import { moodboardStyleBlock } from '~/lib/taste/styleBlock'
import { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'
import WidgetMoodboardChip from '~/components/vue-canvas/widgets/WidgetMoodboardChip.vue'
```

Add a resolver above `runRestyle`:

```ts
/** Read a data URL from a Blob (moodboard images are same-origin/auth-guarded, so fal cannot fetch
 *  their /api URLs — they ride to the route as inline data URLs, exactly like the depth crop). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

/** Resolve a treatment's styleId → the moodboard's ≤3 reference data-URLs + style text + a cache sig.
 *  Graceful fallback: an empty id, a deleted/missing board (byId ⇒ undefined) returns null (⇒ plain
 *  depth restyle, no error). A board with NO images returns refs:[] but keeps styleText (a text-only
 *  nudge on the depth-only model — spec default). */
async function resolveRestyleStyle(
  styleId: string,
): Promise<{ refs: string[]; styleText: string; sig: string } | null> {
  if (!styleId) return null
  const entry = useMoodboards().byId(styleId)
  if (!entry) return null
  const styleText = moodboardStyleBlock(entry.reading)
  let files: string[] = []
  try {
    const list = await $fetch<{ files: string[] }>('/api/moodboards/images', { query: { folder: entry.folder } })
    files = (list?.files ?? []).slice(0, MOODBOARD_MAX_REFS)
  } catch { files = [] }
  const refs: string[] = []
  for (const file of files) {
    try {
      const blob = await $fetch<Blob>('/api/moodboards/images', { query: { folder: entry.folder, file }, responseType: 'blob' })
      refs.push(await blobToDataUrl(blob))
    } catch { /* skip an unreadable file; the others still ride */ }
  }
  const sig = restyleStyleSig(entry.folder, files, styleText)
  return { refs, styleText, sig }
}
```

Inside `runRestyle`, between the bake (step 1) and the hash (step 2), resolve the Style and thread it in:

```ts
    // 1b. Resolve the attached Style (moodboard), if any. Graceful fallback ⇒ null (plain restyle).
    const style = await resolveRestyleStyle(t.styleId)
    const styleId = style ? t.styleId : ''
    const styleSig = style?.sig ?? ''

    // 2. Prospective hash — now also over the Style id + its resolved ref-set sig.
    const hash = restyleInputHash(model, prompt, t.strength, passes.beauty, passes.depth, styleId, styleSig)
    if (!shouldRunRestyle(hash, t.inputHash, t.resultRef, restyleTexCache.has(t.resultRef))) {
      restyleStatus[treatmentId] = 'idle'
      return
    }
```

And extend the `$fetch` body (step 3):

```ts
      body: {
        prompt, beauty: passes.beauty, depth: passes.depth, strength: t.strength, model: model.id,
        styleRefs: style?.refs ?? [], styleText: style?.styleText ?? '',
      },
```

(`model.id` stays the selectable model; the route swaps to `flux-general` when `styleRefs` is non-empty. Everything after — persist, decode, stamp `resultRef`/`inputHash`/projector, project — is unchanged. If the surface routes doc edits through an explicit push/dirty call rather than direct mutation, mirror that call where `t.resultRef` is already persisted.)

- [ ] **Step 12 — typecheck the surface.** Controller commits.

---

## Task 3 · The "+ Style" picker in the restyle inspector

Store/show/clear `styleId` on the treatment. Reuse `WidgetMoodboardChip` for the filled/empty chip; open a compact studio-native moodboard popover (the surface's existing `anchorAbove` popover pattern — `LoraGalleryModal` is coupled to the node graph and cannot mount in this non-node surface, so its data source `useMoodboards()` + cover-thumb logic is reused, not the modal component).

**Files**
- `frontend/app/lib/scene3d/treatmentControls.ts` — `aiRestyle` case (lines 238–248): the `model` select lists only `selectable` models.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — the aiRestyle inspector block (lines 4674–4720): add the Style row; add picker state + set/clear handlers.
- Test: `scene3d-treatment-controls.unit.spec.ts`.

**Interfaces**
- Consumes `AiRestyleTreatment.styleId`, `useMoodboards()`, `WidgetMoodboardChip` (`:moodboard-id`, `:has-refs`, `@open`, `@clear`).
- Produces `setRestyleStyle(objectId, treatmentId, moodboardId)` / `clearRestyleStyle(objectId, treatmentId)`.

**Steps**

- [ ] **Step 1 — failing test (model select excludes the internal model).** Add to `scene3d-treatment-controls.unit.spec.ts`:

```ts
it('the aiRestyle Model select lists only selectable models (not the route-internal depth+style)', () => {
  const rows = treatmentControls('aiRestyle')
  const model = rows.find((r) => r.key.endsWith('model'))!
  expect(model.options).toEqual(['fal-ai/flux-control-lora-depth', 'fal-ai/flux/dev/image-to-image'])
  expect(model.options).not.toContain('fal-ai/flux-general')
})
```
(Match the actual `ControlSpec` field for a `select` — inspect the `select()` helper output in `treatmentControls.ts`; if options live under a differently-named field, assert that field.)

- [ ] **Step 2 — run it, expect FAIL.**

- [ ] **Step 3 — minimal impl (`treatmentControls.ts`).** In the `'aiRestyle'` case filter first:

```ts
    case 'aiRestyle': {
      const selectable = RESTYLE_MODELS.filter((m) => m.selectable !== false)
      rows = [
        text(g, 'prompt', 'Prompt', D.aiRestyle.prompt, 'Describe the new look, then use the restyle button'),
        select(g, 'model', 'Model', selectable.map((m) => m.id), selectable.map((m) => m.label), D.aiRestyle.model),
        slider(g, 'strength', 'Strength', 0, RESTYLE_STRENGTH_MAX, 0.01, D.aiRestyle.strength, 'How far the restyle departs from the original'),
        slider(g, 'mix', 'Mix', 0, 1, 0.01, D.aiRestyle.mix, 'Blend the result over the original — changing this is free'),
      ]
      break
    }
```

- [ ] **Step 4 — run it, expect PASS.** Controller commits.

- [ ] **Step 5 — UI: the Style row** (no unit; verified by Task 4 Playwright + manual controller preview). Add picker state in `<script setup>`:

```ts
const restyleStylePickerOpen = ref<string | null>(null) // the treatmentId whose picker is open, or null
const restyleStyleAnchor = ref<{ left: number; top: number } | null>(null)
const { moodboards: restyleMoodboards } = useMoodboards()

function openRestyleStylePicker(treatmentId: string, ev: MouseEvent): void {
  const el = ev.currentTarget as HTMLElement
  restyleStyleAnchor.value = anchorAbove(el)
  restyleStylePickerOpen.value = treatmentId
}
function setRestyleStyle(objectId: string, treatmentId: string, moodboardId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (!hit || hit.treatment.kind !== 'aiRestyle') return
  ;(hit.treatment as AiRestyleTreatment).styleId = moodboardId
  restyleStylePickerOpen.value = null
}
function clearRestyleStyle(objectId: string, treatmentId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (!hit || hit.treatment.kind !== 'aiRestyle') return
  ;(hit.treatment as AiRestyleTreatment).styleId = ''
}
```
(Assigning `.styleId` on the reactive `doc` treatment persists through the same watcher `runRestyle` relies on for `resultRef`. If the surface routes edits through an explicit push/dirty call, mirror that call here — check how `runRestyle`'s `t.resultRef = name` is persisted and match it. Reuse the existing `anchorAbove` helper the surface already uses for its popovers; if it has a different name, use that.)

Add the Style row into the aiRestyle inspector, directly after the `restyle-prompt` block (before `<StudioControlPanel>`, ~line 4685):

```html
          <!-- Style (moodboard): OPTIONAL. Attached => the restyle adopts the board's look (its refs +
               palette + prose) while depth holds the geometry. Reuses the Generate node's chip. -->
          <div v-if="activeTreatment.treatment.kind === 'aiRestyle'" class="space-y-1" data-testid="restyle-style-row">
            <label class="block px-1 text-[11px] text-white/55">Style</label>
            <WidgetMoodboardChip
              :moodboard-id="(activeTreatment.treatment as any).styleId || undefined"
              :has-refs="!!(activeTreatment.treatment as any).styleId"
              @open="openRestyleStylePicker(activeTreatment.treatment.id, $event)"
              @clear="clearRestyleStyle(activeTreatment.obj.id, activeTreatment.treatment.id)"
            />
          </div>
```
(`WidgetMoodboardChip`'s `@open`/`@clear` emit signatures: verify against the chip's `defineEmits`. If `@open` emits no native event, anchor the popover to the row's element ref instead of `$event`.)

Add the popover near the surface's other `anchorAbove` popovers (cover thumbs mirror `WidgetMoodboardChip`'s resolution: first file of `/api/moodboards/images?folder=`):

```html
      <div
        v-if="restyleStylePickerOpen && restyleStyleAnchor"
        class="fixed z-50 w-64 max-h-80 overflow-auto rounded-lg border border-white/10 bg-[#1b1b1f] p-1.5 shadow-xl"
        :style="{ left: restyleStyleAnchor.left + 'px', top: restyleStyleAnchor.top + 'px' }"
        data-testid="restyle-style-popover"
        @pointerdown.stop
      >
        <p v-if="!restyleMoodboards.length" class="px-2 py-3 text-[11px] text-white/40">
          No Styles yet — create a moodboard first.
        </p>
        <button
          v-for="m in restyleMoodboards" :key="m.id" type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.06]"
          :data-testid="`restyle-style-option-${m.id}`"
          @click="setRestyleStyle(activeTreatment!.obj.id, restyleStylePickerOpen!, m.id)"
        >
          <span class="text-[12px] text-white/85 truncate">{{ m.name }}</span>
        </button>
      </div>
```
(Add a lightweight click-away that sets `restyleStylePickerOpen = null`, matching the surface's other popovers.)

- [ ] **Step 6 — typecheck.** Controller commits.

---

## Task 4 · Whole-feature live Playwright (zero-spend) + unit sweep + typecheck

Prove a styled restyle still projects and holds under orbit (via the local `__scene3dRestyleInject` — the composite/projection is Style-agnostic), and that a `styleId` round-trips the doc; confirm the no-Style path is byte-identical (the existing disabled-row test still passes).

**Files**
- `frontend/tests/scene3d-restyle.spec.ts` — add a styled-doc orbit case + a `styleId` round-trip check.

**Steps**

- [ ] **Step 1 — add the styled-doc round-trip + orbit case** (mirrors the existing orbit-stability test; the only change is `styleId` on the treatment — no route/fal call, the result is injected locally):

```ts
const RESTYLE_STYLED = (overrides: Record<string, unknown> = {}) =>
  RESTYLE_ENABLED({ styleId: 'warm-editorial', ...overrides })

test('a styled restyle (styleId set) round-trips the doc and still projects + holds under orbit', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, orbitCamScene([RESTYLE_STYLED()]))

  // styleId survives serializeDoc → parseTreatment (Task 2): the pointer is in the doc, pixels are not.
  const styleId = await page.evaluate(() => (window as any).__scene3dDoc().objects[0].treatments[0].styleId)
  expect(styleId).toBe('warm-editorial')

  // The projection path does not care where the image came from — inject a LOCAL split texture (zero
  // spend) and assert orbit-registration, exactly as the no-Style orbit test does.
  expect(await injectSplit(page, 'restyle-sphere'), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  const nn = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]
  }
  const n = nn([-0.7, 0, 0.71])
  const P: [number, number, number] = [0.5*n[0], 0.6 + 0.5*n[1], 0.5*n[2]]
  const FOV = 40

  const still = await snapshotAt(page, 0)
  const cam0 = await camera(page)
  const c0 = await sampleWorldPoint(page, still, cam0, P, FOV)
  expect(sat(c0), `bake frame not a restyle colour: ${JSON.stringify(c0)}`).toBeGreaterThan(60)
  const magenta0 = c0.r > c0.g

  const orbited = await snapshotAt(page, 0.1)
  const cam1 = await camera(page)
  expect(Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z), 'camera did not orbit').toBeGreaterThan(0.5)
  const c1 = await sampleWorldPoint(page, orbited, cam1, P, FOV)
  expect(sat(c1), `after orbit slid off onto grey: ${JSON.stringify(c1)}`).toBeGreaterThan(60)
  expect(c1.r > c1.g, `after orbit colour class changed: ${JSON.stringify(c0)} → ${JSON.stringify(c1)}`).toBe(magenta0)

  expect(bad, `shader failures:\n${bad.join('\n')}`).toEqual([])
})
```
(`styleId: 'warm-editorial'` resolves to no library entry in the lab ⇒ the graceful-fallback path; the injected result bypasses `runRestyle` entirely, so no route/fal call — zero-spend, and it proves the doc-model + projection are Style-agnostic. Reuse the existing `orbitCamScene`, `injectSplit`, `snapshotAt`, `camera`, `sampleWorldPoint`, `sat`, `RESTYLE_ENABLED` helpers from the orbit-stability test; if a helper name differs, match the file.)

- [ ] **Step 2 — controller runs the Playwright spec** against a fresh preview (pane visible, isolated preview port — NOT `:3002`). The authoring subagent does NOT start a server.

- [ ] **Step 3 — full unit sweep** (subagent, headless):
`npx vitest run tests/unit/scene3d-restyle-models.unit.spec.ts tests/unit/scene3d-restyle-inputs.unit.spec.ts tests/unit/scene3d-restyle-cache.unit.spec.ts tests/unit/scene3d-treatments.unit.spec.ts tests/unit/scene3d-treatment-controls.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts`
— the last two must stay green (aiRestyle stays a generic treatment; `styleId` is not a numeric ControlSpec, so it is neither a motion target nor an agent control).

- [ ] **Step 4 — typecheck** the whole frontend. Controller commits any test-file additions.

---

## Task 5 · One env-gated PAID acceptance run + reconcile + closeout (GATED ON THE USER)

The only thing local injection cannot prove: the route → `fal-ai/flux-general` actually returns a usable styled image from our depth crop + real IP-adapter refs (a wrong repo/enum passes at submit, fails at result — the S7 `control_lora_image_url` lesson). EXACTLY ONE paid call, only under `SCENE3D_RESTYLE_LIVE=1` with `FAL_KEY` set, and only on the user's explicit go.

**Files**
- `frontend/tests/scene3d-restyle.spec.ts` — extend the `LIVE PAID` test with a real-moodboard/styled variant.

**Steps**

- [ ] **Step 1 — STOP; confirm with the user before any paid run.** State the estimate (`~10 credits`, `fal-ai/flux-general`) and that it makes ONE real fal call. Do not proceed without explicit go.

- [ ] **Step 2 — add the styled paid case** (same env gate; a tiny LOCAL solid-colour PNG stands in for a moodboard ref, or the controller supplies a real board's refs; presence of `styleRefs` routes to flux-general):

```ts
test('LIVE PAID (styled): flux-general returns a usable image from a depth crop + moodboard refs', async ({ page }) => {
  test.skip(!process.env.SCENE3D_RESTYLE_LIVE, 'paid — run manually with SCENE3D_RESTYLE_LIVE=1 and FAL_KEY set')
  test.setTimeout(180_000)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))
  const passes = await objectPasses(page, 'restyle-sphere')
  expect(passes, 'renderObjectPasses returned null').not.toBeNull()

  const ref = await page.evaluate(() => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64
    const c = cv.getContext('2d')!; c.fillStyle = '#b06f3a'; c.fillRect(0, 0, 64, 64)
    return cv.toDataURL('image/png')
  })

  const res = await page.evaluate(async ({ p, r }) => {
    const resp = await fetch('/api/scene3d/restyle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beauty: p.beauty, depth: p.depth, prompt: 'a weathered bronze statue, patina',
        model: 'fal-ai/flux-control-lora-depth', strength: 0.6,
        styleRefs: [r], styleText: 'In the style of: warm editorial. Palette: Amber #b06f3a.',
      }),
    })
    return { ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) as any }
  }, { p: passes!, r: ref })

  console.log('[restyle-style paid] status', res.status, 'model', res.body?.model, 'seed', res.body?.seed)
  expect(res.ok, `route failed ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(true)
  expect(res.body?.model, 'route did not swap to the depth+style model').toBe('fal-ai/flux-general')
  const imageUrl = res.body?.imageUrl as string
  expect(imageUrl, 'no imageUrl').toMatch(/^https?:\/\//)

  const img = await page.request.get(imageUrl)
  expect(img.ok(), `imageUrl did not load: ${img.status()}`).toBe(true)
  const bytes = await img.body()
  console.log('[restyle-style paid] image bytes', bytes.length)
  expect(bytes.length, 'styled restyle image suspiciously small').toBeGreaterThan(5000)
  const fs = await import('node:fs')
  fs.mkdirSync('test-results', { recursive: true })
  fs.writeFileSync('test-results/restyle-style-acceptance.png', bytes)
})
```

- [ ] **Step 3 — if the paid run 422s / fails at result:** the repo/enum strings from Task 1 are wrong. Correct `FLUX_DEPTH_CONTROLNET_PATH` / `FLUX_IP_ADAPTER_PATH` / encoder / weight in `restyleFalInputs.ts` AND the pinned unit together, then re-run. (This is the exact class of defect the paid run exists to catch.)

- [ ] **Step 4 — reconcile the observed cost** vs the `fal-ai/flux-general` `MODEL_COSTS` estimate (usd 0.05 / 10 credits). Update the row + its `confidence`/`note` to match the invoice.

- [ ] **Step 5 — closeout:** append a programme note (the depth+style model is live, the confirmed repo strings, the reconciled cost) to the scene3d treatments programme doc / the session memory / dashboard, per the programme's closeout convention. Send the styled result image to Julien.

---

## Self-review (spec coverage / placeholders / type consistency)

- **Every spec requirement maps to a task:** optional layer + no-Style byte-identity → T2 + T4; Approach A `flux-general` with `controlnets`+`ip_adapters` in one call → T1; depth crop + ≤3 refs (default IP scale) + prompt with `moodboardStyleBlock` folded in → T1; no new dial + moodboards only + `styleId` not a ControlSpec + `selectable:false` off the dropdown → T3; S7.1 projection untouched → no projection/engine file touched, T4 orbit proves it; `AiRestyleTreatment.styleId` → T2; graceful fallback (deleted/empty board) → T2 `resolveRestyleStyle`; cache re-bills on switch/edit → T2 `restyleStyleSig` + fold; MODEL_COSTS/allowlist tie + pinned enums → T1; zero-spend CI + one env-gated paid run gated on the user → T4 + T5.
- **No placeholders.** The one honest residual (exact fal repo strings) is written as concrete named constants with a pinned unit, flagged for Task-1 confirmation and validated end-to-end by the Task-5 paid run.
- **Type consistency:** `styleId: string` uniform (interface/default/parse/UI/hash); `RestyleModel.control` is `'depth' | 'image' | 'depth+style'` everywhere; `restyleInput(m, prompt, beauty, depth, strength, seed, styleRefs?, styleText?)` and `restyleInputHash(m, prompt, strength, beauty, depth, styleId?, styleSig?)` match their callers; the fal field names are identical between builder and unit.
- **Verify during execution (not a gap):** the `select()` ControlSpec field that holds options in `treatmentControls.ts` (the T3 test asserts `options`); `WidgetMoodboardChip`'s exact `@open`/`@clear` emit signatures; and the surface's `anchorAbove`/persist-edit helper names.

## Residual flagged for the controller/user
The four `flux-general` repo/encoder/weight strings in Task 1 are best-known candidates, **not network-verified** here. Task-1 Step 1 (controller WebFetch of fal's flux-general docs) and Task-5's failure branch both force confirmation before/at the paid run. The picker reuses `WidgetMoodboardChip` + `useMoodboards()` + a studio-native popover (not `LoraGalleryModal`, which is node-graph-coupled).
