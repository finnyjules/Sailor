# Replacing the non-commercial face models: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Replace Face Swap (pictures) with Easel on fal.
- Add Person swap (video) on Pixverse Swap.
- Replace Fix faces with Topaz on fal, which has face enhancement.
- Delete every InsightFace, CodeFormer and Wav2Lip use.

**Architecture:**
- There are three new runner families: `fix-faces`, `face-swap` and `person-swap-video`.
  - Each one moves a whole node class onto a fal endpoint, as `bria-product-shot` (F12) and `topaz-video` (F23) already do. That is `RunnerNodeRule.upgrade`.
  - Off by default. With a family off, the node goes to ComfyUI, whose Python node is now **definition-only** and fails in plain words.
- The Face Swap app stops posting raw `/prompt`. It starts a runner run and reads the result from the runner's event stream.

**Tech stack:** Nuxt 4 / Nitro (TypeScript), vitest, ComfyUI Python node schemas (`comfy_api.latest.IO`).

**Spec:** `docs/superpowers/specs/2026-09-26-non-commercial-face-models-replacement-design.md`

## Global constraints

- **Worktree.** Work in the worktree `/Users/julien/Documents/GitHub/Sailor/.claude/worktrees/goofy-bose-f33fec`, on branch `claude/goofy-bose-f33fec`. The user approved this. Merge into `main` at the end (Task 7).
- **Never `git stash`.** The stash stack is shared with other sessions.
- **Never run `npm run dev` from a subagent.** Never start a dev server. Only the controller restarts ComfyUI, and only in Task 6.
- **No paid provider calls anywhere in this plan.** Schema snapshots (`scripts/snapshot_provider_schemas.mjs`) are free GETs and are allowed.
- **Families** are off by default. Do not add them to any `.env`.
- **UI copy:**
  - sentence case;
  - no identifiers in labels;
  - selects need `optionLabels`;
  - hints go in tooltips, not panel copy;
  - error text is plain words (memory rules `ui-copy-*`).
- **Endpoints:**
  - `easel-ai/advanced-face-swap`
  - `fal-ai/topaz/upscale/image`
  - `fal-ai/pixverse/swap`
- **Prices** (fal llms.txt, read 2026-09-26):
  - Easel: $0.05 a picture.
  - Topaz image, by output size: $0.08 up to 24 MP, $0.16 up to 48 MP, $0.32 up to 96 MP, $1.36 up to 512 MP.
  - Pixverse Swap: $0.15 at 360p or 540p and $0.20 at 720p, "if input video duration is greater than 5 s the cost will double".
- **Sailor limits:**
  - Person swap video: up to 10 s, MP4/MOV/WebM, up to 100 MB. At 10 s the price is at most 2× base; fal states no maximum.
  - Fix faces input: at most `LARGEST_INPUT_PIXELS` (the shared ~19 MP cap). Because of that cap, the output never passes 512 MP.
- **Tests:**
  - Run from `frontend/` with `npx vitest run <file>`.
  - Typecheck with `npx nuxi typecheck`, comparing against the baseline (memory `typecheck-baseline-anchoring`). Record the error count before Task 1 and after each task. The count must not rise.
- **Saved schemas are the payload truth.** They were fetched 2026-09-27 into `frontend/tests/unit/fixtures/provider-schemas/fal/`:
  - `easel-ai__advanced-face-swap.json`: required `face_image_0`, `gender_0`, `workflow_type`. It also has `target_image`, `upscale` (default true), `detailer`, `face_image_1` and `gender_1`.
  - `fal-ai__topaz__upscale__image.json`: required `image_url`. It also has:
    - `model` (default "Standard V2") and `upscale_factor` (1–4, default 2);
    - `face_enhancement` (default true), `face_enhancement_strength` (0–1, default 0.8) and `face_enhancement_creativity` (0–1, default 0);
    - `output_format`, "jpeg" or "png" (default jpeg);
    - and more.
  - `fal-ai__pixverse__swap.json`: required `video_url`, `image_url`. It also has `mode` (person/object/background), `resolution` (360p/540p/720p) and `original_sound_switch` (default true), plus `keyframe_id` and `seed`.

## Reference implementations (read before each task)

| For | Read |
|---|---|
| A picture node moved whole onto a fal model | `frontend/server/runner/generators/briaProductShot.ts`, `frontend/tests/unit/runner-bria-product-shot.unit.spec.ts`, and every file that mentions `bria-product-shot` (`grep -rln "bria-product-shot\|BRIA_PRODUCT_SHOT" frontend/server frontend/shared frontend/app frontend/tests`) |
| A size-priced picture node | `frontend/shared/pricing/editSettings.ts` (`sizePricedInput`, `pricedInputPixels`, `editCalls`), `frontend/shared/pricing/editRates.ts` (`by_output_pixels`, the `topazlabs/image-upscale` card), `frontend/server/runner/requestRules.ts` (`sizePricedName`, `inputTooLargeWords`, `measuredInputProblem`) |
| A measured-video node | `frontend/shared/runner/topazVideo.ts`, `frontend/server/runner/generators/topazVideo.ts`, `frontend/server/runner/topazMedia.ts`, `frontend/server/runner/nodeMedia.ts`, `frontend/shared/pricing/clipSettings.ts` (`topazVideoCalls`), `frontend/shared/pricing/clipRates.ts`, `frontend/shared/pricing/nodePrice.ts` (`FAMILY_PRICED_CLASSES`), `frontend/tests/unit/runner-topaz-video.unit.spec.ts` |

## Commit recipe (every task)

This is a worktree with its own index, so the main checkout's private-index dance isn't needed. Stage only this task's paths **by exact path**, then commit:

```bash
cd /Users/julien/Documents/GitHub/Sailor/.claude/worktrees/goofy-bose-f33fec
git add <exact paths>
git commit -m "<type(scope): message>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # prove HEAD moved
```

---

### Task 1: Fix faces on Topaz (family `fix-faces`)

**Files:**
- Create: `frontend/server/runner/generators/topazImage.ts`, `frontend/tests/unit/runner-fix-faces.unit.spec.ts`
- Add (already saved): `frontend/tests/unit/fixtures/provider-schemas/fal/fal-ai__topaz__upscale__image.json`
- Modify:
  - `frontend/shared/runner/families.ts`: add `'fix-faces'` to the union and to `RUNNER_FAMILIES`.
  - `frontend/shared/runner/eligibility.ts`: add a `FixFacesNode` rule; add `'FixFacesNode'` to `IMAGE_OUTPUT_CLASSES`.
  - `frontend/shared/runner/blockedModels.ts`: add the class label `FixFacesNode: 'Fix faces'` next to `ProductShotNode`.
  - `frontend/shared/pricing/editRates.ts`: add the `fal-ai/topaz/upscale/image` card.
  - `frontend/shared/pricing/editSettings.ts`:
    - add `TOPAZ_IMAGE_APP` and `FIX_FACES_DEFAULTS`;
    - add FixFacesNode to `SETTING_PRICED_NODE_CLASSES`, `sizePricedInput` and `editCalls`.
  - `frontend/server/runner/executors.ts`: add a `case 'FixFacesNode'`.
  - `frontend/server/runner/requestRules.ts`: add `FIX_FACES_TOO_LARGE`, and a `FixFacesNode` branch in `sizePricedName` and `inputTooLargeWords`.
  - `frontend/server/runner/generators/twins.ts`: add the route `'FixFacesNode+fix-faces': r('fal', null, …)`.
  - `frontend/server/utils/priceBook.ts`: remove `FixFacesNode: 1` from the flat credits. Remove `CodeformerRemoteNode` everywhere. FixFacesNode stays in `PROVIDER_NODE_CLASSES`.
  - `frontend/tests/unit/fixtures/pricing/price-graph-golden.json`: regenerate.
  - Existing specs: `runner-families`, `runner-provider-schemas`, `runner-backup-routes`, `runner-switched-since-hold`, `agent-capability-routing` and `gate-chained-pictures`, plus any spec naming `CodeformerRemoteNode` (`grep -rln CodeformerRemoteNode frontend/tests`).
  - `comfy_api_nodes/nodes_replicate.py`:
    - rewrite `FixFacesNode` as definition-only with the new settings;
    - delete `CodeformerRemoteNode` (class and registration, around lines 2102–2130 and 6103);
    - delete `FixFacesNode`'s CodeFormer `execute` body.
  - Frontend catalogs:
    - `frontend/app/data/action-catalog.ts`: the FixFacesNode row's model becomes `'Topaz'`; drop `CodeformerRemoteNode` from `DEPRECATED_NODES`.
    - `frontend/app/data/generator-icons.ts`: the model label becomes `'Topaz'`.
    - `frontend/app/lib/agent/capabilities.ts`: FixFacesNode's inputs and summary.
    - `frontend/app/lib/nodeKeywords.ts` and `frontend/app/lib/canvas/nodeTier.ts`: remove `CodeformerRemoteNode` if listed.

**Interfaces:**
- Produces:
  - `TOPAZ_IMAGE_APP = 'fal-ai/topaz/upscale/image'` (exported from `#shared/pricing/editSettings`, re-exported by the generator);
  - `FIX_FACES_DEFAULTS = { strength: 0.8, creativity: 0, upscale: 2 }`;
  - `fixFacesSettings(inputs): { strength: number, creativity: number, upscale: number }`;
  - `topazFixFaces(o: { image: string, inputs: Record<string, unknown> }): ServiceCall`.

- [ ] **Step 1: Write the failing spec.** Model it on `runner-bria-product-shot.unit.spec.ts`. Import the same kit (`makeKit`, `ofType`, `checkPayload`, `loadProviderSchema`). The spec must at least contain:

```ts
import { describe, expect, it } from 'vitest'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, runnerTakesNode } from '#shared/runner/eligibility'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { FIX_FACES_DEFAULTS, LARGEST_INPUT_PIXELS, TOPAZ_IMAGE_APP, editCalls, fixFacesSettings, sizePricedInput } from '#shared/pricing/editSettings'
import { topazFixFaces } from '~~/server/runner/generators/topazImage'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { FIX_FACES_TOO_LARGE, measuredInputProblem } from '~~/server/runner/requestRules'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'

const ON: ReadonlySet<RunnerFamily> = new Set(['fix-faces'])
const schema = loadProviderSchema('fal', TOPAZ_IMAGE_APP)

describe('Fix faces on Topaz (fix-faces)', () => {
  it('is a family, off by default', () => {
    expect(RUNNER_FAMILIES).toContain('fix-faces')
    expect(classUpgradeOn('FixFacesNode', NO_FAMILIES)).toBe(false)
    expect(classUpgradeOn('FixFacesNode', ON)).toBe(true)
    expect(RUNNER_NODE_RULES.FixFacesNode?.upgrade?.family).toBe('fix-faces')
  })

  it('sends the node defaults, fitting the saved schema', () => {
    const call = topazFixFaces({ image: 'https://x/a.png', inputs: {} })
    expect(call).toEqual({
      provider: 'fal',
      endpoint: 'fal-ai/topaz/upscale/image',
      payload: {
        image_url: 'https://x/a.png',
        model: 'Standard V2',
        upscale_factor: 2,
        face_enhancement: true,
        face_enhancement_strength: 0.8,
        face_enhancement_creativity: 0,
        output_format: 'png',
      },
    })
    expect(checkPayload(schema, call.payload)).toEqual([])
  })

  it('clamps settings into the schema range', () => {
    expect(fixFacesSettings({ strength: 2, creativity: -1, upscale: 9 })).toEqual({ strength: 1, creativity: 0, upscale: 4 })
    expect(fixFacesSettings({ strength: 'x' })).toEqual(FIX_FACES_DEFAULTS)
    for (const upscale of [1, 2, 3, 4]) {
      expect(checkPayload(schema, topazFixFaces({ image: 'https://x/a.png', inputs: { upscale } }).payload)).toEqual([])
    }
  })

  it('is priced by output size, and at the cap when unmeasured', () => {
    const usd = (inputPixels: number | null, upscale = 2) => {
      const c = editCalls('FixFacesNode', { upscale }, { inputPixels, families: ON })
      if ('refused' in c) throw new Error(c.refused)
      return editMaxUsd(c.calls)
    }
    // 1024² × 2² = 4.2 MP → $0.08 tier; 3000 × 4000 × 2² = 48 MP → $0.16 tier; 12 MP × 4² = 192 MP → $1.36 tier
    expect(usd(1024 * 1024)).toBeLessThan(usd(3000 * 4000))
    expect(usd(12e6, 4)).toBeGreaterThan(usd(12e6, 2))
    expect(usd(null)).toBe(usd(LARGEST_INPUT_PIXELS))
    expect(EDIT_RATES['fal-ai/topaz/upscale/image']).toMatchObject({ unit: 'by_output_pixels', service: 'fal', confidence: 'verified' })
    expect(sizePricedInput('FixFacesNode', {})).toBe('image')
  })

  it('refuses a picture above the input cap', () => {
    expect(measuredInputProblem('FixFacesNode', LARGEST_INPUT_PIXELS + 1, ON)).toBe(FIX_FACES_TOO_LARGE)
    expect(measuredInputProblem('FixFacesNode', 1e6, ON)).toBeNull()
  })

  it('has no backup', () => {
    expect(RUNNER_ROUTES['FixFacesNode+fix-faces']).toMatchObject({ primary: 'fal', backup: null })
  })

  it('takes a node fed by a LoadImage only while the family is on', () => {
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      2: { class_type: 'FixFacesNode', inputs: { image: ['1', 0], strength: 0.8, creativity: 0, upscale: 2 } },
    }
    expect(runnerTakesNode(prompt, '2', new Set(['cards', 'fix-faces']))).toBe(true)
    expect(runnerTakesNode(prompt, '2', new Set(['cards']))).toBe(false)
  })
})
```

Check `RUNNER_ROUTES`' real record shape and `runnerTakesNode`'s real signature in `twins.ts` and `eligibility.ts` before running. Adjust the two assertions to them, keeping the meaning. Add the engine end-to-end case, copied from the Bria spec's end-to-end test with the class and endpoint swapped. That covers the hold, the charge and that the endpoint called is `TOPAZ_IMAGE_APP`.

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `cd frontend && npx vitest run tests/unit/runner-fix-faces.unit.spec.ts`
  - Expected: it FAILS on the missing exports.

- [ ] **Step 3: Implement the shared pricing.** In `editSettings.ts`, next to `BRIA_PRODUCT_SHOT_APP`:

```ts
/** Fix faces on Topaz image upscale with face enhancement, fal (family fix-faces). */
export const TOPAZ_IMAGE_APP = 'fal-ai/topaz/upscale/image'

/** FixFacesNode's settings as the node declares them (comfy_api_nodes/nodes_replicate.py). */
export const FIX_FACES_DEFAULTS = { strength: 0.8, creativity: 0, upscale: 2 } as const

const clampNum = (v: unknown, lo: number, hi: number, def: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def
}

/** The node's settings, read as the request sends them: out-of-range clamped, unreadable the default. */
export function fixFacesSettings(inputs: NodeInputs): { strength: number, creativity: number, upscale: number } {
  return {
    strength: clampNum(inputs.strength, 0, 1, FIX_FACES_DEFAULTS.strength),
    creativity: clampNum(inputs.creativity, 0, 1, FIX_FACES_DEFAULTS.creativity),
    upscale: Math.round(clampNum(inputs.upscale, 1, 4, FIX_FACES_DEFAULTS.upscale)),
  }
}
```

Then make these changes in the same file:
- Add `'FixFacesNode'` to `SETTING_PRICED_NODE_CLASSES`.
- In `sizePricedInput`, add `if (classType === 'FixFacesNode') return 'image'` as the first line.
- In `editCalls`, after the ProductShotNode branch:

```ts
  // Fix faces on Topaz (family fix-faces): billed by the output's size, the
  // input (measured, or the cap) enlarged `upscale` times on each side. A
  // linked upscale is priced at 4.
  if (classType === 'FixFacesNode') {
    const f = isLinked(inputs.upscale) ? 4 : fixFacesSettings(inputs).upscale
    return { calls: [call(TOPAZ_IMAGE_APP, null, { output: pricedInputPixels(opts.inputPixels) * f * f })] }
  }
```

Then remove FixFacesNode from `MODEL_PRICED_NODE_CLASSES` in `nodePrice.ts` if it is listed there. Check with `grep -n FixFacesNode frontend/shared/pricing/nodePrice.ts`.

In `editRates.ts`, after the `topazlabs/image-upscale` card:

```ts
  // Fix faces on fal's Topaz (family fix-faces): "For a single image, your
  // request will cost $0.08 for up to 24MP, $0.16 for up to 48MP, $0.32 for
  // up to 96MP, and up to $1.36 for 512MP output resolution" (llms.txt, read
  // 2026-09-26). MP read as 1,000,000 pixels (fail-safe). Between 96 and 512
  // MP fal names no step, so the top one.
  'fal-ai/topaz/upscale/image': {
    unit: 'by_output_pixels',
    steps: [[24e6, 0.08], [48e6, 0.16], [96e6, 0.32], [512e6, 1.36]],
    beyondPerPixel: 1.36 / 512e6,
    ...verified('fal', fal('fal-ai/topaz/upscale/image')),
  },
```

- [ ] **Step 4: Write the generator** at `frontend/server/runner/generators/topazImage.ts`:

```ts
/**
 * Fix faces (FixFacesNode) on Topaz image upscale with face enhancement, fal
 * (family `fix-faces`), no backup. Replaces CodeFormer (S-Lab licence,
 * non-commercial; spec 2026-09-26-non-commercial-face-models-replacement).
 *
 * Written from the saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__topaz__upscale__image.json):
 *   image_url                    the node's picture (the hand-off link)
 *   model                        "Standard V2": face enhancement applies to
 *                                Standard V2 and Recovery V2 only; sent so a
 *                                new default can't change the result
 *   upscale_factor               the node's Upscale, 1–4
 *   face_enhancement             true
 *   face_enhancement_strength    the node's Strength, 0–1
 *   face_enhancement_creativity  the node's Creativity, 0–1 (0 keeps the face the person's)
 *   output_format                "png" (the schema's default is jpeg)
 * Not sent: every Redefine / Recovery knob, subject_detection, crop_to_fill.
 */
import { TOPAZ_IMAGE_APP, fixFacesSettings } from '#shared/pricing/editSettings'
import type { ServiceCall } from './twins'

export { TOPAZ_IMAGE_APP }

export function topazFixFaces(o: { image: string, inputs: Record<string, unknown> }): ServiceCall {
  const s = fixFacesSettings(o.inputs)
  return {
    provider: 'fal',
    endpoint: TOPAZ_IMAGE_APP,
    payload: {
      image_url: o.image,
      model: 'Standard V2',
      upscale_factor: s.upscale,
      face_enhancement: true,
      face_enhancement_strength: s.strength,
      face_enhancement_creativity: s.creativity,
      output_format: 'png',
    },
  }
}
```

- [ ] **Step 5: Wire the runner.**

**`families.ts`:** add this to the union, after `'topaz-video'`:

```ts
  /**
   * Fix faces on fal's Topaz image upscale with face enhancement, no backup.
   * Moves the whole FixFacesNode (Ruling 10). Off, the node goes to ComfyUI,
   * whose definition-only Python node fails plainly: CodeFormer was removed
   * (non-commercial licence), so there is no ComfyUI path any more.
   */
  | 'fix-faces'
```

Then add `'fix-faces'` to `RUNNER_FAMILIES` after `'topaz-video'`.

**`eligibility.ts`:** add this rule next to `ProductShotNode`:

```ts
  // ── fix-faces: Fix faces on fal's Topaz (replaces CodeFormer) ──
  FixFacesNode: {
    upgrade: { family: 'fix-faces', label: 'Fix faces' },
    mustLink: ['image'],
    imageInputs: ['image'],
    mustNotLink: ['strength', 'creativity', 'upscale'],
  },
```

Also add `'FixFacesNode'` to `IMAGE_OUTPUT_CLASSES`. Then list every other place `ProductShotNode` sits in `eligibility.ts` (`grep -n ProductShotNode frontend/shared/runner/eligibility.ts`). Add `FixFacesNode` wherever the list means "runner picture nodes"; `validate.ts:48` is one example.

**`executors.ts`:** add this case after `ProductShotNode`:

```ts
    // ── fix-faces: Fix faces on fal's Topaz, no backup (topazImage.ts) ──
    case 'FixFacesNode': {
      const image = await pictureUrl('image', 'There is no picture to fix')
      return stillCall(topazFixFaces({ image, inputs }), 'fix_faces')
    }
```

Then import `topazFixFaces` from `./generators/topazImage`.

**`twins.ts`:** add this next to `'ProductShotNode+bria-product-shot'`:

```ts
  'FixFacesNode+fix-faces': r('fal', null, 'Replicate\'s Topaz is another app with its own settings and no face-enhancement strength'),
```

**`requestRules.ts`:**
- Add `export const FIX_FACES_TOO_LARGE = 'Fix faces takes pictures up to about 19 megapixels. Make this one smaller first.'`
- Add `case 'FixFacesNode': return 'Fix faces'` to `sizePricedName`.
- Add `case 'FixFacesNode': return FIX_FACES_TOO_LARGE` to `inputTooLargeWords`.

- [ ] **Step 6: Update the Python.** In `comfy_api_nodes/nodes_replicate.py`:
- Delete the `CodeformerRemoteNode` class and its entry in the extension's node list.
- Replace `FixFacesNode` with:

```python
class FixFacesNode(IO.ComfyNode):
    """Definition only: runs on Sailor's runner (family fix-faces, fal Topaz).
    CodeFormer was removed (S-Lab licence, non-commercial)."""

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FixFacesNode",
            display_name="Fix faces in a photo",
            category="api node/image/Replicate",
            description="Sharpens and rebuilds faces while upscaling, with Topaz. From about $0.08 a picture, by output size.",
            inputs=[
                IO.Image.Input("image"),
                IO.Float.Input("strength", default=0.8, min=0.0, max=1.0, step=0.05,
                               tooltip="How strongly faces are rebuilt."),
                IO.Float.Input("creativity", default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="0 keeps the face the person's; higher invents more detail."),
                IO.Int.Input("upscale", default=2, min=1, max=4, step=1,
                             tooltip="How many times larger the picture comes back."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.08,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, image, strength, creativity, upscale):
        raise RuntimeError("Fix faces runs on Sailor's runner. Switch on the fix-faces family.")
```

- Run: `cd /Users/julien/Documents/GitHub/Sailor/.claude/worktrees/goofy-bose-f33fec && python3 -c "import ast,sys; ast.parse(open('comfy_api_nodes/nodes_replicate.py').read())"`
- Expected: no output.

- [ ] **Step 7: Prices, catalogs, existing specs.**
- `priceBook.ts`:
  - drop the `CodeformerRemoteNode` and `FixFacesNode` flat-credit rows;
  - drop `'CodeformerRemoteNode'` from `PROVIDER_NODE_CLASSES`;
  - add FixFacesNode to the comment block that lists runner families (next to Bria's).
- Regenerate the golden file the way its spec says. Read the header of `frontend/tests/unit/price-graph*.spec.ts` for the regenerate flag.
- Update the catalog files listed above.
- In `agent/capabilities.ts`, replace any `codeformer_fidelity` / `background_enhance` / `face_upsample` input with `strength` / `creativity` / `upscale`.
- Update the existing specs that break. Keep their intent: for example, agent routing still reaches FixFacesNode for "fix the faces".

- [ ] **Step 8: Run and confirm everything passes.**

```bash
cd frontend && npx vitest run tests/unit/runner-fix-faces.unit.spec.ts tests/unit/runner-families.unit.spec.ts tests/unit/runner-provider-schemas.unit.spec.ts tests/unit/runner-backup-routes.unit.spec.ts tests/unit/runner-switched-since-hold.unit.spec.ts tests/unit/agent-capability-routing.unit.spec.ts tests/unit/gate-chained-pictures.unit.spec.ts tests/unit/node-credit-estimate.unit.spec.ts
```

- Expected: all pass.
- Then run `npx nuxi typecheck`. The error count must be ≤ the baseline.

- [ ] **Step 9: Commit.** Use the message `feat(runner): Fix faces on fal Topaz with face enhancement (family fix-faces); CodeFormer removed`.

---

### Task 2: Face Swap on Easel (family `face-swap`)

**Files:**
- Create: `frontend/shared/runner/faceSwap.ts`, `frontend/server/runner/generators/easelFaceSwap.ts`, `frontend/tests/unit/runner-face-swap.unit.spec.ts`
- Add (already saved): `frontend/tests/unit/fixtures/provider-schemas/fal/easel-ai__advanced-face-swap.json`
- Modify:
  - `families.ts`: add `'face-swap'`.
  - `eligibility.ts`: add a `FaceSwap` rule and add FaceSwap to `IMAGE_OUTPUT_CLASSES`.
  - `blockedModels.ts` (shared): the label `FaceSwap: 'Face swap'`.
  - `editRates.ts`: the Easel card.
  - `editSettings.ts`: FaceSwap goes in `SETTING_PRICED_NODE_CLASSES` and in `FIXED`, as a call to `EASEL_FACE_SWAP_APP`.
  - `executors.ts`: add a `case 'FaceSwap'`.
  - `requestRules.ts`: add a FaceSwap node problem (the gender) to the pre-hold checks, the way `topazVideoNodeProblem` is wired at line ~772.
  - `twins.ts`: the FaceSwap route.
  - `priceBook.ts`: add `'FaceSwap'` to `PROVIDER_NODE_CLASSES`.
  - The golden file.
  - `comfy_extras/nodes_face.py`: rewrite it whole (definition-only).
  - Catalogs:
    - `app/data/toolbox-items.ts:284`: the FaceSwap entry loses its `bundle` key and becomes a normal node entry.
    - `app/components/vue-canvas/ComfyNode.vue:195`: remove FaceSwap from `HEAVY_LOCAL_COMPUTE`.
    - `app/data/action-catalog.ts`: add `FaceSwap: { useCase: 'Swap a face', model: 'Easel', intent: 'edit' }`.
    - `app/data/generator-icons.ts`.
    - `app/lib/nodeDescriptions.ts`.

**Interfaces:**
- Produces, in `#shared/runner/faceSwap.ts`:
  - `EASEL_FACE_SWAP_APP = 'easel-ai/advanced-face-swap'`
  - `FACE_SWAP_GENDERS = ['male','female','non-binary'] as const`
  - `FACE_SWAP_HAIR = { target: 'target_hair', face: 'user_hair' } as const`
  - `FACE_SWAP_NEEDS_GENDER = 'Pick the face’s gender on the node.'`
  - `FACE_SWAP_ONE_PICTURE = 'Face swap takes one picture. For video, use Person swap (video).'`
  - `faceSwapGender(inputs): 'male'|'female'|'non-binary'|null`
  - `faceSwapWorkflow(inputs): 'target_hair'|'user_hair'`
- Produces, in the generator: `easelFaceSwap(o: { face: string, target: string, inputs: Record<string, unknown> }): ServiceCall`.
- Task 4 relies on the node's inputs being exactly `source_face` (IMAGE), `target_frames` (IMAGE), `gender` (COMBO `''|'male'|'female'|'non-binary'`, default `''`) and `keep_hair_from` (COMBO `'target'|'face'`, default `'target'`).

- [ ] **Step 1: Write the failing spec**, modelled on Task 1's. The key cases:

```ts
import { describe, expect, it } from 'vitest'
import { FACE_SWAP_NEEDS_GENDER, faceSwapGender, faceSwapWorkflow, EASEL_FACE_SWAP_APP } from '#shared/runner/faceSwap'
import { easelFaceSwap } from '~~/server/runner/generators/easelFaceSwap'
import { editCalls } from '#shared/pricing/editSettings'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'

const schema = loadProviderSchema('fal', EASEL_FACE_SWAP_APP)

describe('Face swap on Easel (face-swap)', () => {
  it('sends face, target, gender and hair choice, fitting the schema', () => {
    const call = easelFaceSwap({ face: 'https://x/f.png', target: 'https://x/t.png', inputs: { gender: 'female', keep_hair_from: 'target' } })
    expect(call).toEqual({
      provider: 'fal',
      endpoint: 'easel-ai/advanced-face-swap',
      payload: { face_image_0: 'https://x/f.png', gender_0: 'female', target_image: 'https://x/t.png', workflow_type: 'target_hair', upscale: true },
    })
    expect(checkPayload(schema, call.payload)).toEqual([])
  })
  it('maps "keep hair from face photo" to user_hair', () => {
    expect(faceSwapWorkflow({ keep_hair_from: 'face' })).toBe('user_hair')
    expect(faceSwapWorkflow({})).toBe('target_hair')
  })
  it('has no gender until one is picked', () => {
    expect(faceSwapGender({ gender: '' })).toBeNull()
    expect(faceSwapGender({ gender: 'robot' })).toBeNull()
    expect(faceSwapGender({ gender: 'non-binary' })).toBe('non-binary')
    expect(() => easelFaceSwap({ face: 'a', target: 'b', inputs: {} })).toThrow(FACE_SWAP_NEEDS_GENDER)
  })
  it('is priced flat at $0.05 at cost', () => {
    const c = editCalls('FaceSwap', { gender: 'male' })
    if ('refused' in c) throw new Error(c.refused)
    expect(c.calls[0]!.endpoint).toBe(EASEL_FACE_SWAP_APP)
    expect(EDIT_RATES[EASEL_FACE_SWAP_APP]).toMatchObject({ unit: 'per_image', usd: 0.05, service: 'fal' })
    expect(editMaxUsd(c.calls)).toBeGreaterThan(0)
  })
})
```

Also add these, modelled on Task 1:
- the family on/off;
- `runnerTakesNode` with two LoadImages feeding it;
- the no-backup route;
- the pre-hold refusal for a missing gender, through `requestProblems`;
- an engine end-to-end run from the Bria spec.

- [ ] **Step 2: Run it and confirm it fails.** Run `cd frontend && npx vitest run tests/unit/runner-face-swap.unit.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `#shared/runner/faceSwap.ts`:**

```ts
/**
 * Face swap (FaceSwap) on Easel's advanced face swap, fal (family face-swap).
 * Replaces InsightFace inswapper (non-commercial). The node's settings as the
 * request sends them; one reading for the builder and the pre-hold check.
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

export const EASEL_FACE_SWAP_APP = 'easel-ai/advanced-face-swap'
export const FACE_SWAP_GENDERS = ['male', 'female', 'non-binary'] as const
export type FaceSwapGender = typeof FACE_SWAP_GENDERS[number]
/** The node's "Keep hair from" → Easel's workflow_type. */
export const FACE_SWAP_HAIR = { target: 'target_hair', face: 'user_hair' } as const

export const FACE_SWAP_NEEDS_GENDER = 'Pick the face’s gender on the node.'
export const FACE_SWAP_ONE_PICTURE = 'Face swap takes one picture. For video, use Person swap (video).'

export function faceSwapGender(inputs: Inputs): FaceSwapGender | null {
  const g = inputs.gender
  return typeof g === 'string' && (FACE_SWAP_GENDERS as readonly string[]).includes(g) ? g as FaceSwapGender : null
}

export function faceSwapWorkflow(inputs: Inputs): 'target_hair' | 'user_hair' {
  return inputs.keep_hair_from === 'face' ? FACE_SWAP_HAIR.face : FACE_SWAP_HAIR.target
}
```

- [ ] **Step 4: Implement the generator** at `easelFaceSwap.ts`:

```ts
/**
 * Face swap on Easel (family face-swap), fal, no backup (Replicate has no
 * Easel). Written from tests/unit/fixtures/provider-schemas/fal/easel-ai__advanced-face-swap.json:
 *   face_image_0   the node's source_face (the face to use)
 *   gender_0       the node's Gender (required by Easel; no default)
 *   target_image   the node's target_frames (first frame only; a batch is refused before the hold)
 *   workflow_type  the node's "Keep hair from": target_hair / user_hair
 *   upscale        true (the schema's default, sent so it can't change)
 * Not sent: face_image_1 / gender_1 (a second face), detailer (beta).
 */
import { EASEL_FACE_SWAP_APP, FACE_SWAP_NEEDS_GENDER, faceSwapGender, faceSwapWorkflow } from '#shared/runner/faceSwap'
import type { ServiceCall } from './twins'

export function easelFaceSwap(o: { face: string, target: string, inputs: Record<string, unknown> }): ServiceCall {
  const gender = faceSwapGender(o.inputs)
  if (!gender) throw new Error(FACE_SWAP_NEEDS_GENDER)
  return {
    provider: 'fal',
    endpoint: EASEL_FACE_SWAP_APP,
    payload: { face_image_0: o.face, gender_0: gender, target_image: o.target, workflow_type: faceSwapWorkflow(o.inputs), upscale: true },
  }
}
```

- [ ] **Step 5: Wire it** the same way as Task 1 Step 5, with these values:
- **`families.ts`:** add `'face-swap'`, with a doc comment naming Easel and the removed inswapper.
- **`eligibility.ts`:**

```ts
  // ── face-swap: Face swap on Easel (replaces InsightFace inswapper) ──
  FaceSwap: {
    upgrade: { family: 'face-swap', label: 'Face swap' },
    mustLink: ['source_face', 'target_frames'],
    imageInputs: ['source_face', 'target_frames'],
    mustNotLink: ['gender', 'keep_hair_from'],
  },
```

- **`executors.ts`:**

```ts
    // ── face-swap: Easel on fal, no backup (easelFaceSwap.ts). Python sends
    // only an IMAGE batch's first frame; so does the runner (linkedFirstFile). ──
    case 'FaceSwap': {
      const face = await pictureUrl('source_face', 'There is no face picture')
      const target = await pictureUrl('target_frames', 'There is no picture to put the face in')
      return stillCall(easelFaceSwap({ face, target, inputs }), 'face_swap')
    }
```

- **`twins.ts`:** `'FaceSwap+face-swap': r('fal', null, 'Replicate has no Easel face swap')`.
- **`editRates.ts`:**

```ts
  // Face swap on Easel (family face-swap): "$0.05 per generations" (llms.txt, read 2026-09-26).
  'easel-ai/advanced-face-swap': { unit: 'per_image', usd: 0.05, ...verified('fal', fal('easel-ai/advanced-face-swap')) },
```

- **`editSettings.ts`:** add `FaceSwap: () => call(EASEL_FACE_SWAP_APP)` to `FIXED`, importing it from `../runner/faceSwap`, and add `'FaceSwap'` to `SETTING_PRICED_NODE_CLASSES`.
- **`requestRules.ts`:** where `EnhanceVideoNode` gets its runner-only problem (`else if (ct === 'EnhanceVideoNode' && opts.runner)`), add:

```ts
    else if (ct === 'FaceSwap' && opts.runner) {
      if (!isLink(node.inputs?.gender) && faceSwapGender(node.inputs ?? {}) == null) out.push({ nodeId, classType: ct, input: 'gender', message: FACE_SWAP_NEEDS_GENDER })
    }
```

Match the surrounding loop's variable names exactly.

**The one-picture refusal.** The runner only ever sends the first frame. A batch can only reach it from a video card, and `imageInputs` already leaves a video-wired input to ComfyUI. So the Python stub is where `FACE_SWAP_ONE_PICTURE` is shown (Step 6).

- [ ] **Step 6: Rewrite `comfy_extras/nodes_face.py`** as definition-only, keeping the file name, since `nodes.py` already loads it:

```python
"""Face swap and Person swap (video): node definitions only.

Both run on Sailor's runner (families face-swap and person-swap-video, fal).
The InsightFace / inswapper implementation was removed: its models are
licensed for non-commercial research only
(docs/superpowers/specs/2026-09-26-non-commercial-face-models-replacement-design.md).
"""
from __future__ import annotations

from typing_extensions import override

from comfy_api.latest import ComfyExtension, IO


class FaceSwapNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FaceSwap",
            display_name="Face swap",
            description="Put the face from one photo into another picture, with Easel. About $0.05 a picture. "
                        "Please don't use on real people without their consent, or on minors.",
            category="image",
            inputs=[
                IO.Image.Input("source_face", tooltip="A photo of the face to use. A clear, well-lit face works best."),
                IO.Image.Input("target_frames", tooltip="The picture to put the face in."),
                IO.Combo.Input("gender", options=["", "male", "female", "non-binary"], default="",
                               tooltip="The face's gender. Easel needs it to fit the face well."),
                IO.Combo.Input("keep_hair_from", options=["target", "face"], default="target",
                               tooltip="Whose hair to keep: the picture's or the face photo's."),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05}'),
        )

    @classmethod
    def execute(cls, source_face, target_frames, gender, keep_hair_from) -> IO.NodeOutput:
        if target_frames.shape[0] > 1:
            raise RuntimeError("Face swap takes one picture. For video, use Person swap (video).")
        raise RuntimeError("Face swap runs on Sailor's runner. Switch on the face-swap family.")


class FaceExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [FaceSwapNode]


async def comfy_entrypoint() -> FaceExtension:
    return FaceExtension()
```

Before writing, check the real extension pattern at the bottom of the current `nodes_face.py` and of `comfy_extras/nodes_person_swap.py`, and match it. The bundle registration (`register_bundle(...'faceswap'...)`) and all the model code go.

**Canvas select labels.** Give the Gender and Keep-hair selects option labels (memory rule `ui-copy-sentence-case-no-identifiers`). Find how other nodes map combo values to labels (`grep -rn "optionLabels" frontend/app | head`). Add:
- Gender: `'' → 'Choose…'`, `male → 'Male'`, `female → 'Female'`, `non-binary → 'Non-binary'`;
- Keep hair from: `target → 'The picture'`, `face → 'The face photo'`.

- [ ] **Step 7: Run everything.** Run the new spec plus the six shared runner specs from Task 1 Step 8, `native-small-routes-parity` and the typecheck. Expected: all pass.

**The bundles.** `native-small-routes-parity` will still list `faceswap` until Task 5. If it fails here only because the bundle is still listed on the TypeScript side while the Python registration is gone, remove the `faceswap` entries now:
- `frontend/server/native/modelBundles.ts:85`;
- `frontend/app/composables/useModelDownloads.ts` (`ALL_MODEL_BUNDLES`);
- the bundle-key type in `app/data/toolbox-items.ts:72`.

- [ ] **Step 8: Commit.** Use the message `feat(runner): Face swap on fal Easel (family face-swap); InsightFace inswapper removed`.

---

### Task 3: Person swap (video) on Pixverse (family `person-swap-video`)

**Files:**
- Create:
  - `frontend/shared/runner/personSwapVideo.ts`
  - `frontend/server/runner/generators/pixverseSwap.ts`
  - `frontend/server/runner/personSwapMedia.ts`
  - `frontend/tests/unit/runner-person-swap-video.unit.spec.ts`
- Add (already saved): `frontend/tests/unit/fixtures/provider-schemas/fal/fal-ai__pixverse__swap.json`
- Modify:
  - `families.ts`: add `'person-swap-video'`.
  - `eligibility.ts`: add a `PersonSwapVideo` rule.
  - `blockedModels.ts` (shared): the label.
  - `nodeMedia.ts`: add a `'person-swap-video'` kind.
  - `clipRates.ts`: the Pixverse swap card.
  - `clipSettings.ts`: `personSwapVideoCalls` and `personSwapVideoUsd`.
  - `nodePrice.ts`: `FAMILY_PRICED_CLASSES.PersonSwapVideo = 'person-swap-video'`, and the dispatch in `priceNode`, generalised off the topaz-only call (see Step 5).
  - `executors.ts`: add a `case 'PersonSwapVideo'`.
  - `requestRules.ts`: the pre-hold problem, next to EnhanceVideoNode's.
  - `switches.ts`: nothing unless the spec needs special wording. The generic `switchedOffWords('Person swap (video)')` is fine.
  - `twins.ts`: the route.
  - `priceBook.ts`: add to `PROVIDER_NODE_CLASSES`.
  - The golden file.
  - `comfy_extras/nodes_face.py`: add `PersonSwapVideoNode`.
  - Catalogs:
    - `action-catalog.ts`: `PersonSwapVideo: { useCase: 'Swap a person in a video', model: 'Pixverse', intent: 'edit' }`; add it to the `video:` list next to `EnhanceVideoNode`.
    - `generator-icons.ts`: an icon and the `'Pixverse'` label.
    - `nodeDescriptions.ts`.
    - `app/lib/agent/capabilities.ts`: add an entry like EnhanceVideoNode's, noting it needs an uploaded video and a person photo.

**Interfaces:**
- Produces, in `#shared/runner/personSwapVideo.ts`:
  - `PIXVERSE_SWAP_ENDPOINT = 'fal-ai/pixverse/swap'`
  - `PERSON_SWAP_RESOLUTIONS = ['360p','540p','720p']`
  - `PERSON_SWAP_MAX_SECONDS = 10`
  - `PERSON_SWAP_BASE_SECONDS = 5`
  - `personSwapResolution(inputs): string | null`
  - `personSwapRateKey(resolution, seconds): string`: `'720p'` or `'720p/long'`
- Produces, in the generator:
  - `pixverseSwapSource(prompt, nodeId)`, the same shape as `topazVideoSource`;
  - `pixverseSwapNodeProblem(prompt, nodeId)`;
  - `pixverseSwap(o: { videoUrl, imageUrl, resolution }): ServiceCall`.
- Produces, in the media file: `personSwapMediaCheck(prompt, nodeId, reads)` and `personSwapInputFiles(prompt, nodeId)`.
- The node's inputs are `video_url` (STRING, a `/view?…&type=input` link), `image` (IMAGE) and `resolution` (COMBO, default `'720p'`).

- [ ] **Step 1: Write the failing spec**, modelled on `runner-topaz-video.unit.spec.ts`. The key cases:

```ts
import { describe, expect, it } from 'vitest'
import { PIXVERSE_SWAP_ENDPOINT, PERSON_SWAP_MAX_SECONDS, personSwapRateKey } from '#shared/runner/personSwapVideo'
import { pixverseSwap, pixverseSwapNodeProblem } from '~~/server/runner/generators/pixverseSwap'
import { personSwapVideoUsd } from '#shared/pricing/clipSettings'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'

const schema = loadProviderSchema('fal', PIXVERSE_SWAP_ENDPOINT)
const node = (inputs: Record<string, unknown>) => ({
  1: { class_type: 'LoadImage', inputs: { image: 'p.png' } },
  2: { class_type: 'PersonSwapVideo', inputs: { image: ['1', 0], video_url: '/view?filename=clip.mp4&type=input', resolution: '720p', ...inputs } },
})

describe('Person swap (video) on Pixverse (person-swap-video)', () => {
  it('sends the video, the person and person mode, keeping the sound', () => {
    const call = pixverseSwap({ videoUrl: 'https://x/v.mp4', imageUrl: 'https://x/p.png', resolution: '540p' })
    expect(call).toEqual({
      provider: 'fal', endpoint: 'fal-ai/pixverse/swap',
      payload: { video_url: 'https://x/v.mp4', image_url: 'https://x/p.png', mode: 'person', resolution: '540p', original_sound_switch: true },
    })
    expect(checkPayload(schema, call.payload)).toEqual([])
  })
  it('prices by resolution, doubled over 5 s', () => {
    const usd = (resolution: string, video?: number) => personSwapVideoUsd({ resolution }, video === undefined ? {} : { video })
    expect(usd('360p', 5)).toBeCloseTo(usd('540p', 5))
    expect(usd('720p', 5)).toBeGreaterThan(usd('540p', 5) as number)
    expect(usd('720p', 5.01)).toBeCloseTo((usd('720p', 5) as number) * 2)
    expect(usd('720p', 5)).toBeCloseTo(usd('720p', 4))
    expect(usd('720p')).toBeCloseTo(usd('720p', PERSON_SWAP_MAX_SECONDS)) // unmeasured = the ceiling
    expect(personSwapRateKey('720p', 6)).toBe('720p/long')
  })
  it('refuses a web link, a missing video and an unknown resolution before the hold', () => {
    expect(pixverseSwapNodeProblem(node({ video_url: 'https://example.com/a.mp4' }), '2')?.input).toBe('video_url')
    expect(pixverseSwapNodeProblem(node({ video_url: '' }), '2')?.input).toBe('video_url')
    expect(pixverseSwapNodeProblem(node({ resolution: '1080p' }), '2')?.input).toBe('resolution')
    expect(pixverseSwapNodeProblem(node({}), '2')).toBeNull()
  })
})
```

Also add, modelled on the topaz spec:
- the media check: too long (> 10 s), wrong format and too large;
- that the price reads the measured seconds, and that a file changed after Run is refused;
- the family on/off, the route and the engine end-to-end run.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement `#shared/runner/personSwapVideo.ts`:**

```ts
/**
 * Person swap (video), PersonSwapVideo, on Pixverse Swap through fal (family
 * person-swap-video). Replaces the video half of the InsightFace face swap.
 * Pixverse's person mode swaps the whole person (face, hair, clothes), not
 * only the face. Pricing (llms.txt, read 2026-09-26): "For 5s video your
 * request will cost $0.15 for 360p and 540p, $0.2 for 720p … If input video
 * duration is greater than 5 s the cost will double." fal names no maximum
 * length, so Sailor stops at 10 s: at most the doubled price.
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

export const PIXVERSE_SWAP_ENDPOINT = 'fal-ai/pixverse/swap'
export const PERSON_SWAP_RESOLUTIONS: readonly string[] = ['360p', '540p', '720p']
export const PERSON_SWAP_BASE_SECONDS = 5
export const PERSON_SWAP_MAX_SECONDS = 10

export const PERSON_SWAP_UNKNOWN_SETTING = 'Choose a size (360p, 540p or 720p) on the node.'
export const PERSON_SWAP_TOO_LONG = `Person swap takes videos up to ${PERSON_SWAP_MAX_SECONDS} seconds long. Trim this one first.`
export const PERSON_SWAP_UNMEASURED = 'Sailor can’t read this video’s length, so it can’t price the swap. Try an MP4 video.'

export function personSwapResolution(inputs: Inputs): string | null {
  const r = inputs.resolution === undefined ? '720p' : inputs.resolution
  return typeof r === 'string' && PERSON_SWAP_RESOLUTIONS.includes(r) ? r : null
}

/** The rate card key: the resolution, with "/long" once the video is over 5 s (fal doubles it). */
export function personSwapRateKey(resolution: string, seconds: number): string {
  return seconds > PERSON_SWAP_BASE_SECONDS ? `${resolution}/long` : resolution
}
```

- [ ] **Step 4: Rate card and price.**

**`clipRates.ts`:** Pixverse bills per clip, not per second. Add a card with the unit the file already uses for per-second rates and a `byResolution` table, holding **flat per-clip** figures divided by the clip length the call names. The simplest way that fits `clipUsd`'s shape: price each call as `seconds: 1` with the full clip price as the per-second rate:

```ts
  // ── Person swap (video) on fal's Pixverse Swap (family person-swap-video) ──
  // Billed per clip: $0.15 at 360p/540p, $0.20 at 720p for 5 s; "if input
  // video duration is greater than 5 s the cost will double" (llms.txt, read
  // 2026-09-26). Written as a one-second rate (personSwapVideoCalls sends
  // seconds: 1), so the figure is the clip's price; "/long" is the doubled one.
  'fal-ai/pixverse/swap': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/pixverse/swap'), read: '2026-09-26', confidence: 'verified',
    byResolution: {
      '360p': 0.15, '540p': 0.15, '720p': 0.20,
      '360p/long': 0.30, '540p/long': 0.30, '720p/long': 0.40,
    },
  },
```

Read `clipUsd` first (`grep -n "export function clipUsd" -A30 frontend/shared/pricing/clipSettings.ts`). Confirm that `seconds: 1` makes it charge exactly the table figure, with no whole-second rounding above 1 and no minimum seconds. If it applies a minimum, use the documented alternative the file offers for flat prices, and state which in the code comment.

**`clipSettings.ts`:**

```ts
/** Person swap (video)'s call: the measured length picks the base or doubled clip price; unmeasured, the doubled one. */
export function personSwapVideoCalls(inputs: Inputs, measured: InputSeconds = {}): ClipCall[] | { refused: string } {
  const resolution = personSwapResolution(inputs)
  if (!resolution) return { refused: PERSON_SWAP_UNKNOWN_SETTING }
  const seconds = typeof measured.video === 'number' && measured.video > 0 ? measured.video : PERSON_SWAP_MAX_SECONDS
  if (seconds > PERSON_SWAP_MAX_SECONDS + 1e-6) return { refused: PERSON_SWAP_TOO_LONG }
  return [{ endpoint: PIXVERSE_SWAP_ENDPOINT, seconds: 1, resolution: personSwapRateKey(resolution, seconds), audio: false }]
}

export function personSwapVideoUsd(inputs: Inputs, measured: InputSeconds = {}): number | { refused: string } {
  const calls = personSwapVideoCalls(inputs, measured)
  if ('refused' in calls) return calls
  return clipUsd(calls[0]!.endpoint, calls[0]!)!
}
```

**`nodePrice.ts`:**
- Add `PersonSwapVideo: 'person-swap-video'` to `FAMILY_PRICED_CLASSES`.
- In `priceNode`, replace `const usd = topazVideoUsd(...)` with a switch on the class: `EnhanceVideoNode` goes to `topazVideoUsd`, `PersonSwapVideo` to `personSwapVideoUsd`.
- Update the doc comment.

- [ ] **Step 5: Generator and media check.**

**`pixverseSwap.ts`:** copy `topazVideoSource` and `topazVideoNodeProblem`'s shape exactly, with these words:
- `PERSON_SWAP_NEEDS_VIDEO = 'Person swap needs a video. Upload one to Sailor and use its link.'`
- `PERSON_SWAP_NOT_A_FILE = 'Person swap takes a video uploaded to Sailor, not a web link, so Sailor can measure it and price it. Upload the video first.'`

The node problem checks `resolution` first (`PERSON_SWAP_UNKNOWN_SETTING`, input `'resolution'`), then the video. The builder:

```ts
export function pixverseSwap(o: { videoUrl: string, imageUrl: string, resolution: string }): ServiceCall {
  return {
    provider: 'fal',
    endpoint: PIXVERSE_SWAP_ENDPOINT,
    payload: { video_url: o.videoUrl, image_url: o.imageUrl, mode: 'person', resolution: o.resolution, original_sound_switch: true },
  }
}
```

**`personSwapMedia.ts`:** copy `topazMedia.ts` with these changes:

```ts
export const PERSON_SWAP_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: 100_000_000,
  frameRate: false,
  words: {
    tooLarge: 'Person swap takes videos up to 100 MB here. Make this one smaller first.',
    wrongFormat: 'Person swap takes MP4, MOV or WebM videos.',
    tooManyPixels: 'This video is too large to swap. Use one up to 4K.',
    unmeasured: PERSON_SWAP_UNMEASURED,
  },
}
```

- Check `MediaRule`'s required fields in `mediaInputs.ts`. If `maxLongSide`/`maxShortSide` are required, use 4096 and 2160.
- Refuse `seconds > PERSON_SWAP_MAX_SECONDS` with `PERSON_SWAP_TOO_LONG`.
- Record `measured = { seconds: { video: seconds }, sha: { video: m.sha } }`.
- Changed-file words: `PERSON_SWAP_CHANGED = 'The video changed after you pressed Run. Run it again.'`

**`nodeMedia.ts`:**
- Add `'person-swap-video'` to `mediaNodeKind`'s return type, with `if (node.class_type === 'PersonSwapVideo') return 'person-swap-video'`.
- Add cases to `nodeMediaCheck`, `nodeMediaFiles` and `nodeMediaChangedWords`.

**`executors.ts`:**

```ts
    // ── person-swap-video: Pixverse Swap on fal, no backup. The engine has
    // already read and measured the video (personSwapMedia.ts). ──
    case 'PersonSwapVideo': {
      const problem = pixverseSwapNodeProblem(ctx.prompt, ctx.nodeId)
      if (problem) throw new Error(problem.message)
      const source = pixverseSwapSource(ctx.prompt, ctx.nodeId)
      if (!('file' in source)) throw new Error('This person swap has no video')
      const imageUrl = await pictureUrl('image', 'There is no picture of the person')
      const call = pixverseSwap({ videoUrl: await ctx.toUrl(source.file), imageUrl, resolution: personSwapResolution(inputs)! })
      return {
        kind: 'provider', provider: call.provider, endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'person_swap_video',
        uiFor: files => ({ video: files }),
      }
    }
```

Check how a video node that is its own output shows its result. Look at `GenerateVideoNode`'s `uiFor` near line 467 and use that shape.

**`eligibility.ts`:**

```ts
  // ── person-swap-video: Pixverse Swap on fal (the video half of the old face swap) ──
  PersonSwapVideo: {
    upgrade: { family: 'person-swap-video', label: 'Person swap (video)' },
    mustLink: ['image'],
    imageInputs: ['image'],
    mustNotLink: ['video_url', 'resolution'],
    widgets: {
      video_url: { type: 'STRING', required: true },
      resolution: { type: 'COMBO', required: true, options: PERSON_SWAP_RESOLUTIONS },
    },
  },
```

**`requestRules.ts`:** add a runner-only pre-hold branch like EnhanceVideoNode's, calling `pixverseSwapNodeProblem`.

**`twins.ts`:** `'PersonSwapVideo+person-swap-video': r('fal', null, 'Replicate has no Pixverse Swap')`.

- [ ] **Step 6: Python.** Add to `comfy_extras/nodes_face.py` and to its extension's node list:

```python
class PersonSwapVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="PersonSwapVideo",
            display_name="Person swap (video)",
            description="Replace the person in a video with the person in a photo, with Pixverse. "
                        "Swaps the whole person, not only the face. $0.15–0.20 up to 5 s, doubled up to 10 s. "
                        "Please don't use on real people without their consent, or on minors.",
            category="video",
            inputs=[
                IO.String.Input("video_url", default="", tooltip="A video uploaded to Sailor, up to 10 seconds."),
                IO.Image.Input("image", tooltip="A photo of the person to put in the video."),
                IO.Combo.Input("resolution", options=["360p", "540p", "720p"], default="720p"),
            ],
            outputs=[IO.Video.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"range_usd","min_usd":0.15,"max_usd":0.40}'),
        )

    @classmethod
    def execute(cls, video_url, image, resolution) -> IO.NodeOutput:
        raise RuntimeError("Person swap (video) runs on Sailor's runner. Switch on the person-swap-video family.")
```

Check the real price-badge expression format for a range. `grep -n "range_usd\|min_usd" comfy_api_nodes/*.py | head -3` shows it; match that.

How does the canvas give a node a video upload for a `video_url` widget? EnhanceVideoNode already has one. Find how its `video_url` gets an upload control (`grep -rn "video_url" frontend/app/components/vue-canvas | head`) and register `PersonSwapVideo` the same way.

- [ ] **Step 7: Run everything.** Run the new spec, `runner-topaz-video` (it must still pass after the `nodeMedia` and `nodePrice` edits), the Task 1 shared specs, `clip-pricing`, `node-credit-estimate` and the typecheck. Expected: all pass.

- [ ] **Step 8: Commit.** Use the message `feat(runner): Person swap (video) on fal Pixverse Swap (family person-swap-video)`.

---

### Task 4: The Face Swap app runs on the runner

**Files:**
- Create: `frontend/app/lib/runner/awaitRunnerResult.ts`, `frontend/tests/unit/face-swap-app-runner.unit.spec.ts`
- Modify: `frontend/app/components/apps/FaceSwapApp.vue`

**Interfaces:**
- Consumes (Task 2): FaceSwap's inputs `source_face`, `target_frames`, `gender`, `keep_hair_from`.
- Consumes (existing):
  - `startRunnerRun(body): Promise<LegStarted>` and `isRunnerDeclined(e)` from `~/lib/runner/client`;
  - `ensureRunnerEvents()` from `~/composables/useRunnerEvents`;
  - pipe envelopes `{ type: 'sailor-bridge', event: 'executed' | 'execution_error' | 'execution_complete', prompt_id, output?, exception_message? }` posted on `window`.
- Produces:
  - `buildFaceSwapPrompt(a: { face: string, target: string, gender: string, keepHairFrom: 'target' | 'face' }): ApiPrompt`
  - `awaitRunnerImage(promptId: string, opts?: { timeoutMs?: number, target?: Pick<Window,'addEventListener'|'removeEventListener'> }): Promise<{ filename: string, subfolder: string, type: string }>`

- [ ] **Step 1: Write the failing spec:**

```ts
import { describe, expect, it } from 'vitest'
import { awaitRunnerImage, buildFaceSwapPrompt } from '~/lib/runner/awaitRunnerResult'

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: unknown) => handlers.forEach(h => h({ data } as MessageEvent)),
    size: () => handlers.size,
  }
}

describe('Face Swap app on the runner', () => {
  it('builds LoadImage ×2 → FaceSwap with the picked gender and hair, no SaveImage', () => {
    const p = buildFaceSwapPrompt({ face: 'f.png', target: 't.png', gender: 'female', keepHairFrom: 'face' })
    expect(p).toEqual({
      1: { class_type: 'LoadImage', inputs: { image: 'f.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 't.png' } },
      3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: 'female', keep_hair_from: 'face' } },
    })
  })
  it('resolves with the FaceSwap picture of its own run only', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'executed', prompt_id: 'other', output: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } })
    w.post({ type: 'sailor-bridge', event: 'executed', prompt_id: 'run1.0', output: { images: [{ filename: 'face_swap_1.png', subfolder: '', type: 'output' }] } })
    await expect(done).resolves.toEqual({ filename: 'face_swap_1.png', subfolder: '', type: 'output' })
    expect(w.size()).toBe(0)
  })
  it('rejects with the runner’s own words on an error', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'execution_error', prompt_id: 'run1.0', exception_message: 'Pick the face’s gender on the node.' })
    await expect(done).rejects.toThrow('Pick the face’s gender on the node.')
  })
  it('rejects when the run completes with no picture', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'execution_complete', prompt_id: 'run1.0' })
    await expect(done).rejects.toThrow('The swap finished but made no picture.')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement `awaitRunnerResult.ts`:**

```ts
/**
 * A mini app's run on the Sailor runner: the prompt it sends and the wait for
 * its picture on the runner's event pipe (useRunnerEvents posts each event on
 * window as a `sailor-bridge` envelope). The Face Swap app is the first app on
 * the runner (spec 2026-09-26-non-commercial-face-models-replacement).
 */
import type { ApiPrompt } from '#shared/runner/graph'

export interface RunnerImage { filename: string; subfolder: string; type: string }

export function buildFaceSwapPrompt(a: { face: string, target: string, gender: string, keepHairFrom: 'target' | 'face' }): ApiPrompt {
  return {
    1: { class_type: 'LoadImage', inputs: { image: a.face } },
    2: { class_type: 'LoadImage', inputs: { image: a.target } },
    3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: a.gender, keep_hair_from: a.keepHairFrom } },
  } as ApiPrompt
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function awaitRunnerImage(promptId: string, opts: { timeoutMs?: number, target?: Target } = {}): Promise<RunnerImage> {
  const target = opts.target ?? window
  return new Promise((resolve, reject) => {
    let picture: RunnerImage | null = null
    const finish = (fn: () => void) => { clearTimeout(timer); target.removeEventListener('message', onMessage as EventListener); fn() }
    const onMessage = (e: MessageEvent) => {
      const d = e.data as Record<string, any> | null
      if (!d || d.type !== 'sailor-bridge' || d.prompt_id !== promptId) return
      if (d.event === 'executed') {
        const img = d.output?.images?.[0]
        if (img?.filename) { picture = { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' }; finish(() => resolve(picture!)) }
      } else if (d.event === 'execution_error') {
        finish(() => reject(new Error(d.exception_message || 'The swap failed.')))
      } else if (d.event === 'execution_complete') {
        finish(() => picture ? resolve(picture) : reject(new Error('The swap finished but made no picture.')))
      }
    }
    const timer = setTimeout(() => finish(() => reject(new Error('The swap took too long. Try again.'))), opts.timeoutMs ?? 5 * 60_000)
    target.addEventListener('message', onMessage as EventListener)
  })
}
```

- [ ] **Step 4: Run the spec.** Expected: PASS.

- [ ] **Step 5: Update `FaceSwapApp.vue`.**
- Delete `buildPrompt`, `pollForOutput`, `extractComfyError` and the inswapper/ComfyUI branches of `humanizeError`.
- The new `run()`:

```ts
async function run() {
  if (!canRun.value || !sourceFace.value || !targetImage.value || !gender.value) return
  errorMessage.value = null
  status.value = 'running'
  progressLabel.value = 'Swapping the face…'
  try {
    await ensureRunnerEvents()
    const prompt = buildFaceSwapPrompt({ face: sourceFace.value.filename, target: targetImage.value.filename, gender: gender.value, keepHairFrom: keepHairFrom.value })
    const leg = await startRunnerRun({ takes: [prompt], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    const promptId = leg.promptIds[0]
    if (!promptId) throw new Error('The swap didn’t start. Try again.')
    const output = await awaitRunnerImage(promptId)
    const url = `/view?${new URLSearchParams({ filename: output.filename, type: output.type, ...(output.subfolder ? { subfolder: output.subfolder } : {}), t: String(Date.now()) })}`
    addTake({ images: [url], promptId, sig: `${output.subfolder || ''}/${output.filename}` })
    status.value = 'done'
  } catch (e: any) {
    errorMessage.value = isRunnerDeclined(e) ? 'Face swap is switched off in Sailor right now.' : (e?.data?.message ?? e?.message ?? String(e))
    status.value = 'error'
  }
}
```

- State:
  - `const gender = ref<'' | 'male' | 'female' | 'non-binary'>(readSavedGender())`;
  - `const keepHairFrom = ref<'target' | 'face'>('target')`;
  - save the gender on change to `localStorage['sailor.faceSwap.gender']`, wrapped in try/catch.
- `canRun` also requires `gender.value !== ''`.
- Template: under the two drop zones, add a row with two controls.
  - **Face's gender:** a select with the options "Choose…" (disabled), "Male", "Female" and "Non-binary".
  - **Keep hair from:** a two-button segmented toggle, "The picture" and "The face photo".
  - Use the repo's own `StudioButton` / select components (memory `studio-button-is-the-button`) and match the existing app's styling.
  - No explanatory copy under them. A tooltip on "Keep hair from" is fine.
- Check whether `/api/runs` 404s here or says the family is off. When the server's family is off, `startRunnerRun` gets a 400 `not-eligible`. `isRunnerDeclined` covers both.

- [ ] **Step 6: Typecheck, then run the Task 4 spec.** Expected: both clean.

- [ ] **Step 7: Commit.** Use the message `feat(apps): Face Swap app runs on the runner (Easel), with gender and hair choices`.

---

### Task 5: Remove local Face restore and local Lip-sync, and every remaining InsightFace use

**Files:**
- Delete: `comfy_extras/nodes_face_restore.py`, `comfy_extras/nodes_lip_sync.py`
- Modify:
  - `nodes.py`: drop `"nodes_face_restore.py"` and `"nodes_lip_sync.py"` from the load list (~2580, 2587).
  - `comfy_extras/_model_downloads.py`: remove the InsightFace auto-download helper (~line 35) if nothing else uses it (`grep -rn "insightface" comfy_extras comfy_api_nodes`); update the doc comment at ~27.
  - `comfy_extras/_inpaint.py:23`: fix the comment ("onnxruntime, already pulled in by rembg").
  - `frontend/server/native/modelBundles.ts`: remove the `facerestore` (:70) and `lipsync` (:72) entries, plus `faceswap` if Task 2 didn't.
  - `frontend/app/composables/useModelDownloads.ts:13-15`: `ALL_MODEL_BUNDLES`.
  - `frontend/app/data/toolbox-items.ts`: remove the FaceRestore (:285) and LipSync (:434) entries, and trim the bundle-key union (:72-74).
  - `frontend/app/components/vue-canvas/ComfyNode.vue:195`: remove FaceRestore and LipSync from `HEAVY_LOCAL_COMPUTE`.
  - `frontend/app/components/vue-canvas/GeneratorsPanel.vue:31`: the stale CodeFormer comment.
  - `frontend/tests/unit/native-small-routes-parity.unit.spec.ts:416-418`.
  - `frontend/tests/unit/clip-pricing.unit.spec.ts:395`: it uses 'wav2lip' as an arbitrary unknown engine. Leave it unless it breaks; it is just a string.
  - `.dockerignore:29`: change the comment's "insightface bundles" to "model bundles".

- [ ] **Step 1: Check nothing else imports them.**
  - Run: `cd /Users/julien/Documents/GitHub/Sailor/.claude/worktrees/goofy-bose-f33fec && grep -rn "nodes_face_restore\|nodes_lip_sync\|FaceRestoreNode\|LipSyncNode\b\|wav2lip\|codeformer\|inswapper\|buffalo_l" --include=*.py --include=*.ts --include=*.vue --include=*.json . | grep -v node_modules | grep -v "docs/"`
  - Expected: only the hits listed above. Watch for name clashes: `LipSyncNode` in `comfy_api_nodes/nodes_replicate.py` is the **studio** node and **stays**, and `LipsyncNode` also stays. Only `comfy_extras/nodes_lip_sync.py`'s class, node_id `LipSync`, goes.
- [ ] **Step 2: Delete and edit** as listed.
- [ ] **Step 3: Check the Python parses.** Run `python3 -c "import ast; [ast.parse(open(f).read()) for f in ['nodes.py','comfy_extras/_model_downloads.py','comfy_extras/nodes_face.py']]"`. Expected: no output.
- [ ] **Step 4: Run the unit suite.**
  - Run `cd frontend && npx vitest run tests/unit` (it's slow; memory `vitest-counts-lie-under-load`), then the typecheck.
  - Expected: no new failures against the baseline recorded before Task 1.
- [ ] **Step 5: Commit.** Use the message `chore: remove local Face restore (CodeFormer) and Lip-sync (Wav2Lip) nodes and their model downloads`.

---

### Task 6: Refresh the `/object_info` baseline (controller only)

This needs ComfyUI running **from this worktree's code**. Only the controller does it, never a subagent.

- [ ] **Step 1: Look before touching anything.**
  - Run `lsof -nP -iTCP -sTCP:LISTEN | grep -E "node|python"`.
  - For each pid, run `lsof -a -p <pid> -d cwd` to see which checkout it serves.
- [ ] **Step 2: Work out which ComfyUI serves this checkout.** The ComfyUI on `:8188` serves the **main** checkout. This worktree's Python changes only reach it after the merge (Task 7). So do the baseline regeneration **after merging into `main`**, from the main checkout:
  - Restart ComfyUI there with `.venv/bin/python main.py --listen 127.0.0.1 --port 8188`. Tell the user first, because other sessions share it.
  - Then run `cd frontend && node scripts/snapshot_object_info.mjs`.
- [ ] **Step 3: Check the canvas can see the new nodes.** Run `node -e` against the regenerated `objectInfo.baseline.json.gz` to confirm that:
  - `FaceSwap` has `gender`/`keep_hair_from`;
  - `PersonSwapVideo` exists;
  - `FixFacesNode` has `strength`/`creativity`/`upscale`;
  - `FaceRestore`, `LipSync` and `CodeformerRemoteNode` are absent.
- [ ] **Step 4: Commit** the baseline on `main` using the private-index recipe (memory `private-git-index-is-the-fix-for-shared-staging`). Use the message `chore(native): object_info baseline after the face-model replacement`.

---

### Task 7: Merge, docs, memory, dashboard

- [ ] **Step 1: Merge.** Merge `main` into this branch again, resolve conflicts, and rerun the Task 5 Step 4 suite. Then fast-forward or merge the branch into `main` from the main checkout, touching only this branch's commits:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git merge --no-ff claude/goofy-bose-f33fec -m "Merge: replace non-commercial face models"
```

The main checkout has other sessions' uncommitted edits. `git merge` refuses if any of them touch the same files. If it refuses, stop and ask the user; don't stash.
- [ ] **Step 2: Refresh the baseline.** Do Task 6 now.
- [ ] **Step 3: Docs.**
  - In `docs/superpowers/specs/2026-09-26-characters-rework-design.md`, under "Also found", mark each row replaced or removed and link this spec.
  - Set this spec's status line to "built; families off pending one live call each".
- [ ] **Step 4: Memory.**
  - Update `face-models-licensing-2026-09.md`: the three features are now replaced or removed; the families are off; the live calls (~$0.50) are owed.
  - Update the `MEMORY.md` pointer line to match.
- [ ] **Step 5: Dashboard.** Update the State of the Build dashboard, following memory `update-dashboard-on-every-commit` and `sailor-build-dashboard`: three families built and off; live calls owed.
- [ ] **Step 6: Ask the user** before any live call: one Easel swap, one Fix faces at 2× and one 5 s Pixverse clip at 360p, about $0.50 in total.
