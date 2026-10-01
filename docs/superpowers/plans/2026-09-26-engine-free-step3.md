# Sailor without ComfyUI, step 3 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** everything Sailor offers runs without ComfyUI (except the stock local-diffusion nodes and blueprints, which stay local-only); this plan builds the first three slices in full — R0, results that aren't files passed between runner nodes; R1, the text and data cards; and R2, the picture effects (expanded 2026-09-26); and R3, the paid-model nodes (expanded 2026-09-27); and R5, the server video and sound tools (expanded 2026-09-28); and R6, the video and sound effects (expanded 2026-09-30); and R7, the paid and model nodes that replace the local AI models (expanded 2026-09-30) — and outlines R8–R11 (R4.1 is built).

**Architecture:** a runner node's results become per-slot *values* (`NodeRecord.values`): files as today, plus masks, text, numbers, true/false, JSON text and 3D model addresses. At a node's turn, every wire that brings a value is replaced by that value before the node's request is built, so every existing builder, check and prompt sees a plain value, as ComfyUI's `execute()` does. Prices keep reading the workflow as sent (a wired input is priced at its most expensive, as today). Bytes the runner makes itself are kept by sha256 in a run-scoped folder beside the run store. Which wires may carry values is one shared table (`shared/runner/`), read by the browser and the server. New cards run as a new `derive` plan kind: computed on the server, no provider, no charge.

**Tech stack:** Nitro/h3 1.15.8, TypeScript, `sharp` (already a dependency), vitest + PGlite, the fake fal/Replicate/ledger kit in `frontend/tests/unit/__runner__/kit.ts`, Python `.venv` for fixture scripts only.

**Spec:** `docs/superpowers/specs/2026-09-26-engine-free-step3-design.md` — read it first. Its decisions, money rules and parity rules bind every task. Also read `.superpowers/sdd/engine-free-step3-inventory.md` (the class-by-class inventory).

**Style note:** as in Phase A and B, a task that ports a Python node gives the behaviour contract, the Python source to port (file:line) and the TypeScript signatures; the proof is always fixtures generated **from the Python** plus a TypeScript test that makes the same result. New runner machinery (R0) is given as code.

## Global Constraints

- Work in the main checkout. Never `git stash`. Other sessions edit this checkout: never touch files outside your task, and leave files you didn't write alone even when they look broken.
- **Implementers do not commit or stage.** The controller commits with a private git index (`git read-tree HEAD` into a private index, then `git reset -q -- <paths>`). Each task's last step is a report to the controller.
- Never run a dev server. Never start or stop ComfyUI.
- **No paid calls, ever.** Tests use the fake fal and fake Replicate. Run every test with `env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN`.
- **Python product code is not changed.** Only new or existing scripts under `scripts/` change. `frontend/tests/unit/fixtures/runner-builders.json` must stay byte-identical (regenerate it and check `git diff` is empty when a task touches `scripts/runner_builder_fixtures.py`).
- **Switches are off by default.** R0 and R1 add one runner family, `cards`. With `cards` off, the runner takes exactly what it takes today, and every existing `tests/unit/runner-*.unit.spec.ts` stays green, unchanged.
- **Money rules** (spec, binding): one price calculation (`frontend/shared/pricing/`); hosted models at the house markup, a backup only if its at-cost price doesn't raise the node's price; refusal before hold; switches off by default; one live paid check per family before switch-on (the controller's, with the user's go); local work is free.
- **Parity rules** (spec, binding): pixel-exact where deterministic (8-bit output for the same 8-bit input, per node); visually equal where random; lossy encoders compared decoded; text and data byte-identical.
- **Prices never read a wired value.** Hold and charge read `take.prompt` as sent. Only planning reads the value-substituted prompt.
- Server modules import explicitly (`from 'h3'`, relative paths, `#shared/...`), never through Nitro auto-imports, so vitest can load them.
- Tests go in `frontend/tests/unit/runner-*.unit.spec.ts`. Run one with `cd /Users/julien/Documents/GitHub/Sailor/frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/<file>`.
- Typecheck: `cd frontend && npx vue-tsc --noEmit -p .nuxt/tsconfig.server.json 2>/dev/null | grep -E 'server/runner|shared/runner|server/templates|shared/taste'` shows nothing. For app files, `-p tsconfig.json`, and don't grow the baselines (default.vue 5, VueNodeCanvas.vue 16, ComfyNode.vue 2, AssetsHistory.vue 12). `VueNodeCanvas.vue` has another session's uncommitted edits: no task here touches it.
- UI copy and error messages: sentence case, plain words, readable on a node.
- No new npm dependencies.
- Fixture scripts block the network the way `scripts/compositor_fixtures.py` does (`block_network()` before any node module is imported) and are run with `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/<script>.py`.
- Each task's report says: what it built or ported (file:line), how many fixture cases, how any fixture file was regenerated, and the test and typecheck output.

---

## File structure

New files:

| File | Responsibility |
|---|---|
| `frontend/server/runner/values.ts` | A node's per-slot values: reading a slot (with the pre-R0 fallback), files named by a value, a value as a literal, size checks, and wired values substituted into a node's inputs. |
| `frontend/server/runner/keptBytes.ts` | Bytes the runner makes itself, kept per run by sha256, beside the run store. |
| `frontend/server/runner/fileAccess.ts` | One reader for every file a run touches: store files and kept bytes. |
| `frontend/server/runner/pictures/mask.ts` | Masks as 16-bit greyscale PNGs holding ComfyUI's MASK values; LoadImage's MASK. |
| `frontend/server/runner/pictures/pythonView.ts` | A picture file as the PNG a Python loader's tensor would hand a provider (RGB, EXIF turned). |
| `frontend/server/runner/pixels/resize.ts` | `F.interpolate(mode='bilinear', align_corners=False)` in float32, torch-exact. R2 reuses it. |
| `frontend/server/runner/cards/*.ts` | The R1 cards: `text.ts`, `bakeReplay.ts`, `loadImage.ts`, `utilities.ts`, `saveImage.ts`, `smartLayout.ts`. |
| `frontend/shared/runner/values.ts` | Value kinds, what each class's output slots carry, and the base value inputs. Pure, no imports but `./graph`. |
| `frontend/shared/runner/staticValues.ts` | Values a card's own settings decide (Primitive, Text, Moodboard, Model3D), computed without running: for moderation at the start and for the cards' own plans. |
| `frontend/shared/taste/moodboardStyle.ts` | The Moodboard style block, Python-tolerant, shared by the browser and the runner. |
| `frontend/server/templates/renderPng.ts` | The Smart Layout render (satori → resvg) as a function, called by the route and by the runner. |
| `scripts/runner_values_fixtures.py` | Python fixtures for R0's picture and mask helpers and the bilinear kernel. |
| `scripts/runner_cards_fixtures.py` | Python fixtures for the R1 cards. |
| `frontend/shared/runner/effects.ts`, `effectSchemas.generated.ts` | R2: the effects' families, rule rows (from the real Python schemas, generated by `scripts/runner_effect_rows.py`), output kinds, caps. |
| `frontend/server/runner/effects/table.ts`, `plan.ts`, `io.ts` | R2: each effect's spec (worker op, batch kind, work, output size) and the one derive plan every effect runs through. |
| `frontend/server/runner/effects/core/*.ts` | R2: self-contained worker cores — `tensor`, `kernels` (sampling, pooling, convolution, torchvision colour), `rng` (torch's CPU random numbers), and the effect groups `tone`, `blur`, `cells`, `warp`, `mask`, `noise`. |
| `frontend/server/runner/effects/asciiGlyphs.bin`, `asciiGlyphs.ts`, `painter.ts` | R2: Ascii's glyph atlas as Python renders it; Painter's file read. |
| `frontend/server/runner/cards/shaderEffect.ts`, `frontend/app/lib/runner/shaderBake.ts`, `frontend/shared/runner/shaderBakeKey.ts` | R2.10: the Shader effect replayed from the browser's bake. |
| `frontend/server/api/runs/preview.post.ts`, `frontend/server/runner/preview.ts`, `frontend/app/lib/runner/livePreview.ts` | R2.11: live previews through the runner, free. |
| `scripts/runner_effects_fixtures.py` | Python fixtures for R2, one file per group (`runner-effects-<group>.json`). |
| `frontend/server/runner/rawJson.ts`, `frontend/shared/runner/pyJson.ts` | R3.1: a provider answer's body text kept beside its parsed form; Python's `json.loads` / `json.dumps` / `str()` for value outputs. |
| `frontend/shared/pricing/paidRates.ts`, `paidSettings.ts` | R3.2: rate cards for the paid nodes' endpoints, and the calls each node's settings make (one price calculation with `priceNode`). |
| `frontend/server/runner/generators/{llm,describe,repair,layers,splitLayers,audioGen,gen3d,soundIn,textEffects,imageExtras,lora,restyleLora,nanoExtras,turntable}.ts` | R3.3–R3.17: each paid node's request builder and answer reader, ported from the Python. |
| `frontend/shared/runner/shotPresets.ts` | R3.11: Film a shot's presets and shot phrases, shared by the browser and the runner. |
| `scripts/runner_paid_fixtures.py` | Python fixtures for R3 (every call a node makes, and its output from recorded answers), one file per group (`runner-paid-<group>.json`). |
| `scripts/media-tools/build.sh`, `versions.env`, `configure.args` | R5.1a: the LGPL ffmpeg/ffprobe build (FFmpeg 8.0.3 + OpenH264 2.5.1, LAME, Opus, dav1d), pinned by version and sha256, for this Mac and the Fly image. |
| `frontend/server/media/{tools,run,probe,decode,encode,h264Quality,values,resample,thumbnails}.ts` | R5.1a–R5.6: finding and checking the tools; running them (limits, time, Stop); probe, decode and encode as PyAV does; values between nodes; torchaudio's resampler; Timeline thumbnails and waveforms. |
| `frontend/shared/runner/media.ts` | R5.1b: media caps (local and hosted) and plain messages. |
| `frontend/server/runner/media/{soundNodes,videoNodes,frameNodes}.ts` | R5.3–R5.5: the codec classes and the Audio and Video cards. |
| `scripts/runner_media_fixtures.py` | Python (PyAV) fixtures for R5, one file per group (`runner-media-<group>.json`), and the standard clips in `frontend/tests/unit/fixtures/media/`; R6 adds groups `vfx-*`, `sfx` and `sfx-denoise`. |
| `frontend/shared/runner/mediaEffects.ts`, `mediaEffectSchemas.generated.ts` | R6.1: the video and sound effects' families, rule rows (from the real Python schemas, generated by `scripts/runner_effect_rows.py --media`), frame-batch makers and output kinds. |
| `frontend/server/runner/video/{table,shapes,start,plan,cores,text,soundShapes}.ts` | R6.1–R6.9: each video effect's spec (worker op, how it reads frames, shape, held bytes, work), the start pass that sends what the runner can't do to the engine, and the one plan every video effect runs through. |
| `frontend/server/runner/video/core/{time,join,look,fft,stabilize,flow,draw,waveform,noiseClip,glyphs,textDraw,sound,denoise}.ts` | R6.1–R6.10: self-contained worker cores — the effects, pocketfft's FFT, OpenCV's Farneback flow, Pillow's integer drawing and ink blend, a coverage rasteriser for letters, the sound effects and noisereduce's spectral gating. |
| `frontend/server/runner/video/fonts/DejaVuSans-Bold.ttf`, `LICENSE_DEJAVU` | R6.8: the bundled font for captions and text clips where none of Python's fonts exists (copied from the Python install). |
| `frontend/server/runner/media/soundEffects.ts` | R6.9–R6.10: the sound effects' and Silence cut's plans. |
| `frontend/shared/runner/localModels.ts` | R7.1: the local-model classes' families, the service each runs on (for the price tooltip), and their rule rows. |
| `frontend/server/runner/generators/localModels.ts` | R7.1–R7.8: each moved class's call and the cheap steps around it (alpha, grow, composite, masks, captions, stems, frame count). |
| `frontend/shared/runner/samInput.ts` | R7.4: SAM 3's payload, shared by `/api/inpaint/segment` and the runner (moved from `server/utils/samInput.ts`). |
| `frontend/server/utils/depthModel.ts`, `frontend/server/runner/effects/core/lens.ts`, `frontend/server/runner/cards/lensBlur.ts` | R7.9: the in-process depth model (shared with `/api/depth/estimate`), the lens blur core, and Lens · Depth of field's plan. |

Modified: `server/runner/types.ts`, `engine.ts`, `executors.ts`, `metering.ts`, `store.ts`, `results.ts`, `inputs.ts`, `index.ts`, `compositor/plan.ts`; `shared/runner/eligibility.ts`, `families.ts`, `validate.ts`; `app/lib/taste/styleBlock.ts`; `server/api/render-template.post.ts`. R6 also modifies `server/media/run.ts` (the lease), `server/media/values.ts`, `server/runner/keptBytes.ts`, `compositor/worker.ts`, `effects/core/kernels.ts` (`gridSample3d`), `shared/runner/media.ts` and `scripts/runner_effect_rows.py`. R7 also modifies `shared/pricing/paidRates.ts` and `paidSettings.ts`, `shared/runner/retired.ts`, `server/api/depth/estimate.post.ts`, `server/api/inpaint/segment.post.ts`, `app/lib/nodeCreditEstimate.ts`, `scripts/runner_paid_fixtures.py` (groups `local-*`) and `scripts/runner_effects_fixtures.py` (group `lens`).

---

# R0 — Non-file results between runner nodes

### Task R0.1: The value record

Adds per-slot values to a node's record. No behaviour changes: every node still records files, and every slot reads as before.

**Files:**
- Modify: `frontend/server/runner/types.ts` (OutputFile :15-19; NodeRecord :68-113)
- Create: `frontend/server/runner/values.ts`
- Modify: `frontend/server/runner/engine.ts:276-290` (`filesAt`)
- Test: `frontend/tests/unit/runner-values.unit.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type RunnerValue` (types.ts)
  - `OutputFile['type']` gains `'kept'`
  - `NodeRecord.values?: Record<number, RunnerValue>`
  - values.ts: `MAX_VALUE_TEXT_CHARS = 262_144`, `VALUE_TOO_LONG`, `VALUE_NOT_FINITE`, `slotValue(rec, slot)`, `filesOf(v)`, `filesOfValues(values)`, `literalOf(v)`, `checkValue(v)`
  - engine.ts: `valueAt(take)` (internal), `filesAt(take)` now built on it

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-values.unit.spec.ts
/**
 * R0.1: a runner node's results per output slot. A record written before
 * values existed reads exactly as before: every slot its files, or the
 * Frame's protect_mask slot from slotOutputs.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_VALUE_TEXT_CHARS, VALUE_NOT_FINITE, VALUE_TOO_LONG,
  checkValue, filesOf, filesOfValues, literalOf, slotValue,
} from '~~/server/runner/values'
import { emptyNodeRecord, type NodeRecord, type OutputFile } from '~~/server/runner/types'

const f = (filename: string, type: OutputFile['type'] = 'output'): OutputFile => ({ filename, subfolder: '', type })
const rec = (over: Partial<NodeRecord>): NodeRecord => ({ ...emptyNodeRecord('X'), ...over })

describe('slotValue', () => {
  it('reads a record without values as before: every slot its files', () => {
    const r = rec({ outputs: [f('a.png')] })
    expect(slotValue(r, 0)).toEqual({ kind: 'files', files: [f('a.png')] })
    expect(slotValue(r, 3)).toEqual({ kind: 'files', files: [f('a.png')] })
  })
  it('reads a later slot from slotOutputs when the record keeps them (the Frame protect_mask)', () => {
    const r = rec({ outputs: [f('a.png')], slotOutputs: { 1: [f('m.png', 'temp')] } })
    expect(slotValue(r, 1)).toEqual({ kind: 'files', files: [f('m.png', 'temp')] })
    expect(slotValue(r, 2)).toEqual({ kind: 'files', files: [] })
  })
  it('reads values by slot when the record has them, and nothing for a slot it lacks', () => {
    const r = rec({ values: { 0: { kind: 'text', text: 'hi' } } })
    expect(slotValue(r, 0)).toEqual({ kind: 'text', text: 'hi' })
    expect(slotValue(r, 1)).toBeUndefined()
  })
  it('reads nothing from a missing record', () => {
    expect(slotValue(undefined, 0)).toBeUndefined()
  })
})

describe('filesOf / literalOf', () => {
  it('names the files of files, mask and glb values only', () => {
    expect(filesOf({ kind: 'files', files: [f('a.png')] })).toEqual([f('a.png')])
    expect(filesOf({ kind: 'mask', files: [f('m.png', 'kept')] })).toEqual([f('m.png', 'kept')])
    expect(filesOf({ kind: 'glb', url: '/view?x', file: f('m.glb') })).toEqual([f('m.glb')])
    expect(filesOf({ kind: 'glb', url: 'https://x', file: null })).toEqual([])
    expect(filesOf({ kind: 'text', text: 'a' })).toEqual([])
    expect(filesOf(undefined)).toEqual([])
  })
  it('lists every file once across slots', () => {
    const a = f('a.png')
    expect(filesOfValues({ 0: { kind: 'files', files: [a, a] }, 1: { kind: 'mask', files: [f('m.png', 'kept')] } }))
      .toEqual([a, f('m.png', 'kept')])
  })
  it('turns text, numbers, booleans, JSON text and addresses into the literal a typed widget would hold', () => {
    expect(literalOf({ kind: 'text', text: 'a' })).toBe('a')
    expect(literalOf({ kind: 'number', value: 3, int: true })).toBe(3)
    expect(literalOf({ kind: 'boolean', value: false })).toBe(false)
    expect(literalOf({ kind: 'json', text: '[1, 2]' })).toBe('[1, 2]')
    expect(literalOf({ kind: 'glb', url: '/view?filename=m.glb&type=output', file: null })).toBe('/view?filename=m.glb&type=output')
    expect(literalOf({ kind: 'files', files: [] })).toBeUndefined()
    expect(literalOf({ kind: 'mask', files: [] })).toBeUndefined()
  })
})

describe('checkValue', () => {
  it('refuses text over the limit and numbers JSON cannot keep', () => {
    expect(() => checkValue({ kind: 'text', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS) })).not.toThrow()
    expect(() => checkValue({ kind: 'text', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS + 1) })).toThrow(VALUE_TOO_LONG)
    expect(() => checkValue({ kind: 'json', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS + 1) })).toThrow(VALUE_TOO_LONG)
    expect(() => checkValue({ kind: 'number', value: Number.NaN, int: false })).toThrow(VALUE_NOT_FINITE)
    expect(() => checkValue({ kind: 'number', value: Infinity, int: false })).toThrow(VALUE_NOT_FINITE)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values.unit.spec.ts`
Expected: FAIL, cannot resolve `~~/server/runner/values`.

- [ ] **Step 3: Add the types**

In `types.ts`, change `OutputFile.type` and add `RunnerValue` after `OutputFile`:

```ts
export interface OutputFile {
  filename: string
  subfolder: string
  /**
   * 'kept': bytes the runner made itself and keeps for the run by their
   * sha256 (./keptBytes.ts; subfolder = the run id). Never an asset, never
   * served by /view, never a file a workflow names.
   */
  type: 'output' | 'input' | 'temp' | 'kept'
}

/**
 * What one output slot of a runner node hands on (R0, step 3 spec):
 *   files    pictures, videos or sounds, as today; `list` marks a ComfyUI
 *            output list (is_output_list): the next node runs once per item
 *   mask     ComfyUI MASK values, one 16-bit greyscale PNG per frame (./pictures/mask.ts)
 *   text     a STRING (and a Moodboard's taste)
 *   number   an INT (`int`) or a FLOAT
 *   boolean  a BOOLEAN
 *   json     a STRING holding JSON, exactly as the Python node prints it
 *   glb      a 3D model address, and Sailor's saved copy when there is one
 */
export type RunnerValue =
  | { kind: 'files'; files: OutputFile[]; list?: true }
  | { kind: 'mask'; files: OutputFile[] }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; int: boolean }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'json'; text: string }
  | { kind: 'glb'; url: string; file: OutputFile | null }
```

In `NodeRecord`, after `slotOutputs`:

```ts
  /**
   * What each output slot hands on (R0). Absent on records written before
   * step 3, and on nodes that only make files the old way: every slot then
   * reads `outputs` (or `slotOutputs`). When present, `outputs` lists every
   * file the values name (records, Gate choices and Assets read it).
   */
  values?: Record<number, RunnerValue>
```

- [ ] **Step 4: Write `values.ts`**

```ts
// frontend/server/runner/values.ts
/**
 * A runner node's results per output slot (R0, step 3). The one place that
 * says how a slot is read, which files a value names, and what a wired
 * value looks like to the node that reads it.
 */
import type { NodeRecord, OutputFile, RunnerValue } from './types'

/** The most characters one text value may carry (a long transcript fits; a run record stays small). */
export const MAX_VALUE_TEXT_CHARS = 262_144
export const VALUE_TOO_LONG = 'This text is too long to pass on (over 262,144 characters)'
export const VALUE_NOT_FINITE = 'This number can’t be passed on (it isn’t a finite number)'

/**
 * What a link to (this record, slot) reads. A record without values reads
 * as before R0: a later slot of a node that keeps per-slot files reads
 * those (the Frame's protect_mask), every other slot reads `outputs`.
 */
export function slotValue(rec: NodeRecord | undefined, slot: number): RunnerValue | undefined {
  if (!rec) return undefined
  if (rec.values) return Object.prototype.hasOwnProperty.call(rec.values, slot) ? rec.values[slot] : undefined
  if (slot > 0 && rec.slotOutputs) return { kind: 'files', files: rec.slotOutputs[slot] ?? [] }
  return { kind: 'files', files: rec.outputs }
}

/** The files a value names (none for text, numbers, booleans and JSON). */
export function filesOf(v: RunnerValue | undefined): OutputFile[] {
  if (!v) return []
  switch (v.kind) {
    case 'files':
    case 'mask':
      return v.files
    case 'glb':
      return v.file ? [v.file] : []
    default:
      return []
  }
}

const fileKey = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** Every file named across a node's values, once, in slot order. */
export function filesOfValues(values: Record<number, RunnerValue>): OutputFile[] {
  const seen = new Map<string, OutputFile>()
  for (const slot of Object.keys(values).map(Number).sort((a, b) => a - b)) {
    for (const f of filesOf(values[slot])) if (!seen.has(fileKey(f))) seen.set(fileKey(f), f)
  }
  return [...seen.values()]
}

export type Literal = string | number | boolean

/** The value as a typed widget would hold it, or undefined for files and masks (which stay wires). */
export function literalOf(v: RunnerValue | undefined): Literal | undefined {
  switch (v?.kind) {
    case 'text': return v.text
    case 'number': return v.value
    case 'boolean': return v.value
    case 'json': return v.text
    case 'glb': return v.url
    default: return undefined
  }
}

/** Throws the plain refusal for a value the runner can't keep or pass on. */
export function checkValue(v: RunnerValue): void {
  const text = v.kind === 'text' || v.kind === 'json' ? v.text : v.kind === 'glb' ? v.url : null
  if (text !== null && text.length > MAX_VALUE_TEXT_CHARS) throw new Error(VALUE_TOO_LONG)
  if (v.kind === 'number' && !Number.isFinite(v.value)) throw new Error(VALUE_NOT_FINITE)
}
```

- [ ] **Step 5: Build `filesAt` on values in the engine**

In `engine.ts`, replace `filesAt` (:276-290) with:

```ts
/** What a link reads: the source node's value on that slot (values.ts slotValue; pre-R0 records read as before). */
function valueAt(take: TakeRecord): (link: [string, number]) => RunnerValue | undefined {
  return ([from, slot]) => slotValue(take.nodes[from], slot)
}

/**
 * The files a link reads: the node's outputs, or for a later output slot of a
 * node that keeps one (the Frame's protect_mask, `slotOutputs`) that slot's
 * files; for a node with values, the files its value on that slot names.
 */
function filesAt(take: TakeRecord): (link: [string, number]) => OutputFile[] {
  const at = valueAt(take)
  return link => filesOf(at(link))
}
```

Add the imports: `import { filesOf, slotValue } from './values'` and `RunnerValue` to the `./types` import.

- [ ] **Step 6: Run the new test and the whole runner suite**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values.unit.spec.ts tests/unit/runner-`
Expected: PASS, every existing runner test unchanged.

- [ ] **Step 7: Typecheck and report**

Run the server typecheck from Global Constraints. Report to the controller (no commit).

---

### Task R0.2: Kept bytes, and one file reader

Bytes the runner makes itself (a mask, a picture converted the way Python loads it) are kept per run by sha256, beside the run store — never in ComfyUI's temp folder, which ComfyUI empties at every start and exit. One file reader serves both store files and kept bytes, so the hand-off, the Frame and every check read kept bytes without knowing.

**Files:**
- Create: `frontend/server/runner/keptBytes.ts`
- Create: `frontend/server/runner/fileAccess.ts`
- Modify: `frontend/server/runner/engine.ts` (EngineDeps :124-162; every `deps.results.read`, `deps.results.exists`, `deps.results.size` use; `reattach` :1540-1560)
- Modify: `frontend/server/runner/index.ts:99` (wire the file store)
- Test: `frontend/tests/unit/runner-kept-bytes.unit.spec.ts`

**Interfaces:**
- Consumes: `OutputFile` with `type: 'kept'` (R0.1).
- Produces:
  - `type KeptExt = 'png' | 'glb' | 'json' | 'bin'`
  - `interface KeptBytes { put(runId, bytes, ext): Promise<OutputFile>; read(file): Promise<Uint8Array>; exists(file): Promise<boolean>; size(file): Promise<number | null>; keepOnly(runIds): Promise<void> }`
  - `KEPT_GONE` (the plain error), `createFileKeptBytes(dir)`, `createMemoryKeptBytes()`
  - `interface FileAccess { read; exists; size }`, `createFileAccess(results, kept)`
  - `EngineDeps.kept?: KeptBytes` (default: in memory)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-kept-bytes.unit.spec.ts
/**
 * R0.2: bytes the runner makes itself, kept per run by their sha256, and the
 * one reader that serves them beside the store's files.
 */
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEPT_GONE, createFileKeptBytes, createMemoryKeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess } from '~~/server/runner/fileAccess'
import { createEngineResultStore } from '~~/server/runner/results'
import { sha256Hex } from '~~/server/runner/handoff'

const RUN = 'run_00000000-0000-4000-8000-000000000001'
const bytes = new TextEncoder().encode('a picture')

describe('createFileKeptBytes', () => {
  it('keeps bytes once by their sha256, under the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const a = await kept.put(RUN, bytes, 'png')
    const b = await kept.put(RUN, bytes, 'png')
    expect(a).toEqual({ filename: `${sha256Hex(bytes)}.png`, subfolder: RUN, type: 'kept' })
    expect(b).toEqual(a)
    expect(readdirSync(join(dir, RUN))).toEqual([`${sha256Hex(bytes)}.png`])
    expect(await kept.read(a)).toEqual(bytes)
    expect(await kept.exists(a)).toBe(true)
    expect(await kept.size(a)).toBe(bytes.length)
  })
  it('says plainly when kept bytes are gone or no longer match their name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const a = await kept.put(RUN, bytes, 'png')
    writeFileSync(join(dir, RUN, a.filename), 'tampered')
    await expect(kept.read(a)).rejects.toThrow(KEPT_GONE)
    await expect(kept.read({ ...a, filename: `${'0'.repeat(64)}.png` })).rejects.toThrow(KEPT_GONE)
    expect(await kept.exists({ ...a, filename: `${'0'.repeat(64)}.png` })).toBe(false)
  })
  it('refuses names that are not a kept name, and runs that are not a run id', async () => {
    const kept = createFileKeptBytes(mkdtempSync(join(tmpdir(), 'kept-')))
    await expect(kept.put('../x', bytes, 'png')).rejects.toThrow()
    await expect(kept.read({ filename: '../a.png', subfolder: RUN, type: 'kept' })).rejects.toThrow(KEPT_GONE)
    await expect(kept.read({ filename: `${sha256Hex(bytes)}.png`, subfolder: '..', type: 'kept' })).rejects.toThrow(KEPT_GONE)
  })
  it('lets go of runs no longer in progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const other = 'run_00000000-0000-4000-8000-000000000002'
    await kept.put(RUN, bytes, 'png')
    await kept.put(other, bytes, 'png')
    await kept.keepOnly(new Set([RUN]))
    expect(readdirSync(dir)).toEqual([RUN])
  })
  it('works the same in memory', async () => {
    const kept = createMemoryKeptBytes()
    const a = await kept.put(RUN, bytes, 'glb')
    expect(a.filename).toBe(`${sha256Hex(bytes)}.glb`)
    expect(await kept.read(a)).toEqual(bytes)
    await kept.keepOnly(new Set())
    await expect(kept.read(a)).rejects.toThrow(KEPT_GONE)
  })
})

describe('createFileAccess', () => {
  it('reads kept bytes from the kept store and every other file from the result store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'root-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t))
    writeFileSync(join(root, 'input', 'a.png'), 'input bytes')
    const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => false })
    const kept = createMemoryKeptBytes()
    const files = createFileAccess(results, kept)
    const k = await kept.put(RUN, bytes, 'png')
    expect(await files.read(k)).toEqual(bytes)
    expect(new TextDecoder().decode(await files.read({ filename: 'a.png', subfolder: '', type: 'input' }))).toBe('input bytes')
    expect(await files.exists(k)).toBe(true)
    expect(await files.size({ filename: 'a.png', subfolder: '', type: 'input' })).toBe(11)
    expect(await files.size({ filename: 'nope.png', subfolder: '', type: 'input' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-kept-bytes.unit.spec.ts`
Expected: FAIL, cannot resolve `~~/server/runner/keptBytes`.

- [ ] **Step 3: Write `keptBytes.ts`**

```ts
// frontend/server/runner/keptBytes.ts
/**
 * Bytes the runner makes itself and hands between nodes (R0, step 3 spec):
 * a mask, a picture converted the way a Python loader sees it. Kept per run,
 * named by the sha256 of the bytes, so the same bytes are kept once and a
 * restarted server reads exactly what was made. They live beside the run
 * store (never ComfyUI's temp folder, which ComfyUI empties at every start
 * and exit), are not assets, and are never served by /view.
 *
 * Let go at server start for runs no longer in progress (as ./heldBytes.ts).
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRunId } from './store'
import { sha256Hex } from './handoff'
import type { OutputFile } from './types'

export type KeptExt = 'png' | 'glb' | 'json' | 'bin'

export const KEPT_GONE = 'A result this step needs is gone. Run the workflow again.'

const KEPT_NAME_RE = /^([0-9a-f]{64})\.(png|glb|json|bin)$/

export interface KeptBytes {
  /** Keeps `bytes` for the run; the same bytes give the same file. */
  put(runId: string, bytes: Uint8Array, ext: KeptExt): Promise<OutputFile>
  /** The kept bytes, checked against their name; KEPT_GONE when missing or changed. */
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
  /** Lets go of every run not in this set. */
  keepOnly(runIds: ReadonlySet<string>): Promise<void>
}

/** The kept file's sha, or null when the file isn't a well-formed kept name. */
function shaOf(file: OutputFile): string | null {
  if (file.type !== 'kept' || !isRunId(file.subfolder)) return null
  const m = KEPT_NAME_RE.exec(file.filename)
  return m ? m[1]! : null
}

function keptFile(runId: string, bytes: Uint8Array, ext: KeptExt): OutputFile {
  if (!isRunId(runId)) throw new Error('Kept bytes need a run id')
  return { filename: `${sha256Hex(bytes)}.${ext}`, subfolder: runId, type: 'kept' }
}

export function createFileKeptBytes(dir: string): KeptBytes {
  const pathOf = (f: OutputFile) => join(dir, f.subfolder, f.filename)
  return {
    async put(runId, bytes, ext) {
      const file = keptFile(runId, bytes, ext)
      const d = join(dir, runId)
      await mkdir(d, { recursive: true })
      const tmp = join(d, `${file.filename}.${process.pid}.tmp`)
      await writeFile(tmp, bytes)
      await rename(tmp, pathOf(file))
      return file
    },
    async read(file) {
      const sha = shaOf(file)
      if (!sha) throw new Error(KEPT_GONE)
      let b: Uint8Array
      try { b = new Uint8Array(await readFile(pathOf(file))) }
      catch { throw new Error(KEPT_GONE) }
      if (sha256Hex(b) !== sha) throw new Error(KEPT_GONE)
      return b
    },
    async exists(file) {
      if (!shaOf(file)) return false
      try { return (await stat(pathOf(file))).isFile() }
      catch { return false }
    },
    async size(file) {
      if (!shaOf(file)) return null
      try {
        const st = await stat(pathOf(file))
        return st.isFile() ? st.size : null
      }
      catch { return null }
    },
    async keepOnly(runIds) {
      let names: string[] = []
      try { names = await readdir(dir) }
      catch { return }
      for (const n of names) if (!runIds.has(n) && isRunId(n)) await rm(join(dir, n), { recursive: true, force: true })
    },
  }
}

/** In memory: for an engine built without a kept store (tests). */
export function createMemoryKeptBytes(): KeptBytes {
  const m = new Map<string, Uint8Array>()
  const key = (f: OutputFile) => `${f.subfolder}/${f.filename}`
  return {
    async put(runId, bytes, ext) {
      const file = keptFile(runId, bytes, ext)
      m.set(key(file), bytes.slice())
      return file
    },
    async read(file) {
      const b = shaOf(file) ? m.get(key(file)) : undefined
      if (!b) throw new Error(KEPT_GONE)
      return b
    },
    async exists(file) { return !!shaOf(file) && m.has(key(file)) },
    async size(file) { return (shaOf(file) && m.get(key(file))?.length) ?? null },
    async keepOnly(runIds) {
      for (const k of [...m.keys()]) if (!runIds.has(k.split('/')[0]!)) m.delete(k)
    },
  }
}
```

- [ ] **Step 4: Write `fileAccess.ts`**

```ts
// frontend/server/runner/fileAccess.ts
/**
 * One reader for every file a run touches: kept bytes from ./keptBytes.ts,
 * everything else from the result store. The engine reads, checks and sizes
 * files only through this, so a node never needs to know where a file lives.
 */
import type { KeptBytes } from './keptBytes'
import type { ResultStore } from './results'
import type { OutputFile } from './types'

export interface FileAccess {
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
}

export function createFileAccess(results: ResultStore, kept: KeptBytes): FileAccess {
  return {
    read: f => f.type === 'kept' ? kept.read(f) : results.read(f),
    exists: f => f.type === 'kept' ? kept.exists(f) : results.exists(f),
    size: f => f.type === 'kept' ? kept.size(f) : (results.size?.(f) ?? Promise.resolve(null)),
  }
}
```

- [ ] **Step 5: Use it in the engine**

In `EngineDeps` add:

```ts
  /** Bytes the runner makes itself (./keptBytes.ts). Absent: kept in memory (tests). */
  kept?: KeptBytes
```

In `createEngine`, next to `const held = …` (:405):

```ts
  const kept = deps.kept ?? createMemoryKeptBytes()
  const files = createFileAccess(deps.results, kept)
```

Replace every `deps.results.read(` with `files.read(`, every `deps.results.exists(` with `files.exists(`, and every `deps.results.size?.(f) ?? Promise.resolve(null)` with `files.size(f)` in `engine.ts` (the node's `readOnce`, the reuse check, `linkedFileCheck`, `nodeMediaCheck`, and the start-of-run reads). `deps.results.save` and `saveLivePreview` stay as they are. In `reattach`, after the held sweep:

```ts
    await kept.keepOnly(new Set(active.map(r => r.id))).catch(e => deps.reportError(e, { site: 'runner.kept.sweep' }))
```

In `index.ts`, next to `held:`:

```ts
    // Bytes the runner makes itself (keptBytes.ts), beside the run store.
    kept: createFileKeptBytes(join(storeDir('data'), 'runner-kept')),
```

- [ ] **Step 6: Run the new test and the runner suite**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-kept-bytes.unit.spec.ts tests/unit/runner-`
Expected: PASS, every existing runner test unchanged.

- [ ] **Step 7: Typecheck and report** (no commit).

---

### Task R0.3: Which wires may carry values (shared)

The shared rule for value wires: what each class's output slots carry, which inputs take a value and of which kind, and the values a card's own settings decide. Browser and server read it. Adds the `cards` family. No class produces a value yet, so nothing is taken that wasn't before.

**Files:**
- Create: `frontend/shared/runner/values.ts`
- Create: `frontend/shared/runner/staticValues.ts`
- Modify: `frontend/shared/runner/families.ts` (the union :9-86, `RUNNER_FAMILIES` :88)
- Modify: `frontend/shared/runner/eligibility.ts` (`RunnerNodeRule` :25-110; `nodeRuleAllows` :372-404; `runnerTakesNode` :594-613)
- Test: `frontend/tests/unit/runner-value-wires.unit.spec.ts`

**Interfaces:**
- Consumes: `ApiPrompt`, `isLink`, `linksOf`, `GATE_CLASS` (graph.ts).
- Produces:
  - `type ValueKind = 'files' | 'mask' | 'text' | 'number' | 'boolean' | 'json' | 'glb'`; `VALUE_KINDS_ALL: readonly ValueKind[]` (every kind but files)
  - `OUTPUT_KINDS: Record<class, Record<slot, ValueKind>>` (empty now; R0.4 and R1 add rows); `outputKind(prompt, link, kinds = OUTPUT_KINDS): ValueKind`
  - `BASE_VALUE_INPUTS: Record<class, Record<input, readonly ValueKind[]>>` (the Gate's `data_in`)
  - eligibility.ts: `RunnerNodeRule.valueInputs?`, `valueInputsOf(classType)`, `valueWiresAllowed(prompt, id, kinds = OUTPUT_KINDS): boolean`
  - `type StaticValue`, `type StaticEvaluator`, `STATIC_VALUES` (empty now), `staticValueOf(prompt, link, table = STATIC_VALUES)`, `staticWiredTexts(prompt, table = STATIC_VALUES): string[]`
  - `RunnerFamily` gains `'cards'`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-value-wires.unit.spec.ts
/**
 * R0.3: which wires may carry a value into which inputs, read by the browser
 * and the server alike. The output-kind and evaluator tables are passed in
 * here, so this is proven before any class produces a value.
 */
import { describe, expect, it } from 'vitest'
import { outputKind, type ValueKind } from '#shared/runner/values'
import { valueWiresAllowed, runnerTakesNode, isRunnerEligible } from '#shared/runner/eligibility'
import { staticValueOf, staticWiredTexts, type StaticEvaluator } from '#shared/runner/staticValues'
import { RUNNER_FAMILIES, parseFamilies } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'

const KINDS: Record<string, Record<number, ValueKind>> = { FakeText: { 0: 'text' }, FakeTwo: { 0: 'files', 1: 'mask' } }

describe('outputKind', () => {
  const p: ApiPrompt = {
    t: { class_type: 'FakeText', inputs: {} },
    g: { class_type: 'ComfyGateNode', inputs: { data_in: ['t', 0], bypass: true } },
    two: { class_type: 'FakeTwo', inputs: {} },
    img: { class_type: 'GenerateImageNode', inputs: {} },
  }
  it('reads the kind a class declares for the slot, files by default', () => {
    expect(outputKind(p, ['t', 0], KINDS)).toBe('text')
    expect(outputKind(p, ['two', 1], KINDS)).toBe('mask')
    expect(outputKind(p, ['two', 0], KINDS)).toBe('files')
    expect(outputKind(p, ['img', 0], KINDS)).toBe('files')
  })
  it('follows a Gate back to what reaches it', () => {
    expect(outputKind(p, ['g', 0], KINDS)).toBe('text')
  })
  it('is files for a node outside the prompt', () => {
    expect(outputKind(p, ['nope', 0], KINDS)).toBe('files')
  })
})

describe('valueWiresAllowed', () => {
  it('lets a value through a Gate', () => {
    const p: ApiPrompt = {
      t: { class_type: 'FakeText', inputs: {} },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['t', 0] } },
    }
    expect(valueWiresAllowed(p, 'g', KINDS)).toBe(true)
  })
  it('refuses a value wired into an input that takes none', () => {
    const p: ApiPrompt = {
      t: { class_type: 'FakeText', inputs: {} },
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: ['t', 0] } },
    }
    expect(valueWiresAllowed(p, 'v', KINDS)).toBe(false)
  })
  it('leaves file wires as they were', () => {
    const p: ApiPrompt = {
      i: { class_type: 'GenerateImageNode', inputs: {} },
      c: { class_type: 'Image', inputs: { images: ['i', 0] } },
    }
    expect(valueWiresAllowed(p, 'c', KINDS)).toBe(true)
  })
})

describe('staticValueOf', () => {
  const table: Record<string, StaticEvaluator> = {
    FakeText: (inputs, at) => {
      const own = typeof inputs.text === 'string' ? inputs.text : ''
      if (own) return { kind: 'text', text: own }
      const src = inputs.source
      if (Array.isArray(src)) return at(src as [string, number])
      return { kind: 'text', text: typeof src === 'string' ? src : '' }
    },
  }
  const p: ApiPrompt = {
    a: { class_type: 'FakeText', inputs: { text: 'hello' } },
    b: { class_type: 'FakeText', inputs: { text: '', source: ['a', 0] } },
    c: { class_type: 'FakeText', inputs: { text: '', source: ['x', 0] } },
    x: { class_type: 'GenerateImageNode', inputs: {} },
    loop: { class_type: 'FakeText', inputs: { text: '', source: ['loop', 0] } },
  }
  it('computes a card value from its own settings, following static cards', () => {
    expect(staticValueOf(p, ['a', 0], table)).toEqual({ kind: 'text', text: 'hello' })
    expect(staticValueOf(p, ['b', 0], table)).toEqual({ kind: 'text', text: 'hello' })
  })
  it('knows nothing of a value a non-card makes, or of a loop', () => {
    expect(staticValueOf(p, ['c', 0], table)).toBeUndefined()
    expect(staticValueOf(p, ['loop', 0], table)).toBeUndefined()
  })
  it('lists the static texts wired into any input, for moderation', () => {
    const q: ApiPrompt = {
      a: { class_type: 'FakeText', inputs: { text: 'a fox' } },
      g: { class_type: 'GenerateImageNode', inputs: { prompt_in: ['a', 0] } },
      h: { class_type: 'GenerateImageNode', inputs: { prompt_in: ['a', 0] } },
    }
    expect(staticWiredTexts(q, table)).toEqual(['a fox'])
  })
})

describe('the cards family', () => {
  it('exists and is off unless named', () => {
    expect(RUNNER_FAMILIES).toContain('cards')
    expect(parseFamilies('cards').has('cards')).toBe(true)
    expect(parseFamilies('').size).toBe(0)
  })
})

describe('nothing produces a value yet', () => {
  it('leaves today’s workflows exactly as they were taken', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    expect(isRunnerEligible(p)).toBe(true)
    expect(runnerTakesNode(p, '2')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run tests/unit/runner-value-wires.unit.spec.ts`
Expected: FAIL, cannot resolve `#shared/runner/values`.

- [ ] **Step 3: Write `shared/runner/values.ts`**

```ts
// frontend/shared/runner/values.ts
/**
 * What each runner class's output slots carry (R0, step 3 spec), read by the
 * browser (routing, the needs-the-engine names) and the server (the runner).
 * A class not listed carries files on every slot, as before step 3.
 * Keep this file free of imports but ./graph.
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from './graph'

export type ValueKind = 'files' | 'mask' | 'text' | 'number' | 'boolean' | 'json' | 'glb'

/** Every kind a wire can carry that is not files. */
export const VALUE_KINDS_ALL: readonly ValueKind[] = ['mask', 'text', 'number', 'boolean', 'json', 'glb']

/** Output slots that carry something other than files, by class. Rows are added by the cards (R0.4, R1). */
export const OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = {}

/** What a wire carries: the source's declared kind for that slot (through Gates), files by default. */
export function outputKind(
  prompt: ApiPrompt, link: ApiLink,
  kinds: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = OUTPUT_KINDS,
  depth = 0,
): ValueKind {
  const node = prompt[link[0]]
  if (!node || depth > 64) return 'files'
  if (node.class_type === GATE_CLASS) {
    const d = node.inputs?.data_in
    return isLink(d) ? outputKind(prompt, d, kinds, depth + 1) : 'files'
  }
  const row = Object.prototype.hasOwnProperty.call(kinds, node.class_type) ? kinds[node.class_type] : undefined
  return row && Object.prototype.hasOwnProperty.call(row, link[1]) ? row[link[1]]! : 'files'
}

/**
 * Value inputs of the runner's own node types that have no rule row (the
 * Gate): a Gate hands on whatever reaches it.
 */
export const BASE_VALUE_INPUTS: Readonly<Record<string, Readonly<Record<string, readonly ValueKind[]>>>> = {
  [GATE_CLASS]: { data_in: VALUE_KINDS_ALL },
}
```

- [ ] **Step 4: Add the family**

In `families.ts`, add to the `RunnerFamily` union (after `'topaz-video'`):

```ts
  /**
   * The text and data cards (step 3, R0/R1): Primitive, Text, Moodboard,
   * Model3D, the bake-replay cards, LoadImage outside the Frame, Empty image,
   * Get image size, Image to mask, Save image, Preview image, Smart Layout.
   * Computed by the runner itself, free. Off: the runner takes exactly what
   * it took before step 3.
   */
  | 'cards'
```

and append `'cards'` to `RUNNER_FAMILIES`.

- [ ] **Step 5: Teach eligibility about value wires**

In `eligibility.ts`, import `outputKind, BASE_VALUE_INPUTS, OUTPUT_KINDS, type ValueKind` from `./values`. Add to `RunnerNodeRule`:

```ts
  /**
   * Inputs that take a value wire (R0), and of which kinds. Such an input is
   * exempt from `mustNotLink` when the wire carries one of these kinds: the
   * engine hands the node the value as if it were typed. A wire of any other
   * kind into it (files, or an unknown source) is refused.
   */
  valueInputs?: Readonly<Record<string, readonly ValueKind[]>>
```

In `nodeRuleAllows`, change the `mustNotLink` line to skip value inputs (their wires are judged by `valueWiresAllowed`, which sees the prompt):

```ts
  if ((rule.mustNotLink ?? []).some(name => isLink(inputs[name]) && !rule.valueInputs?.[name])) return false
```

Add below `graphRuleAllows`:

```ts
/** The inputs of a class that take a value wire: its rule row's, else the base table's (the Gate). */
export function valueInputsOf(classType: string): Readonly<Record<string, readonly ValueKind[]>> {
  const rule = Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType) ? RUNNER_NODE_RULES[classType] : undefined
  return rule?.valueInputs ?? (Object.prototype.hasOwnProperty.call(BASE_VALUE_INPUTS, classType) ? BASE_VALUE_INPUTS[classType]! : {})
}

/**
 * Whether every wire into this node carries what the input takes: a value
 * only into an input listed for that kind; into a listed value input,
 * nothing but a value of a listed kind. File wires elsewhere are unchanged.
 */
export function valueWiresAllowed(
  prompt: ApiPrompt, id: string,
  kinds: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = OUTPUT_KINDS,
): boolean {
  const node = prompt[id]
  if (!node) return false
  const takes = valueInputsOf(node.class_type)
  for (const l of linksOf(node)) {
    const kind = outputKind(prompt, [l.from, l.slot], kinds)
    const allowed = Object.prototype.hasOwnProperty.call(takes, l.input) ? takes[l.input] : undefined
    if (kind === 'files') {
      if (allowed) return false
      continue
    }
    if (!allowed?.includes(kind)) return false
  }
  return true
}
```

In `runnerTakesNode`, just before the final `return true`:

```ts
  if (!valueWiresAllowed(prompt, id)) return false
```

- [ ] **Step 6: Write `shared/runner/staticValues.ts`**

```ts
// frontend/shared/runner/staticValues.ts
/**
 * Values a card's own settings decide (R0, step 3 spec): a Primitive's value,
 * a Text card's typed text, a Moodboard's style block. Computed from the
 * workflow without running it, for two readers:
 *   - the start of a run: every such text wired into a node is moderated
 *     before anything is held;
 *   - the card's own plan (server/runner/executors.ts): the card's value is
 *     this evaluator run over its inputs at its turn (a wired source already
 *     substituted), so there is one implementation.
 * An evaluator receives the card's inputs (a wire may still be a link here)
 * and `at`, which evaluates a linked card. A value some other node makes is
 * unknown (undefined).
 */
import { isLink, type ApiLink, type ApiPrompt } from './graph'

export type StaticValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; int: boolean }
  | { kind: 'boolean'; value: boolean }

export type StaticEvaluator = (
  inputs: Record<string, unknown>,
  at: (link: ApiLink) => StaticValue | undefined,
  slot: number,
) => StaticValue | undefined

/** One evaluator per card class. Rows are added by the cards (R0.4, R1.1). */
export const STATIC_VALUES: Record<string, StaticEvaluator> = {}

export function staticValueOf(
  prompt: ApiPrompt, link: ApiLink,
  table: Readonly<Record<string, StaticEvaluator>> = STATIC_VALUES,
  seen: ReadonlySet<string> = new Set(),
): StaticValue | undefined {
  const [id, slot] = link
  const node = prompt[id]
  if (!node || seen.has(id)) return undefined
  const ev = Object.prototype.hasOwnProperty.call(table, node.class_type) ? table[node.class_type] : undefined
  if (!ev) return undefined
  const next = new Set(seen).add(id)
  return ev(node.inputs ?? {}, l => staticValueOf(prompt, l, table, next), slot)
}

/** Every non-blank static text wired into an input that takes text, once each (for moderation at the start). */
export function staticWiredTexts(prompt: ApiPrompt, table: Readonly<Record<string, StaticEvaluator>> = STATIC_VALUES): string[] {
  const out = new Set<string>()
  for (const node of Object.values(prompt)) {
    for (const v of Object.values(node.inputs ?? {})) {
      if (!isLink(v)) continue
      const known = staticValueOf(prompt, v, table)
      if (known?.kind === 'text' && known.text.trim()) out.add(known.text)
    }
  }
  return [...out]
}
```

Note for the implementer: `staticWiredTexts` deliberately collects every wired static text, not only text inputs of paid nodes: moderating a harmless extra string costs nothing, missing one would.

- [ ] **Step 7: Run the new test, the eligibility tests and the runner suite**

Run: `cd frontend && npx vitest run tests/unit/runner-value-wires.unit.spec.ts tests/unit/runner-`
Expected: PASS; `runner-eligibility`, `runner-validate-prompt`, `runner-families` unchanged and green.

- [ ] **Step 8: Typecheck and report** (no commit).

---

### Task R0.4: The engine hands values on (derive plans, wired values, Gates, Primitive cards)

The engine learns a new plan kind, `derive` (computed here, no provider, no charge), writes values into the record, substitutes wired values into a node's inputs at its turn, and lets values through Gates. The first producers are the five Primitive cards; the first reader is Generate an image's `prompt_in` (the idea socket). Everything is behind `cards`.

**Files:**
- Modify: `frontend/server/runner/executors.ts` (NodePlan :113-128; PlanContext :130-172; the Gate case :804-808; add the Primitive cases)
- Modify: `frontend/server/runner/values.ts` (add `withWiredValues`)
- Modify: `frontend/server/runner/engine.ts` (execNode :818 onward: planning and the plan kinds)
- Modify: `frontend/shared/runner/eligibility.ts` (rows for the Primitives; `GenerateImageNode.valueInputs`; `SWITCHED_CLASSES`)
- Modify: `frontend/shared/runner/values.ts` (`OUTPUT_KINDS` rows), `frontend/shared/runner/staticValues.ts` (`STATIC_VALUES` rows)
- Test: `frontend/tests/unit/runner-values-engine.unit.spec.ts`

**Interfaces:**
- Consumes: R0.1 (`RunnerValue`, `slotValue`, `filesOf`, `filesOfValues`, `literalOf`, `checkValue`), R0.2 (`kept`, `files`), R0.3 (`outputKind`, `valueInputs`, `STATIC_VALUES`, `staticValueOf`, family `cards`).
- Produces:
  - executors.ts: `interface DeriveIO { read(file): Promise<Uint8Array>; keep(bytes, ext: KeptExt): Promise<OutputFile>; saveAsset(bytes, o: { prefix: string; ext: string }): Promise<OutputFile>; savePreview(bytes, o: { nodeId?: string }): Promise<OutputFile>; hosted: boolean; signal: AbortSignal; nodeId: string; runWorkflow: unknown }`; `interface Derived { values: Record<number, RunnerValue>; ui: Record<string, unknown> | null }`; NodePlan `{ kind: 'derive'; derive(io: DeriveIO): Promise<Derived> }`; `PlanContext.valueFrom?(link): RunnerValue | undefined`; `staticDerive(ctx): NodePlan` (a card whose value is its static evaluator)
  - values.ts: `WIRED_VALUE_MISSING`, `withWiredValues(prompt, nodeId, valueAt): { prompt: ApiPrompt; injected: { input: string; text: string }[] }`
  - `PRIMITIVE_CLASSES` (eligibility.ts)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-values-engine.unit.spec.ts
/**
 * R0.4: the engine hands values on. A Primitive card's value reaches Generate
 * an image's idea socket as if typed; a Gate lets it through; the value is
 * saved with the run; the price reads the wire as sent; with `cards` off
 * nothing changes.
 */
import { describe, expect, it } from 'vitest'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { withWiredValues, WIRED_VALUE_MISSING } from '~~/server/runner/values'
import type { RunnerFamily } from '#shared/runner/families'

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const idea = (via: 'direct' | 'gate', value: unknown = 'a watercolour'): ApiPrompt => ({
  p: { class_type: 'PrimitiveString', inputs: { value } },
  ...(via === 'gate' ? { g: { class_type: 'ComfyGateNode', inputs: { data_in: ['p', 0], bypass: true } } } : {}),
  '1': {
    class_type: 'GenerateImageNode',
    inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}', prompt_in: [via === 'gate' ? 'g' : 'p', 0] },
  },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})

describe('eligibility', () => {
  it('takes a Primitive and its wire into the idea socket only with cards on', () => {
    expect(isRunnerEligible(idea('direct'))).toBe(false)
    expect(isRunnerEligible(idea('direct'), CARDS)).toBe(true)
    expect(isRunnerEligible(idea('gate'), CARDS)).toBe(true)
  })
  it('leaves a Primitive wired into an input that takes no value to the engine', () => {
    const p = idea('direct')
    p['1']!.inputs.aspect_ratio = ['p', 0]
    expect(runnerTakesNode(p, '1', CARDS)).toBe(false)
  })
  it('leaves a Primitive whose value ComfyUI would refuse (a wired value) to the engine', () => {
    const p = idea('direct')
    p.p!.inputs.value = ['x', 0]
    expect(runnerTakesNode(p, 'p', CARDS)).toBe(false)
  })
})

describe('withWiredValues', () => {
  it('replaces value wires by their literal and leaves file wires', () => {
    const p = idea('direct')
    const r = withWiredValues(p, '1', link => link[0] === 'p' ? { kind: 'text', text: 'a watercolour' } : undefined)
    expect(r.prompt['1']!.inputs.prompt_in).toBe('a watercolour')
    expect(r.injected).toEqual([{ input: 'prompt_in', text: 'a watercolour' }])
    expect(p['1']!.inputs.prompt_in).toEqual(['p', 0]) // the original is untouched
    const s = withWiredValues(p, '2', () => ({ kind: 'files', files: [] }))
    expect(s.prompt).toBe(p)
  })
  it('refuses to plan a node whose value never arrived (never sent blank)', () => {
    expect(() => withWiredValues(idea('direct'), '1', () => undefined)).toThrow(WIRED_VALUE_MISSING)
  })
})

describe('the engine', () => {
  it('sends the idea as if typed, keeps the value, and prices the wire as sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [idea('direct')], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const sent = k.fal.submitted()[0]!
    expect(sent.payload.prompt).toBe('a watercolour a red fox')
    expect(run.takes[0]!.nodes.p!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
    expect(run.takes[0]!.nodes.p!.credits).toBe(0)
    // The take keeps the workflow as sent: the wire, not the value.
    expect(run.takes[0]!.prompt['1']!.inputs.prompt_in).toEqual(['p', 0])
  })
  it('lets the value through a Gate on pass-through', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [idea('gate')], ...START })
    await k.engine.settled(runId)
    expect(k.fal.submitted()[0]!.payload.prompt).toBe('a watercolour a red fox')
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.g!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
  })
  it('makes numbers and booleans from the other Primitives as ComfyUI converts them', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = {
      ...idea('direct'),
      i: { class_type: 'PrimitiveInt', inputs: { value: '42' } },
      f: { class_type: 'PrimitiveFloat', inputs: { value: 1.5 } },
      b: { class_type: 'PrimitiveBoolean', inputs: { value: true } },
    }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.i!.values).toEqual({ 0: { kind: 'number', value: 42, int: true } })
    expect(nodes.f!.values).toEqual({ 0: { kind: 'number', value: 1.5, int: false } })
    expect(nodes.b!.values).toEqual({ 0: { kind: 'boolean', value: true } })
  })
  it('refuses a workflow with a Primitive when cards is off, as before', async () => {
    const k = makeKit({ hosted: false })
    await expect(k.engine.startRun({ userId: null, takes: [idea('direct')], ...START })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values-engine.unit.spec.ts`
Expected: FAIL (`withWiredValues` missing; the Primitive rows missing).

- [ ] **Step 3: Rows, kinds and evaluators for the Primitives**

In `eligibility.ts`, add to `RUNNER_NODE_RULES` (a new section after `EnhanceVideoNode`):

```ts
  // ── cards (step 3, R0.4): the Primitive cards (comfy_extras/nodes_primitive.py) ──
  // Each hands on its `value`, converted as ComfyUI's validate_inputs converts
  // a widget (int(), float(), str(), bool()). A value ComfyUI would refuse
  // (out of range, unconvertible, wired) leaves the node to the engine.
  PrimitiveString: { family: 'cards', local: 'source', widgets: { value: { type: 'STRING', required: true } } },
  PrimitiveStringMultiline: { family: 'cards', local: 'source', widgets: { value: { type: 'STRING', required: true } } },
  // -sys.maxsize..sys.maxsize, narrowed to what a JS number holds exactly.
  PrimitiveInt: { family: 'cards', local: 'source', widgets: { value: { type: 'INT', required: true, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } } },
  PrimitiveFloat: { family: 'cards', local: 'source', widgets: { value: { type: 'FLOAT', required: true, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } } },
  PrimitiveBoolean: { family: 'cards', local: 'source', widgets: { value: { type: 'BOOLEAN', required: true } } },
```

and to the `GenerateImageNode` row:

```ts
    // R0.4: the idea socket takes a text wire (a card's value arrives as if typed).
    valueInputs: { prompt_in: ['text'] },
```

Export `PRIMITIVE_CLASSES` and add the five to `SWITCHED_CLASSES` (they exist only for `cards`):

```ts
export const PRIMITIVE_CLASSES = ['PrimitiveString', 'PrimitiveStringMultiline', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean'] as const
```

```ts
export const SWITCHED_CLASSES: Readonly<Record<string, RunnerFamily>> = {
  LipSyncNode: 'sync-3',
  Audio: 'sync-3',
  EnhanceVideoNode: 'topaz-video',
  ...Object.fromEntries(PRIMITIVE_CLASSES.map(c => [c, 'cards' as const])),
}
```

In `shared/runner/values.ts`, fill `OUTPUT_KINDS`:

```ts
export const OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = {
  PrimitiveString: { 0: 'text' },
  PrimitiveStringMultiline: { 0: 'text' },
  PrimitiveInt: { 0: 'number' },
  PrimitiveFloat: { 0: 'number' },
  PrimitiveBoolean: { 0: 'boolean' },
}
```

In `staticValues.ts`, fill `STATIC_VALUES` (import `pyFloatOf, pyIntOf, pyTruthy` from `./pyText`):

```ts
/** validate_inputs' str(v): the canvas always sends a string for a STRING widget. */
const strOf = (v: unknown): string => typeof v === 'string' ? v : v == null ? '' : String(v)
/** validate_inputs' int(v) for a value eligibility has already accepted. */
const intOf = (v: unknown): number => typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? Number(v) : (pyIntOf(String(v)) ?? 0)
const floatOf = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : (pyFloatOf(String(v)) ?? 0)

export const STATIC_VALUES: Record<string, StaticEvaluator> = {
  PrimitiveString: inputs => ({ kind: 'text', text: strOf(inputs.value) }),
  PrimitiveStringMultiline: inputs => ({ kind: 'text', text: strOf(inputs.value) }),
  PrimitiveInt: inputs => ({ kind: 'number', value: intOf(inputs.value), int: true }),
  PrimitiveFloat: inputs => ({ kind: 'number', value: floatOf(inputs.value), int: false }),
  PrimitiveBoolean: inputs => ({ kind: 'boolean', value: pyTruthy(inputs.value) }),
}
```

- [ ] **Step 4: `withWiredValues`**

Append to `server/runner/values.ts` (import `isLink`, `ApiPrompt` from `#shared/runner/graph` and `outputKind` from `#shared/runner/values`):

```ts
export const WIRED_VALUE_MISSING = 'A value this step reads was not made'

/**
 * The workflow as one node's builder reads it: every wire into that node
 * that carries a value (text, a number, true/false, JSON text, an address)
 * replaced by the value itself, exactly as ComfyUI's execute() receives it.
 * Wires that carry files or masks are left as wires. `injected` lists the
 * non-blank texts substituted (moderated at the node's turn, R0.5). A value
 * wire whose value is missing is refused: never sent as blank.
 */
export function withWiredValues(
  prompt: ApiPrompt, nodeId: string, valueAt: (link: [string, number]) => RunnerValue | undefined,
): { prompt: ApiPrompt; injected: { input: string; text: string }[] } {
  const node = prompt[nodeId]
  if (!node) return { prompt, injected: [] }
  let inputs: Record<string, unknown> | null = null
  const injected: { input: string; text: string }[] = []
  for (const [name, v] of Object.entries(node.inputs ?? {})) {
    if (!isLink(v)) continue
    const kind = outputKind(prompt, v)
    if (kind === 'files' || kind === 'mask') continue
    const lit = literalOf(valueAt(v))
    if (lit === undefined) throw new Error(WIRED_VALUE_MISSING)
    inputs ??= { ...node.inputs }
    inputs[name] = lit
    if (typeof lit === 'string' && lit.trim()) injected.push({ input: name, text: lit })
  }
  return inputs ? { prompt: { ...prompt, [nodeId]: { ...node, inputs } }, injected } : { prompt, injected: [] }
}
```

- [ ] **Step 5: The `derive` plan kind and the Primitive and Gate plans**

In `executors.ts` add (import `KeptExt` from `./keptBytes`, `RunnerValue` from `./types`, `filesOf` from `./values`, `OUTPUT_KINDS` from `#shared/runner/values`, `STATIC_VALUES, staticValueOf` from `#shared/runner/staticValues`, `PRIMITIVE_CLASSES` from `#shared/runner/eligibility`):

```ts
/** What a derive plan may do: read files, keep bytes for the run, save an asset or a live preview. */
export interface DeriveIO {
  read(file: OutputFile): Promise<Uint8Array>
  /** Keeps bytes for the run by their sha256 (./keptBytes.ts): not an asset. */
  keep(bytes: Uint8Array, ext: KeptExt): Promise<OutputFile>
  /** Saves a result into the output folder as an asset of this run (counted as the run's output). */
  saveAsset(bytes: Uint8Array, o: { prefix: string; ext: string }): Promise<OutputFile>
  /** Saves a live preview into temp (as Python's save_live_preview(unique=True)). */
  savePreview(bytes: Uint8Array, o: { nodeId?: string }): Promise<OutputFile>
  hosted: boolean
  signal: AbortSignal
  nodeId: string
  /** The canvas workflow as sent (Save image embeds it), or null. */
  runWorkflow: unknown
}

/** What a derive plan made: each output slot's value, and what the node shows. */
export interface Derived { values: Record<number, RunnerValue>; ui: Record<string, unknown> | null }
```

Add to the `NodePlan` union:

```ts
  /** Computed on this server from the node's inputs (the cards, R0/R1): no provider, no charge. */
  | { kind: 'derive'; derive(io: DeriveIO): Promise<Derived> }
```

Add to `PlanContext`:

```ts
  /** What a link reads (R0): the source's value on that slot. Absent: only files (older callers). */
  valueFrom?(link: [string, number]): RunnerValue | undefined
```

Add the helper (exported, R1 reuses it):

```ts
/**
 * A card whose every output slot is its static evaluator
 * (#shared/runner/staticValues.ts) over its inputs as planned (a wired
 * source already substituted by the engine): one implementation for the
 * start-of-run moderation and for the run itself.
 */
export function staticDerive(ctx: PlanContext, ui?: (values: Record<number, RunnerValue>) => Record<string, unknown> | null): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const slots = Object.keys(OUTPUT_KINDS[node.class_type] ?? { 0: 'text' }).map(Number)
  const values: Record<number, RunnerValue> = {}
  for (const slot of slots) {
    const v = staticValueOf(ctx.prompt, [ctx.nodeId, slot], STATIC_VALUES)
    if (!v) throw new Error(`The runner cannot work out this ${node.class_type} card`)
    values[slot] = v
  }
  return { kind: 'derive', derive: async () => ({ values, ui: ui ? ui(values) : null }) }
}
```

In `planNodeRequest`'s switch, before `case GATE_CLASS`:

```ts
    // ── cards (step 3, R0.4): the Primitive cards hand on their value ──
    case 'PrimitiveString':
    case 'PrimitiveStringMultiline':
    case 'PrimitiveInt':
    case 'PrimitiveFloat':
    case 'PrimitiveBoolean':
      return staticDerive(ctx)
```

Replace the Gate case:

```ts
    case GATE_CLASS: {
      // A value (not files) reaching a Gate is handed on when it is open or
      // on pass-through (spec ruling 2); a closed Gate on a value pauses with
      // no pictures to pick from.
      const link = inputs.data_in
      const v = isLink(link) ? ctx.valueFrom?.(link) : undefined
      const files = v ? filesOf(v) : linked('data_in')
      const open = inputs.bypass === true || ctx.gateOpen
      if (open && v && v.kind !== 'files') return { kind: 'derive', derive: async () => ({ values: { 0: v }, ui: null }) }
      if (open) return { kind: 'pass', files, ui: null }
      return { kind: 'pause', files }
    }
```

(`PRIMITIVE_CLASSES` is imported only for a compile-time check that the five cases above match; add `const _primitives: readonly string[] = PRIMITIVE_CLASSES; void _primitives` beside the cases, or drop the import if the typecheck is clean without it.)

- [ ] **Step 6: The engine plans with wired values and carries out derive plans**

In `execNode`, build the substituted prompt once, just before `planWith` (after the media checks):

```ts
      // The node's inputs as its builder reads them (R0): every wire that
      // carries a value replaced by that value. The take keeps the workflow
      // as sent: price, hold and charge read the wires (a wired input is
      // priced at its most expensive, as the badge shows it).
      const wired = withWiredValues(take.prompt, id, valueAt(take))
```

and in `planWith`, pass `prompt: wired.prompt` instead of `take.prompt`, and add `valueFrom: valueAt(take)` to the context.

Handle the new plan kind right after `reads.clear()` and before `if (plan.kind === 'local')`:

```ts
      // Computed here from the node's inputs (the cards, R0/R1): no provider, no charge.
      if (plan.kind === 'derive') {
        const made = await plan.derive({
          read: readOnce,
          keep: (bytes, ext) => kept.put(run.id, bytes, ext),
          saveAsset: async (bytes, o) => {
            const f = await deps.results.save(bytes, { userId: run.userId, prefix: o.prefix, ext: o.ext })
            await deps.metering.addOutput(run.userId, stageKey, f)
            return f
          },
          savePreview: (bytes, o) => deps.results.saveLivePreview(bytes, { nodeId: o.nodeId ?? id, userId: run.userId }),
          hosted: deps.hosted(),
          signal,
          nodeId: id,
          runWorkflow: run.workflow,
        })
        if (signal.aborted) throw new RunStopped()
        for (const v of Object.values(made.values)) checkValue(v)
        rec.values = made.values
        rec.outputs = filesOfValues(made.values)
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run)
        if (made.ui) publish(run, ev.executed(stageKey, id, made.ui))
        return
      }
```

(`readOnce` still works after `reads.clear()`: it reads again.) Import `withWiredValues, checkValue, filesOfValues` from `./values`.

- [ ] **Step 7: Run the new test and the runner suite**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values-engine.unit.spec.ts tests/unit/runner-`
Expected: PASS; every existing runner test unchanged (no workflow in them has a Primitive, and the Gate still passes files as before).

- [ ] **Step 8: Typecheck and report** (no commit).

---

### Task R0.5: Words that arrive by wire are moderated

Hosted moderation today reads typed prompts (`extractGraphPromptText`, `extraPromptText`). A card's text wired into a node must be checked too: at the start of the run when the card's own settings decide it (before anything is held), and at the node's turn for any text that wasn't known at the start.

**Files:**
- Modify: `frontend/server/runner/metering.ts` (`Metering` :182-190, `createMetering` :192-213)
- Modify: `frontend/server/runner/engine.ts` (the start-of-run `moderate` calls :1442 and :1503; execNode after `withWiredValues`)
- Modify: `frontend/tests/unit/__runner__/kit.ts` (let a test pass its own `moderate`)
- Test: `frontend/tests/unit/runner-values-moderation.unit.spec.ts`

**Interfaces:**
- Consumes: `staticWiredTexts` (R0.3), `withWiredValues(...).injected` (R0.4).
- Produces:
  - `Metering.moderate(prompts: ApiPrompt[], extra?: readonly string[]): Promise<void>`
  - `Metering.moderateText(text: string): Promise<void>` (hosted only; the same refusal)
  - `makeKit({ moderate })` option

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-values-moderation.unit.spec.ts
/**
 * R0.5: text that reaches a paid node by wire is moderated — at the start of
 * the run when the card's settings decide it (refused before any hold), and
 * at the node's turn otherwise (the node fails, its hold is let go).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'

// Every R0/R1 card's text is known at the start; a text made during the run
// (R3's text nodes) is not. Until such a node exists, the start's reading is
// switched off here to stand for one.
const state = { startKnows: true }
vi.mock('#shared/runner/staticValues', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/staticValues')>()
  return { ...real, staticWiredTexts: (...a: Parameters<typeof real.staticWiredTexts>) => state.startKnows ? real.staticWiredTexts(...a) : [] }
})

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const flow = (value = 'forbidden words'): ApiPrompt => ({
  p: { class_type: 'PrimitiveString', inputs: { value } },
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', prompt_in: ['p', 0] } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const blockWord = (word: string) => vi.fn(async (text: string) => text.includes(word) ? { ok: false as const, categories: ['test'] } : { ok: true as const })

describe('wired text moderation', () => {
  it('refuses at the start, before any hold, when a card’s own text is blocked', async () => {
    state.startKnows = true
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow()], ...START })).rejects.toThrow(/content moderation/)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
  it('moderates a card’s text once at the start and not again at the node’s turn', async () => {
    state.startKnows = true
    const moderate = blockWord('never')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    const texts = moderate.mock.calls.map(c => c[0])
    expect(texts.some(t => t.includes('soft light'))).toBe(true)
    expect(texts.filter(t => t === 'soft light')).toEqual([])
  })
  it('moderates at the node’s turn a text the start could not know, and fails only that node', async () => {
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toMatch(/content moderation/)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].every(h => h.state === 'released' || h.actual === 0)).toBe(true)
  })
  it('moderates nothing locally', async () => {
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: false, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [flow()], ...START })
    await k.engine.settled(runId)
    expect(moderate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values-moderation.unit.spec.ts`
Expected: FAIL (`makeKit` has no `moderate` option; the start doesn't read wired text).

- [ ] **Step 3: Metering**

In `metering.ts`, change the interface and implementation:

```ts
  /** Hosted: the typed prompts, plus `extra` (texts wired from cards, known at the start). */
  moderate(prompts: ApiPrompt[], extra?: readonly string[]): Promise<void>
  /** Hosted: one text a wire brought into a node at its turn (R0.5). */
  moderateText(text: string): Promise<void>
```

```ts
    async moderate(prompts, extra = []) {
      if (!d.hosted()) return
      const text = [...new Set([...prompts.flatMap(p => [extractGraphPromptText(p), extraPromptText(p)]), ...extra].filter(Boolean))].join(' ')
      if (!text) return
      const mod = await d.moderate(text)
      if (!mod.ok) throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })
    },
    async moderateText(text) {
      if (!d.hosted() || !text.trim()) return
      const mod = await d.moderate(text)
      if (!mod.ok) throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })
    },
```

- [ ] **Step 4: The engine**

At both start-of-run moderation calls, pass the static wired texts:

```ts
    await deps.metering.moderate(prompts, prompts.flatMap(p => staticWiredTexts(p)))
```

(and the same shape at :1503 over `legTakes.map(t => draft.takes[t]!.prompt)`). Import `staticWiredTexts` from `#shared/runner/staticValues`.

In `execNode`, right after `const wired = withWiredValues(...)`:

```ts
      // Text a wire brought that the start of the run could not know (a value
      // made in the run, or passed through a Gate) is moderated now, before
      // the request exists (R0.5). Texts the start already checked are skipped.
      if (!resuming && wired.injected.length && PROVIDER_TYPES.has(take.prompt[id]!.class_type)) {
        const known = new Set(staticWiredTexts(take.prompt))
        for (const { text } of wired.injected) if (!known.has(text)) await deps.metering.moderateText(text)
      }
```

A `MeterRefusalError` thrown here fails the node through the existing catch (status `error`, its message on the node, the stage's hold for it let go).

- [ ] **Step 5: The kit**

In `makeKit`'s options add `moderate?: (text: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>` and pass `moderate: opts.moderate ?? (async () => ({ ok: true as const }))` to `createMetering`.

- [ ] **Step 6: Run the new test and the runner suite**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-values-moderation.unit.spec.ts tests/unit/runner-`
Expected: PASS; `runner-metering` unchanged and green.

- [ ] **Step 7: Typecheck and report** (no commit).

---

### Task R0.6: Paid nodes whose result is a value

A provider node can answer with a value instead of files (R3's text nodes: describe, transcribe, the LLM nodes). The plan says so (`media: 'value'`), the engine reads the value out of the answer instead of downloading, keeps it in the record, finds it again after a restart, and the reuse cache (same request, same seed) gives back values as well as files.

**Files:**
- Modify: `frontend/server/runner/executors.ts` (the provider variant of `NodePlan`)
- Modify: `frontend/server/runner/engine.ts` (the result handling after `waitForResult`; the reuse check; the media passed to `waitForResult`)
- Modify: `frontend/server/runner/store.ts` (`RunStore.getResult` / `putResult`, file store :106-114, database store :162-172)
- Test: `frontend/tests/unit/runner-value-results.unit.spec.ts`

**Interfaces:**
- Consumes: R0.1, R0.4.
- Produces:
  - provider plan `media: 'image' | 'video' | 'value'`; `valuesOf?(result: unknown): Record<number, RunnerValue>` (required when media is `'value'`)
  - store.ts: `interface ResultEntry { files: OutputFile[]; values?: Record<number, RunnerValue> }`; `getResult(userKey, fp): Promise<ResultEntry | null>` (a stored array reads as `{ files }`); `putResult(userKey, fp, entry: ResultEntry)` (an entry without values is written as the plain array, byte-identical to today)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/runner-value-results.unit.spec.ts
/**
 * R0.6: a paid node whose answer is a value. No real node answers with a
 * value before R3, so a Generate-an-image node carrying `test_value: true`
 * is turned into a value plan here (the vi.mock pattern of
 * runner-replicate-engine.unit.spec.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, makeKit, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { createFileRunStore } from '~~/server/runner/store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      if (plan.kind === 'provider' && ctx.prompt[ctx.nodeId]!.inputs.test_value === true) {
        return {
          ...plan, media: 'value' as const, uiFor: () => null,
          valuesOf: (result: any) => ({ 0: { kind: 'text' as const, text: `made ${String(result.images[0].url)}` } }),
        }
      }
      return plan
    },
  }
})

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const one = (seed: number): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'describe', aspect_ratio: '1:1', seed, model_options: '{}', test_value: true } },
})

describe('a paid node whose answer is a value', () => {
  it('keeps the value, downloads nothing, and is charged once', async () => {
    const download = vi.fn()
    const k = makeKit({ hosted: true, deps: { download } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [one(0)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'made https://fal.media/req1.png' } })
    expect(rec.outputs).toEqual([])
    expect(download).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].filter(h => h.state === 'settled')).toHaveLength(1)
  })
  it('gives the value back when the same request is reused (seed set)', async () => {
    const k = makeKit({ hosted: false })
    const a = await k.engine.startRun({ userId: null, takes: [one(5)], ...START })
    await k.engine.settled(a.runId)
    const b = await k.engine.startRun({ userId: null, takes: [one(5)], ...START })
    await k.engine.settled(b.runId)
    const rec = (await k.store.get(b.runId))!.takes[0]!.nodes['1']!
    expect(rec.reused).toBe(true)
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'made https://fal.media/req1.png' } })
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
  })
  it('picks the job up again after a restart and still reads its value', async () => {
    // The first server "crashes" (its sleeps never return), as runner-sync-3.unit.spec.ts does it.
    const fal = createFakeFal()
    const crash = { on: false }
    const k1 = makeKit({ hosted: false, fal, deps: { sleep: () => crash.on ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1)) } })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: null, takes: [one(0)], ...START })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    crash.on = true
    await new Promise(r => setTimeout(r, 20))
    fal.release()
    const k2 = makeKit({ hosted: false, dir: k1.dir, root: k1.root, fal })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(fal.client.submit).toHaveBeenCalledTimes(1)
    expect((await k2.store.get(runId))!.takes[0]!.nodes['1']!.values?.[0]).toEqual({ kind: 'text', text: 'made https://fal.media/req1.png' })
  })
})

describe('the reuse cache', () => {
  it('reads an old array as files, and writes an entry without values as the old array', async () => {
    const s = createFileRunStore(mkdtempSync(join(tmpdir(), 'runs-')))
    const f = { filename: 'a.png', subfolder: '', type: 'output' as const }
    await s.putResult('local', 'fp1', { files: [f] })
    expect(await s.getResult('local', 'fp1')).toEqual({ files: [f] })
    await s.putResult('local', 'fp2', { files: [], values: { 0: { kind: 'text', text: 'x' } } })
    expect(await s.getResult('local', 'fp2')).toEqual({ files: [], values: { 0: { kind: 'text', text: 'x' } } })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-value-results.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: The plan and the store**

In `executors.ts`, change the provider variant:

```ts
  | {
    kind: 'provider'; provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
    /** 'value': the answer itself is the result (text, JSON…), read by `valuesOf`; nothing is downloaded. */
    media: 'image' | 'video' | 'value'; prefix: string
    uiFor(files: OutputFile[]): Record<string, unknown> | null
    /** For media 'value': the node's values, read out of the provider's answer. */
    valuesOf?(result: unknown): Record<number, RunnerValue>
    backup?: ProviderBackup
    keep?: KeepStep
  }
```

In `store.ts`:

```ts
/** A reusable result: its files, and its values when it made any (R0.6). */
export interface ResultEntry { files: OutputFile[]; values?: Record<number, RunnerValue> }

/** A stored result as an entry: arrays were written before R0.6. */
function entryOf(v: unknown): ResultEntry | null {
  if (Array.isArray(v)) return { files: v as OutputFile[] }
  if (v && typeof v === 'object' && Array.isArray((v as ResultEntry).files)) return v as ResultEntry
  return null
}
/** An entry as stored: without values, the plain array (byte-identical to before R0.6). */
const storedOf = (e: ResultEntry): unknown => e.values ? { files: e.files, values: e.values } : e.files
```

and change `RunStore`:

```ts
  getResult(userKey: string, fingerprint: string): Promise<ResultEntry | null>
  putResult(userKey: string, fingerprint: string, entry: ResultEntry): Promise<void>
```

File store: `getResult` returns `entryOf(JSON.parse(...))`; `putResult` writes `JSON.stringify(storedOf(entry))`. Database store: `getResult` returns `rows[0] ? entryOf(parse(rows[0].files)) : null`; `putResult` binds `JSON.stringify(storedOf(entry))`. No schema change (the column is jsonb).

- [ ] **Step 4: The engine**

Timeouts: where `waitForResult(run, rec, stageKey, id, plan.media, …)` is called, pass `plan.media === 'video' ? 'video' : 'image'` (a value answer waits as long as a picture).

The reuse check becomes:

```ts
      if (fp && !rec.request) {
        const prior = await deps.store.getResult(userKey, fp)
        const priorFiles = prior?.files ?? []
        if (prior && (priorFiles.length || prior.values) && (await Promise.all(priorFiles.map(f => files.exists(f)))).every(Boolean)) {
          for (const f of priorFiles) await deps.metering.addOutput(run.userId, stageKey, f)
          rec.outputs = priorFiles
          if (prior.values) rec.values = prior.values
          rec.reused = true
          rec.status = 'done'
          rec.endedAt = deps.now()
          await persist(run)
          const ui = plan.uiFor(priorFiles)
          if (ui) publish(run, ev.executed(stageKey, id, ui))
          return
        }
      }
```

After `waitForResult`, before `const urls = …`:

```ts
      if (plan.media === 'value') {
        if (!plan.valuesOf) throw new Error('This step has no way to read its answer')
        const values = plan.valuesOf(result)
        for (const v of Object.values(values)) checkValue(v)
        rec.values = values
        rec.outputs = filesOfValues(values)
        rec.status = 'done'
        rec.servedBy = providerOf(rec.request!)
        rec.endedAt = deps.now()
        if (fp) await deps.store.putResult(userKey, fp, { files: rec.outputs, values }).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
        await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
        const ui = plan.uiFor(rec.outputs)
        if (ui) publish(run, ev.executed(stageKey, id, ui))
        return
      }
```

Change the two existing `putResult(userKey, fp, files)` calls to `putResult(userKey, fp, { files })` (and the backup one likewise).

- [ ] **Step 5: Run the new test and the runner suite**

Run: `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-value-results.unit.spec.ts tests/unit/runner-`
Expected: PASS; `runner-store`, `runner-fingerprint`, `runner-engine` unchanged and green.

- [ ] **Step 6: Typecheck and report** (no commit).

---

### Task R0.7: Masks, and pictures as Python loads them

Two helpers every later card needs, each proven against Python:
- **masks**: ComfyUI MASK values (float 0..1) kept as a 16-bit greyscale PNG, `round(v·65535)`; and LoadImage's MASK (1 − alpha, or a 64×64 zero mask when the file has no alpha);
- **the Python view of a picture**: what a Python loader's tensor is (EXIF turned, first frame, RGB), as the PNG `_image_tensor_to_data_url` would send — or `null` when the file already is exactly that, so it is handed on untouched.

**Files:**
- Create: `frontend/server/runner/pictures/mask.ts`
- Create: `frontend/server/runner/pictures/pythonView.ts`
- Create: `scripts/runner_values_fixtures.py` → `frontend/tests/unit/fixtures/runner-values.json`
- Test: `frontend/tests/unit/runner-pictures.unit.spec.ts`

**Interfaces:**
- Consumes: `maskPngFromScanlines` (`server/runner/compositor/keep.ts:70`), `MAX_INPUT_PIXELS` (`compositor/decode.ts:26`).
- Produces:
  - `interface Mask { w: number; h: number; data: Float32Array }` (row-major, ComfyUI MASK values)
  - `encodeMask(m: Mask): Promise<Uint8Array>`; `decodeMask(bytes): Promise<Mask>` (the runner's own 16-bit greyscale PNG only)
  - `loadImageMask(bytes): Promise<Mask>` (port of `nodes.py` LoadImage's MASK)
  - `PICTURE_16_BIT`, `PICTURE_CMYK` (plain refusals)
  - `rgbTurnedPng(bytes): Promise<{ png: Uint8Array | null; w: number; h: number }>`

- [ ] **Step 1: The Python fixtures**

Write `scripts/runner_values_fixtures.py` (the `scripts/compositor_fixtures.py` header pattern: docstring, `block_network()`, `ROOT`, `OUT = …/runner-values.json`). It makes small synthetic files with PIL and records, base64-encoded:

- `load_mask`: for each file — RGBA PNG with a gradient alpha; RGB PNG (no alpha); LA PNG; palette PNG with a transparent index — the **real** `nodes.LoadImage().load_image(name)`'s MASK tensor (`folder_paths` pointed at a temp input dir), stored as 16-bit `round(m·65535)` little-endian with its size.
- `rgb_turned`: for each file — RGB PNG; RGBA PNG; JPEG with EXIF orientation 6; JPEG orientation 1; greyscale PNG; palette PNG; a two-frame GIF — the tensor `ImageOps.exif_transpose(Image.open(p)).convert("RGB")` of the first frame, stored as 8-bit RGB `round(255·x)` (what `_image_tensor_to_data_url` would encode), and whether the file was already that picture (an RGB 8-bit single-frame PNG with no EXIF orientation).
- `refused`: a 16-bit greyscale PNG and a CMYK JPEG, each with what PIL's `.convert("RGB")` gives (kept for the report; the runner refuses both — see Step 3).

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_values_fixtures.py`
Expected: writes `frontend/tests/unit/fixtures/runner-values.json` with keys `load_mask`, `rgb_turned`, `refused`, `note`.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/tests/unit/runner-pictures.unit.spec.ts
/**
 * R0.7: masks as the runner keeps them, LoadImage's MASK, and a picture as a
 * Python loader sees it — against scripts/runner_values_fixtures.py.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { decodeMask, encodeMask, loadImageMask, type Mask } from '~~/server/runner/pictures/mask'
import { PICTURE_16_BIT, PICTURE_CMYK, rgbTurnedPng } from '~~/server/runner/pictures/pythonView'

const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-values.json'), 'utf8'))
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const u16 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2) }

describe('encodeMask / decodeMask', () => {
  it('keeps a mask as 16-bit round(v·65535) and reads it back', async () => {
    const m: Mask = { w: 3, h: 2, data: Float32Array.from([0, 0.25, 0.5, 0.75, 1, 1 / 3]) }
    const png = await encodeMask(m)
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height, meta.channels, meta.depth]).toEqual([3, 2, 1, 'ushort'])
    const back = await decodeMask(png)
    expect(back.w).toBe(3)
    expect([...back.data].map(v => Math.round(v * 65535))).toEqual([0, 16384, 32768, 49151, 65535, 21845])
  })
})

describe('loadImageMask', () => {
  for (const c of FIX.load_mask as { name: string; file: string; w: number; h: number; mask16: string }[]) {
    it(`matches LoadImage's MASK for ${c.name}`, async () => {
      const m = await loadImageMask(b64(c.file))
      expect([m.w, m.h]).toEqual([c.w, c.h])
      expect([...m.data].map(v => Math.round(v * 65535))).toEqual([...u16(c.mask16)])
    })
  }
})

describe('rgbTurnedPng', () => {
  for (const c of FIX.rgb_turned as { name: string; file: string; w: number; h: number; rgb8: string; unchanged: boolean }[]) {
    it(`gives Python's RGB picture for ${c.name}`, async () => {
      const r = await rgbTurnedPng(b64(c.file))
      expect(r.png === null).toBe(c.unchanged)
      const png = r.png ?? b64(c.file)
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      expect([info.width, info.height, info.channels]).toEqual([c.w, c.h, 3])
      expect(Buffer.compare(data, Buffer.from(c.rgb8, 'base64'))).toBe(0)
    })
  }
  it('refuses a 16-bit picture and a CMYK picture in plain words', async () => {
    const [sixteen, cmyk] = FIX.refused as { file: string }[]
    await expect(rgbTurnedPng(b64(sixteen!.file))).rejects.toThrow(PICTURE_16_BIT)
    await expect(rgbTurnedPng(b64(cmyk!.file))).rejects.toThrow(PICTURE_CMYK)
  })
})
```

- [ ] **Step 3: Write `pictures/mask.ts` and `pictures/pythonView.ts`**

```ts
// frontend/server/runner/pictures/mask.ts
/**
 * Masks between runner nodes (R0, step 3 spec): ComfyUI's MASK values (float
 * 0..1, row-major), kept as a 16-bit greyscale PNG holding round(v·65535).
 * Also LoadImage's MASK: 1 − alpha of the file's first frame, or a 64×64 zero
 * mask when it has no alpha (nodes.py LoadImage.load_image).
 */
import sharp from 'sharp'
import { maskPngFromScanlines } from '../compositor/keep'
import { MAX_INPUT_PIXELS } from '../compositor/decode'

export interface Mask { w: number; h: number; data: Float32Array }

export async function encodeMask(m: Mask): Promise<Uint8Array> {
  const row = 1 + 2 * m.w
  const scan = new Uint8Array(row * m.h)
  for (let y = 0; y < m.h; y++) {
    scan[y * row] = 0 // filter: none
    for (let x = 0; x < m.w; x++) {
      const v = Math.min(65535, Math.max(0, Math.round(m.data[y * m.w + x]! * 65535)))
      scan[y * row + 1 + 2 * x] = v >> 8
      scan[y * row + 2 + 2 * x] = v & 0xFF
    }
  }
  return maskPngFromScanlines(scan, m.w, m.h)
}

export async function decodeMask(bytes: Uint8Array): Promise<Mask> {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new Error('A mask could not be read')
  const u = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const out = new Float32Array(info.width * info.height)
  for (let i = 0; i < out.length; i++) out[i] = u[i]! / 65535
  return { w: info.width, h: info.height, data: out }
}

export async function loadImageMask(bytes: Uint8Array): Promise<Mask> {
  const s = sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
  const meta = await s.metadata()
  if (!meta.hasAlpha) return { w: 64, h: 64, data: new Float32Array(64 * 64) }
  const { data, info } = await s.extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  const out = new Float32Array(info.width * info.height)
  for (let i = 0; i < out.length; i++) out[i] = 1 - data[i]! / 255
  return { w: info.width, h: info.height, data: out }
}
```

Check `loadImageMask` against the fixtures before going on: LoadImage turns EXIF on the image **and** the mask (`ImageOps.exif_transpose` before splitting). If the palette-with-transparency case differs, derive alpha with `ensureAlpha()` after `toColourspace('srgb')` instead of `extractChannel`, and say so in the report.

```ts
// frontend/server/runner/pictures/pythonView.ts
/**
 * A picture file as a Python loader's tensor holds it (R0, step 3 spec):
 * ImageOps.exif_transpose, first frame, .convert("RGB") — the loaders of
 * LoadImage's IMAGE, 3D Studio's bakes and Text on path. Returned as the PNG
 * `_image_tensor_to_data_url` would send (8-bit RGB), or `png: null` when the
 * file already is exactly that picture (then it is handed on untouched).
 * PIL ignores embedded ICC profiles; so does this. 16-bit and CMYK files are
 * refused: PIL's conversion of those is its own, and not ported.
 */
import sharp from 'sharp'
import { MAX_INPUT_PIXELS } from '../compositor/decode'

export const PICTURE_16_BIT = 'This picture is 16-bit. Save it as an 8-bit picture and load it again.'
export const PICTURE_CMYK = 'This picture is CMYK. Save it as RGB and load it again.'

export async function rgbTurnedPng(bytes: Uint8Array): Promise<{ png: Uint8Array | null; w: number; h: number }> {
  const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  if (meta.depth === 'ushort') throw new Error(PICTURE_16_BIT)
  if (meta.space === 'cmyk') throw new Error(PICTURE_CMYK)
  const turned = (meta.orientation ?? 1) >= 5
  const w = turned ? meta.height! : meta.width!
  const h = turned ? meta.width! : meta.height!
  const already = meta.format === 'png' && meta.channels === 3 && !meta.hasAlpha
    && (meta.orientation ?? 1) === 1 && (meta.pages ?? 1) === 1 && meta.space === 'srgb'
  if (already) return { png: null, w, h }
  const png = await sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').removeAlpha().png({ compressionLevel: 6 }).toBuffer()
  return { png: new Uint8Array(png), w, h }
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run tests/unit/runner-pictures.unit.spec.ts`
Expected: PASS. A fixture case that fails is a real difference with PIL: fix the TS until it matches, or refuse that kind of file in plain words and say which in the report — never loosen the comparison.

- [ ] **Step 5: Typecheck and report** (no commit).

---

# R1 — Text and data cards

Every R1 class belongs to family `cards`, is computed by the runner (`local: 'source'` or, for classes that write files, `local: 'render'`), costs nothing, and is added to `SWITCHED_CLASSES` so it is known only while `cards` is on. Every R1 class that ComfyUI treats as an output node is added to `RUNNER_OUTPUT_CLASSES` (`shared/runner/validate.ts:40`). The Python cards are ported against fixtures from `scripts/runner_cards_fixtures.py` → `frontend/tests/unit/fixtures/runner-cards.json`, one top-level key per task; each task adds its key and regenerates the file (the other keys must come out unchanged).

### Task R1.1: Text, Moodboard and 3D model cards

**Port:**
- `Text` — `comfy_extras/nodes_text.py:167-213`: `value = text if (text and text.strip()) else (source or "")`, output STRING, `ui = {"text": [value]}`, an output node.
- `Moodboard` — `comfy_extras/nodes_moodboard.py:37-125`: `moodboard_style_block(json.loads(reading_json) if reading_json.strip() else {})`, a bad payload is `{}`, output TASTE (text). Not an output node.
- `Model3D` — `comfy_extras/nodes_model3d.py:16-44`: `url = glb_url or ""`, output STRING, `ui = {"text": [url]}`, an output node.

**Files:**
- Create: `frontend/shared/taste/moodboardStyle.ts`
- Modify: `frontend/app/lib/taste/styleBlock.ts:41-48` (re-export from the shared module; `moodboardStyleBlock`'s signature stays)
- Create: `frontend/server/runner/cards/text.ts`
- Modify: `frontend/shared/runner/eligibility.ts` (rows; `SWITCHED_CLASSES`; `INPUT_CHECKS`), `frontend/shared/runner/values.ts` (`OUTPUT_KINDS`), `frontend/shared/runner/staticValues.ts` (`STATIC_VALUES`), `frontend/shared/runner/validate.ts` (`RUNNER_OUTPUT_CLASSES`), `frontend/server/runner/executors.ts` (three cases)
- Create: `scripts/runner_cards_fixtures.py` (key `moodboard`, key `text`)
- Test: `frontend/tests/unit/runner-cards-text.unit.spec.ts`

**Interfaces:**
- Consumes: `staticDerive` (R0.4), `pyStrip` (`shared/runner/pyText.ts:19`).
- Produces:
  - `shared/taste/moodboardStyle.ts`: `moodboardStyleBlock(reading: { summary: string; palette: { name: string; hex: string }[]; avoids: string[] }): string` (moved, unchanged); `moodboardReadingIsPlain(readingJson: unknown): boolean`; `moodboardStyleFromJson(readingJson: string): string`
  - `RunnerNodeRule.inputCheck?: keyof typeof INPUT_CHECKS` and `INPUT_CHECKS: { 'moodboard-reading': (inputs) => boolean }`
  - `cards/text.ts`: `textCardUi(values): { text: string[] }`

**Rules:**

```ts
  // ── cards (step 3, R1.1): Text, Moodboard, 3D model ──
  // Text: typed text wins; blank typed text hands on what `source` brings.
  Text: { family: 'cards', local: 'source', valueInputs: { source: ['text', 'json', 'glb'] }, widgets: { text: { type: 'STRING', required: true } } },
  // Moodboard: the reading's style block. Taken only when the reading is the
  // plain text the moodboard window writes (spec ruling 3).
  Moodboard: {
    family: 'cards', local: 'source',
    widgets: { reading_json: { type: 'STRING', required: true }, moodboard_id: { type: 'STRING' } },
    inputCheck: 'moodboard-reading',
  },
  // 3D model: hands on the address wired in (Sailor's own copy, spec ruling 1).
  Model3D: { family: 'cards', local: 'source', valueInputs: { glb_url: ['glb', 'text'] } },
```

`OUTPUT_KINDS`: `Text: { 0: 'text' }`, `Moodboard: { 0: 'text' }`, `Model3D: { 0: 'text' }`. `RUNNER_OUTPUT_CLASSES` gains `'Text'` and `'Model3D'`. `nodeRuleAllows` gains, after the widget checks: `if (rule.inputCheck && !INPUT_CHECKS[rule.inputCheck](inputs)) return false`.

**Static evaluators** (in `STATIC_VALUES`; a linked input is evaluated through `at`, a substituted one is already a literal):

```ts
  Text: (inputs, at) => {
    const typed = typeof inputs.text === 'string' ? inputs.text : ''
    if (typed && pyStrip(typed)) return { kind: 'text', text: typed }
    const src = inputs.source
    if (isLink(src)) {
      const v = at(src)
      return v?.kind === 'text' ? v : undefined
    }
    return { kind: 'text', text: typeof src === 'string' ? src : '' }
  },
  Moodboard: inputs => ({ kind: 'text', text: moodboardStyleFromJson(typeof inputs.reading_json === 'string' ? inputs.reading_json : '') }),
  Model3D: (inputs, at) => {
    const src = inputs.glb_url
    if (isLink(src)) {
      const v = at(src)
      return v?.kind === 'text' ? v : undefined
    }
    return { kind: 'text', text: typeof src === 'string' ? src : '' }
  },
```

**`moodboardStyle.ts`:** `moodboardStyleFromJson(raw)`: `pyStrip(raw)` empty → `''`; `JSON.parse` failing → `''` (Python's JSONDecodeError branch); not a plain object → `''`; else the existing `moodboardStyleBlock` over `{ summary: String(summary ?? ''), palette: palette ?? [], avoids: avoids ?? [] }`, with the summary check using `pyStrip` instead of `trim` (Python `.strip()`). `moodboardReadingIsPlain(raw)`: true when `raw` is a string that is blank, or parses (JSON.parse) to a plain object whose `summary` is absent/null/string, `palette` absent/null or an array of plain objects whose `name`/`hex` are absent or strings, and `avoids` absent/null or an array of strings. A string Python's `json.loads` accepts but `JSON.parse` doesn't (NaN, Infinity) is not plain.

**Plans** (`executors.ts`): `case 'Text': return staticDerive(ctx, textCardUi)`, `case 'Moodboard': return staticDerive(ctx)`, `case 'Model3D': return staticDerive(ctx, textCardUi)`, with `textCardUi = v => ({ text: [(v[0] as { text: string }).text] })`.

**Fixtures** (`runner_cards_fixtures.py`): `moodboard` — for each case, `reading_json` and the real `MoodboardNode.execute(reading_json)`'s string: the three shared fixtures in `tests-unit/comfy_api_test/fixtures/moodboard_style_block_*.json`, blank, whitespace only (including U+001C and U+00A0), bad JSON, a JSON list, a summary ending in `.`, a summary of only spaces, an empty palette, palette items with a missing name or hex, and one non-plain case per kind (a numeric avoid, a palette item that's a string) recorded with `plain: false`. `text` — `TextNode.execute(text, source)` over typed text, blank typed text with a source, whitespace-only typed text (U+2003) with a source, and no source.

**Test (`runner-cards-text.unit.spec.ts`), each a separate `it`:**
- every `moodboard` fixture with `plain !== false`: `moodboardStyleFromJson` equals Python's string, and `moodboardReadingIsPlain` is true; every `plain: false` case: `moodboardReadingIsPlain` is false and `runnerTakesNode` leaves the Moodboard to the engine;
- every `text` fixture: the Text evaluator equals Python's value;
- `app/lib/taste/styleBlock.ts`'s `moodboardStyleBlock` still passes `taste-style-block.unit.spec.ts` unchanged;
- engine (kit, `cards` on, hosted): Moodboard → Restyle is not in R1.1 (R1.2), so use Text → Generate an image's `prompt_in`: the fal payload's prompt is the Text's value + space + the node's prompt; the Text node's `executed` event carries `{ text: [value] }`; the Text record's values are `{ 0: { kind: 'text', … } }`; credits 0;
- Model3D unwired: runs, `executed` carries `{ text: [''] }`;
- with `cards` off, a workflow with a Text card is refused, and `nodesNeedingEngine` names the Text card.

Run: `.venv/bin/python scripts/runner_cards_fixtures.py`, then `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-cards-text.unit.spec.ts tests/unit/taste-style-block.unit.spec.ts tests/unit/runner-`. Expected: PASS. Typecheck; report (no commit).

---

### Task R1.2: Words wired into paid nodes (lifting the refusals)

Today a wired prompt, idea, style block or taste sends the whole workflow to ComfyUI (`eligibility.ts:343-358` in the inventory's numbering; today's rows `GenerateImageNode.mustNotLink`, `GenerateVideoNode.mustNotLink`, `EditImageNode.mustNotLink`, `RestyleFromImageNode.mustNotLink`). With R0 the runner hands the node the value as if typed, so these inputs can take a text wire.

**Files:**
- Modify: `frontend/shared/runner/eligibility.ts` (`valueInputs` on four rows)
- Modify: `scripts/runner_cards_fixtures.py` (key `wired_text`)
- Test: `frontend/tests/unit/runner-cards-wired-text.unit.spec.ts`

**Interfaces:**
- Consumes: R0.3–R0.5, R1.1 (Text, Moodboard, Primitive cards as sources).
- Produces: `valueInputs` rows:
  - `GenerateImageNode: { prompt: ['text'], prompt_in: ['text'], style_block: ['text'], style_in: ['text'] }`
  - `GenerateVideoNode: { prompt: ['text'] }`
  - `EditImageNode: { prompt: ['text'] }`
  - `RestyleFromImageNode: { prompt: ['text'], style_in: ['text'] }`

What stays refused (and why), each with a test: `model_options` and `style_refs` on Generate an image (they decide how many pictures are made and which files are read before the hold); `model_options` on Generate a video (R11); Relight's `light` and `instructions` (R11); every other `mustNotLink` input.

**Fixtures** (`wired_text`): with `capture_first_call` imported from `scripts/runner_builder_fixtures.py` (import the module; do not change it), the real `GenerateImageNode.execute` for a fal model (`flux-schnell`) and a Replicate model (`flux-dev`) with `prompt_in`, `style_block`, `style_in` in every combination of blank/non-blank and a blank typed prompt; the real `RestyleFromImageNode.execute` (Nano Banana 2) with `style_in` set as the Moodboard's style block for one fixture reading; the real `GenerateVideoNode.execute` (`veo-3.1`) with a prompt. Each records `{ inputs, endpoint, payload }`.

**Test:**
- for every `wired_text` fixture, a workflow whose text inputs come from Primitive / Text / Moodboard cards (rather than typed) plans exactly the captured endpoint and payload (plan through `planNode` with the engine's `withWiredValues`, fake hand-off `https://fal.storage/<name>`), and the same workflow typed plans the same payload;
- engine (hosted, kit): Moodboard → Restyle `style_in`: one fal call, the payload's prompt folds the style block as Python does; the charge equals `priceGraph` for the Restyle node (the wire doesn't change the price); the Moodboard is charged 0;
- a Text whose value is blank wired into a Nano Banana model's `prompt` (a model with a minimum prompt length, `requestRules.ts` `PROMPT_MIN_LENGTH`): the start of the run lets it through (a wired prompt isn't judged at the start, as today), the node fails at its turn with the rule's own message, nothing is sent, and its hold is let go;
- the refusals that stay: each listed input wired from a Text card leaves the workflow to the engine.

Run the test and the runner suite (as above). Typecheck; report (no commit).

---

### Task R1.3: Bake-replay cards and LoadImage beyond the Frame

**Port:**
- `Scene3DStudio` — `comfy_extras/nodes_scene3d.py:21-86`: three outputs (beauty, depth, normal), each `_load_input_image(filename)` (`folder_paths.get_annotated_filepath`, `exif_transpose`, RGB); any failure or blank name → a 1024×1024 placeholder: beauty (0.5, 0.5, 0.5), depth (0, 0, 0), normal (0.5, 0.5, 1.0). No ui. Not an output node.
- `TextOnPath` — `comfy_extras/nodes_text_on_path.py:15-93`: `params` JSON (`json.loads(params or "{}")`, not a dict or unreadable → `{}`); no `rendered` → a 16×16 black image and a 16×16 mask of ones; else `_load_rendered`: `exif_transpose`, mask = 1 − alpha when the file has alpha else zeros, image RGB. A load failure fails the node: "Text on path couldn’t load its picture. Change a setting to bake it again."
- `TextMask` **without** a source — `comfy_extras/nodes_text_mask.py:36-123`: no `rendered` → 16×16 black image, 16×16 mask of ones; else `_load_mask`: `convert("L")` (no EXIF turn), mask = 1 − L/255, image = (1 − mask) as grey RGB. With a source wired: R1.4.
- `LoadImage` feeding anything (today only Frames): IMAGE = `rgbTurnedPng` of the file (R0.7), MASK = `loadImageMask` (R0.7).

**Files:**
- Create: `frontend/server/runner/cards/bakeReplay.ts`, `frontend/server/runner/cards/loadImage.ts`
- Modify: `frontend/shared/runner/eligibility.ts` (rows; `RunnerNodeRule.open`; `graphRuleAllows` takes `families`; `IMAGE_OUTPUT_CLASSES` → slot-aware `PICTURE_OUTPUTS`)
- Modify: `frontend/shared/runner/values.ts` (`OUTPUT_KINDS`: `TextOnPath: { 1: 'mask' }`, `TextMask: { 1: 'mask' }`, `LoadImage: { 1: 'mask' }` — the last only matters when the LoadImage runs as a card, see below)
- Modify: `frontend/server/runner/executors.ts` (cases), `frontend/server/runner/compositor/plan.ts` (`pictureSourceOf` :30-57 new classes; the `mask()` reader :71-78 reads a `mask` value), `frontend/server/runner/inputs.ts` (`collectInputFiles`: the three bake names, `params.rendered` of TextOnPath / TextMask)
- Modify: `scripts/runner_cards_fixtures.py` (keys `scene3d`, `text_on_path`, `text_mask`, `load_image`)
- Test: `frontend/tests/unit/runner-cards-bake.unit.spec.ts`

**Interfaces:**
- Consumes: `DeriveIO.keep`, `rgbTurnedPng`, `encodeMask`, `loadImageMask` (R0.7), `parseInputFileRef` (`inputs.ts:39`).
- Produces:
  - `bakeReplay.ts`: `planScene3D(ctx): NodePlan`, `planTextOnPath(ctx): NodePlan`, `planTextMask(ctx): NodePlan` (no source), `pilLuma(r, g, b): number` (`(r·19595 + g·38470 + b·7471 + 0x8000) >>> 16`, PIL's `L`)
  - `loadImage.ts`: `planLoadImageCard(ctx): NodePlan`
  - `RunnerNodeRule.open?: { family: RunnerFamily; lifts: readonly ('feedsOnly')[] }`
  - `PICTURE_OUTPUTS: Record<string, readonly number[]>` (eligibility.ts): the slots of a class that carry a picture; `carriesImage` reads it, else slot 0 of `IMAGE_OUTPUT_CLASSES` as before

**Rules:**

```ts
  Scene3DStudio: {
    family: 'cards', local: 'source',
    valueInputs: { glb_url: ['text', 'glb'] },
    widgets: { scene_state: { type: 'STRING' }, beauty_image: { type: 'STRING' }, depth_image: { type: 'STRING' }, normal_image: { type: 'STRING' } },
  },
  TextOnPath: { family: 'cards', local: 'source', widgets: { params: { type: 'STRING', required: true } } },
  // With a source wired: R1.4.
  TextMask: { family: 'cards', local: 'source', mustNotLink: ['source'], widgets: { params: { type: 'STRING', required: true } } },
```

and the LoadImage row gains `open: { family: 'cards', lifts: ['feedsOnly'] }` (with `cards` on, it may feed anything). Because LoadImage's slot 1 is now declared a `mask`, the `Compositor` row gains `valueInputs` for `layer1_mask` … `layer16_mask` and `overlay_mask`: `['mask']` — without it `valueWiresAllowed` would refuse every masked Frame (its `linkSources` still insist the mask comes from a LoadImage). The Frame tests prove masked Frames are taken exactly as before, with `cards` on and off. `nodeRuleAllows` accepts a row when `family` **or** `open.family` is on; `graphRuleAllows(prompt, id, rule, families)` skips `feedsOnly` when `open.family` is on and `lifts` has it. With `cards` off, LoadImage is exactly as today.

**Plans:**
- Placeholders are 8-bit PNGs kept once each: beauty and normal use `round(0.5·255) = 128` (what a hand-off to a provider sends); depth black; normal `(128, 128, 255)`. A Frame reading one decodes 128/255, within 1/255 of Python's 0.5 (the `rgb` precedent in `compositor/decode.ts`).
- A bake file that loads: `rgbTurnedPng`; `png: null` → the file itself is the value (`{ kind: 'files', files: [file] }`); else the kept PNG. A file that fails to load becomes the placeholder (Python catches every exception there).
- `planLoadImageCard`: when every reader is a Compositor and `cards` is off, the existing `LoadImage` pass plan (unchanged). Otherwise derive: slot 0 as above, slot 1 `{ kind: 'mask', files: [kept encodeMask(loadImageMask(bytes))] }`.
- `compositor/plan.ts` `mask()`: when `ctx.valueFrom?.(link)?.kind === 'mask'`, decode with `decodeMask` into the loader the Frame expects; otherwise the existing `decodeRawMask` of the file. Test that a Frame gives identical pixels whether its LoadImage ran the old way or as a card.
- `pictureSourceOf`: `Scene3DStudio` (any slot) → `'load'`; `TextOnPath` slot 0 → `'load'`; `TextMask` slot 0 → `'rgb'`; `LoadImage` slot 0 → `'load'` (already).
- Hosted ownership: `collectInputFiles` adds each non-blank bake name of a Scene3DStudio and each `rendered` of a TextOnPath / TextMask (parsed with `parseInputFileRef`), so a file that isn't the user's is refused before the hold.

**Fixtures:** `scene3d` — the real `Scene3DStudioNode.execute` over: three good bakes (RGBA PNG, EXIF-turned JPEG, RGB PNG), a missing file, blank names — each output as 8-bit RGB `round(255·x)` (what a provider is sent). `text_on_path` — the real node over: an RGBA render, an RGB render, blank `rendered`, `params` not a dict, bad JSON — image 8-bit, mask 16-bit. `text_mask` — the real node (no source) over: an RGBA render with colour, a greyscale render, blank — image 8-bit, mask 16-bit. `load_image` — the real `LoadImage.load_image` over the R0.7 files — image 8-bit, mask 16-bit.

**Test:** every fixture case equals the runner's derive plan output (decode the kept PNGs with sharp; masks with `decodeMask`, compared as 16-bit integers); `pilLuma` against PIL for 256 random triples recorded in the fixture; eligibility: LoadImage → Generate an image taken only with `cards` on; LoadImage → Frame unchanged with `cards` off; Scene3D → Edit image (engine, hosted): the fal payload's `image_urls[0]` hands off the kept RGB PNG, not the RGBA bake; a TextOnPath's mask feeding nothing yet is recorded as a mask value; ownership: a bake file owned by someone else is refused 403 before any hold.

Run the fixtures script, the test, the runner suite and the compositor tests (`runner-compositor*.unit.spec.ts` must stay green). Typecheck; report (no commit).

---

### Task R1.4: Picture utilities: Empty image, Get image size, Image to mask, Text mask with a source

**Port:**
- `EmptyImage` — `nodes.py:2062-2082`: `[batch_size, height, width, 3]` of `((color >> 16) & 0xFF)/0xFF` etc.
- `GetImageSize` — `comfy_extras/nodes_images.py:553-590`: width, height, batch size of the IMAGE tensor (INT ×3). Python also sends a progress text to the node; the runner doesn't show it (report it).
- `ImageToMask` — `comfy_extras/nodes_mask.py:127-148`: `image[:, :, :, channels.index(channel)]`; `alpha` on a 3-channel tensor raises in Python → the runner fails the node: "This picture has no alpha channel to make a mask from".
- `TextMask` **with** a source — `nodes_text_mask.py:95-118`: the mask resized to the source with `F.interpolate(mode="bilinear", align_corners=False)` when sizes differ; image = source × (1 − mask) (every channel, alpha too when the source has it).

**Files:**
- Create: `frontend/server/runner/pixels/resize.ts`
- Create: `frontend/server/runner/cards/utilities.ts`
- Modify: `frontend/shared/runner/eligibility.ts` (rows; `TextMask` drops `mustNotLink: ['source']` and gains `imageInputs: ['source']`), `frontend/shared/runner/values.ts` (`OUTPUT_KINDS`: `GetImageSize: { 0: 'number', 1: 'number', 2: 'number' }`, `ImageToMask: { 0: 'mask' }`), `frontend/server/runner/executors.ts`, `frontend/server/runner/compositor/plan.ts` (`pictureSourceOf`: `EmptyImage` → `'rgb'`)
- Modify: `scripts/runner_values_fixtures.py` (key `bilinear`), `scripts/runner_cards_fixtures.py` (keys `empty_image`, `get_image_size`, `image_to_mask`, `text_mask_source`)
- Test: `frontend/tests/unit/runner-bilinear.unit.spec.ts`, `frontend/tests/unit/runner-cards-utilities.unit.spec.ts`

**Interfaces:**
- Consumes: `decodeRaw(bytes, source)` and `PictureSource` (`compositor/decode.ts:34,55`), `pictureSourceOf` (`compositor/plan.ts:30`), `encodeMask`/`decodeMask` (R0.7).
- Produces:
  - `resize.ts`: `bilinearResize(src: Float32Array, sw: number, sh: number, channels: number, dw: number, dh: number): Float32Array` — torch's `upsample_bilinear2d` with `align_corners=False` in float32 (every intermediate through `Math.fround`): `scale = fround(in / out)`; `src = max(fround(scale·(dst + 0.5) − 0.5), 0)`; `i0 = floor(src)`, `i1 = i0 + (i0 < in − 1 ? 1 : 0)`; `l1 = fround(src − i0)`, `l0 = fround(1 − l1)`; `out = fround(l0y·fround(l0x·a + l1x·b) + l1y·fround(l0x·c + l1x·d))`
  - `utilities.ts`: `tensorChannels(raw: RawPicture): 3 | 4` (provider 4; card 4 when any alpha < 255 else 3; load, rgb, blank 3), `planEmptyImage`, `planGetImageSize`, `planImageToMask`, `planTextMaskWithSource`

**Rules:** `EmptyImage` (`local: 'source'`; widgets width/height INT 1..8192, batch_size INT 1..64, color INT 0..16777215 — values ComfyUI allows above these runner caps leave the node to the engine), `GetImageSize` (`local: 'source'`, `mustLink: ['image']`, `imageInputs: ['image']`), `ImageToMask` (`local: 'source'`, `mustLink: ['image']`, `imageInputs: ['image']`, widgets channel COMBO red/green/blue/alpha). None are output nodes.

**Plans:** pictures computed in float are kept as 8-bit PNGs rounded (`round(255·x)`, as the hand-off rounds; spec parity rules); masks as 16-bit. A batch source (several files) gives one result per file, in order. `EmptyImage` keeps one PNG and lists it `batch_size` times. `GetImageSize` reads the size the tensor would have: `decodeRaw` with the wire's `pictureSourceOf` (EXIF turned for `card` and `load`), batch size = the number of files.

**Fixtures:** `bilinear` — `torch.nn.functional.interpolate(t, size=(dh, dw), mode='bilinear', align_corners=False)` on seeded random float32 arrays for 1×1→5×3, 7×5→3×2, 16×16→37×23, 100×1→3×40, 1 and 4 channels, stored as float32 little-endian. `empty_image` — sizes and colours incl. 0 and 0xFFFFFF. `get_image_size` — the real node on a provider-style RGBA file, an EXIF-turned card file, a two-file batch. `image_to_mask` — each channel on RGB and RGBA sources, and the alpha-on-RGB failure. `text_mask_source` — a 40×20 mask on a 64×48 RGB source and on a 64×48 RGBA source, and same-size.

**Test:** `bilinearResize` equals every torch fixture **bit for bit** (compare `Float32Array` bytes); every card fixture equals the runner's derive output (8-bit pictures exactly; masks as 16-bit integers exactly); eligibility with `cards` on and off; engine: EmptyImage → Generate from references is taken and hands off the one kept PNG.

Run the fixture scripts, both tests and the runner suite. Typecheck; report (no commit).

---

### Task R1.5: Save image and Preview image

**Port:** `SaveImage.save_images` — `nodes.py:1627-1776` (format png/webp/jpeg, quality, lossless_webp, png_compression, scale, max_dimension, embed_metadata); `PreviewImage` — `nodes.py:1778-1800` (temp folder, prefix `ComfyUI` + `_temp_` + five letters drawn from `abcdefghijklmnopqrstupvxyz`, compress level 1, png only); `folder_paths.get_save_image_path` — `folder_paths.py:428-473` (`%width%`, `%height%`, `%year%`…`%second%` in local time; subfolder from the prefix; refusal of a folder outside output; the counter).

**Files:**
- Create: `frontend/server/runner/cards/saveImage.ts`
- Modify: `frontend/server/runner/results.ts` (`ResultStore.save` gains `subfolder?: string` and `folder?: 'output' | 'temp'`; `ResultStore.savePreviewAs` for R1.6)
- Modify: `frontend/server/runner/executors.ts` (`DeriveIO.saveAsset` gains `subfolder?` and `folder?`), `frontend/server/runner/engine.ts` (pass them through)
- Modify: `frontend/shared/runner/eligibility.ts` (rows), `frontend/shared/runner/validate.ts` (`RUNNER_OUTPUT_CLASSES` += `SaveImage`, `PreviewImage`)
- Modify: `scripts/runner_cards_fixtures.py` (key `save_image`)
- Test: `frontend/tests/unit/runner-cards-save.unit.spec.ts`

**Interfaces:**
- Consumes: `decodeRaw` + `tensorChannels` (R1.4), `pictureSourceOf`, `DeriveIO`.
- Produces:
  - `ResultStore.save(bytes, { userId, prefix, ext, subfolder?, folder? })` — `subfolder` is joined under the user's folder (hosted) and must stay inside it (`..` and absolute parts refused); `folder` defaults to `'output'`
  - `ResultStore.savePreviewAs(bytes, { filename, userId })` — writes `temp/<local runner subfolder or user folder>/<filename>`, overwriting; `filename` must match `/^[A-Za-z0-9_.-]{1,200}$/`
  - `saveImage.ts`: `saveImagePrefix(prefix: string, w: number, h: number, now: Date): { subfolder: string; filename: string }` (throws "This file name would save outside the output folder"), `insertPngText(png: Uint8Array, entries: [string, string][]): Uint8Array` (tEXt chunks before IEND, Latin-1; Python's `json.dumps` output is ASCII), `planSaveImage(ctx)`, `planPreviewImage(ctx)`

**Rules:** `SaveImage` (`local: 'render'` — spec ruling 5; `mustLink: ['images']`, `required: ['images']`, `imageInputs: ['images']`; widgets as `nodes.py:1638-1650` with their min/max/options); `PreviewImage` (`local: 'render'`, `mustLink: ['images']`, `imageInputs: ['images']`, `outputsNotLinked: [0]`). A `list` value (R1.6) into `images`: saved item by item, as ComfyUI runs the node once per item.

**Behaviour:**
- Pixels: each file decoded as its source's tensor (`decodeRaw` + `tensorChannels`: a provider's picture is RGBA, so it is saved RGBA, as Python does), `trunc(255·x)` is the identity on 8-bit input.
- `scale` then `max_dimension` exactly as `nodes.py:1685-1697`; resize with sharp `lanczos3` (Open question 3: compared within the proposed tolerance, not exactly).
- PNG: sharp `png({ compressionLevel })`, then `insertPngText` with `prompt` = `JSON.stringify(take prompt)` and, when the run kept the workflow, `workflow` = `JSON.stringify(workflow)` — the metadata is JSON-value-equal to Python's (`json.dumps` spacing differs; the test parses both).
- JPEG: flatten onto white when there is alpha (`nodes.py:1736-1742`); `jpeg({ quality, progressive: true, optimiseCoding: true })`. WebP: `webp({ quality, lossless })`. EXIF metadata for JPEG/WebP is not written (Python skips it silently when it can't; the runner always skips it — say so in the report).
- Save image files go to output (assets: `saveAsset` counts each as the run's output, hosted ownership included); Preview image files go to temp, not assets.
- ui: `{ images: [{ filename, subfolder, type }, …] }`, as Python returns.

**Fixtures** (`save_image`): the real `SaveImage().save_images` (temp output dir, `args.disable_metadata` False) over an RGB and an RGBA 8-bit source: png at compression 1 and 9; jpeg at 60 with alpha; webp lossy 80 and lossless; scale 0.5; max_dimension 50; a prefix `a/b/%width%x%height%`; two images in one batch (the counter); `embed_metadata` false; each recording the saved files' names, subfolders, decoded pixels and PNG text chunks. Plus `get_save_image_path` over prefixes with `..`, absolute paths and date variables (with `time.localtime` patched to a fixed moment).

**Test:** names, subfolders and counters equal Python's; PNG pixels identical; PNG text chunks JSON-value-equal; JPEG/WebP and resized pixels within Open question 3's tolerance (mean ≤ 2/255, max ≤ 8/255 per channel) — the test states the tolerance in one constant; hosted: a Save image's file is in the user's folder and counted as the run's output (the kit's `graphRuns.appendOutput` called); a prefix escaping the folder fails the node with the plain message; Preview image writes to temp and is not an output; with `cards` off, both are left to the engine.

Run the fixtures script, the test and the runner suite. Typecheck; report (no commit).

---

### Task R1.6: Smart Layout

**Port** (`comfy_extras/nodes_smart_layout.py`, 591 lines): `_parse_layout` and the starter layout (`_STARTER_LAYOUT`, `_FORMAT_PRESETS` :76-95), `_parse_text_layers` / `_parse_kv` (:385-411), `_template_elements`, `_autopopulate_elements` (:187), `_autopopulate_elements_v2` (:257), `_autopopulate_for_template` (:327), `_resolve_outputs` (:353), `_output_labels` (:370), the brand merge and the props collection of `execute` (:531-577), and `save_live_preview_multi`'s file names (`comfy_extras/_live_preview.py:110-140`: `live_preview_<node>_<safe label>.png`, overwritten each run).

**Files:**
- Create: `frontend/server/templates/renderPng.ts` — `renderTemplatePng(req: RenderRequest): Promise<Uint8Array>`, the body of `server/api/render-template.post.ts` (fonts, `templateToSatori`, `inlineTreeImages`, satori, resvg) moved out unchanged; the route calls it
- Create: `frontend/server/runner/cards/smartLayout.ts`
- Modify: `frontend/server/api/render-template.post.ts`, `frontend/shared/runner/eligibility.ts`, `frontend/shared/runner/validate.ts` (`RUNNER_OUTPUT_CLASSES` += `SmartLayout`), `frontend/server/runner/executors.ts`
- Modify: `scripts/runner_cards_fixtures.py` (key `smart_layout`)
- Test: `frontend/tests/unit/runner-cards-smart-layout.unit.spec.ts`

**Interfaces:**
- Consumes: `RenderRequest` (`server/templates/schema.ts`), `rgbTurnedPng`/`decodeRaw` (hand the renderer each image layer as a `data:image/png` URL of the Python-view picture: the in-process renderer has no HTTP origin; `inlineTreeImages` passes data URLs through), `DeriveIO`, `ResultStore.savePreviewAs` (R1.5).
- Produces: `renderTemplatePng`; `smartLayout.ts`: `parseLayout(raw: unknown): Record<string, unknown>`, `parseTextLayers(raw: string, defaultRole: string): Record<string, string>`, `autopopulateForTemplate(template, props): void`, `resolveOutputs(template, aspects: string): { format: string; id?: string }[]`, `outputLabels(outputs, template): string[]`, `smartLayoutRequests(inputs, imageUrls): RenderRequest[]`, `planSmartLayout(ctx)`

**Rule:** `SmartLayout: { family: 'cards', local: 'render', valueInputs: { brand: ['text'], text_layer_1 … text_layer_8: ['text'] }, imageInputs: ['image_layer_1', …, 'image_layer_8'], widgets: { layout: STRING required, aspects: STRING required, brand_kit: STRING } }`. `OUTPUT_KINDS.SmartLayout` stays files; the value is `{ kind: 'files', files, list: true }`. A list may only be read by `SaveImage` or `PreviewImage` (a new rule field `listReaders` on the SmartLayout row, checked in `graphRuleAllows`); anything else reading it leaves the workflow to the engine (ComfyUI would run a paid node once per item).

**Behaviour:** one render per resolved output, each decoded to RGB and kept as an 8-bit PNG (the value); each also written as a live preview under Python's deterministic name; ui `{ images: [...] }` in output order, as `save_live_preview_multi` returns.

**Fixtures** (`smart_layout`): the pure functions called directly on a spread of layouts (the starter layout; a v1 layout; a v2 layout with `outputs` and variations; an empty string; bad JSON; aspects blank, unknown, repeated) with text and image props and brand/brand_kit combinations — inputs and outputs recorded as JSON; and `execute` with `urllib.request.urlopen` patched to capture each POST body and answer with a 2×2 PNG — the captured bodies recorded, with each image layer's `/view` URL replaced by the saved frame's 8-bit pixels (base64).

**Test:** every pure function deep-equals Python's output; `smartLayoutRequests` builds bodies JSON-value-equal to the captured ones, with image URLs compared by their pixels; `renderTemplatePng` gives the same bytes as the route did before the move for one fixture layout (a snapshot taken before the move, in the test's fixture); engine (kit, `cards` on): Text → SmartLayout `text_layer_1` → SaveImage renders two aspects and saves two files; a SmartLayout read by Edit image is left to the engine.

Run the fixtures script, the test, `tests/unit/render-template*.unit.spec.ts` if present, and the runner suite. Typecheck; report (no commit).

---

### Task R1.7: Controller check, fixture-level, `cards` on (not delegated)

Using the real routes (`toWebHandler`, as `runner-routes.unit.spec.ts` does), the real engine, file store, kept store and metering (hosted mode with the fake ledger), the fake fal and fake Replicate, `NUXT_RUNNER_ENABLED=true`, `NUXT_RUNNER_FAMILIES=frame,fal-edit,restyle,cards`, no provider keys:

- [ ] Primitive → Gate → Generate an image `prompt_in`; Moodboard → Restyle `style_in`; Text → Smart Layout → Save image; 3D Studio → Edit image; LoadImage → Image to mask; each from `POST /api/runs` to the last event on `/api/runs/events`. Each request deep-equals its fixture; each charge equals `priceGraph` for the paid nodes that ran.
- [ ] A restart halfway through a paid node that reads a value: the value is still read after the restart; the kept bytes are still there; the node is charged once.
- [ ] A blocked word in a Text card is refused before any hold; the same word through a Gate fails only that node and releases its hold.
- [ ] With `cards` off: every workflow above is refused by `/api/runs` exactly as before step 3, and `nodesNeedingEngine` names the cards.
- [ ] The full unit suite is green with the provider keys unset; typecheck clean; `runner-builders.json` unchanged.
- [ ] Browser check on the shared :3002 server (the controller's, never a subagent's): one Text → Generate an image workflow run with `cards` on in the local `.env`, reusing a saved seed so it costs nothing; the Text card shows its value; Save image's file appears in Assets.

Record the results in `.superpowers/sdd/engine-free-step3/progress.md` and `docs/STATE.md`. `cards` stays off in hosted until the user says otherwise (it spends no money, but it changes which workflows the runner takes).

---

# R2 — Picture effects

R2 moves the 78 still-picture effects of the toolbox (inventory §1(b)), Painter (spec ruling 4) and the Shader effect (decision 9) into the runner, then moves their live previews off the engine. The effects are grouped by the machinery they share, not by Python file. The outline's R2a/R2b split by file is replaced; decision 8's parity rule, the per-node pixel cap and one-file-at-a-time rule from the ledger, and the start-of-take refusals from R1.3 all carry over.

**Order.** R2.1 (the machinery, with three pilot effects) comes first. R2.2 (sampling and convolution kernels) and R2.3 (torch's random numbers) can run in parallel after it. R2.4–R2.9 are one family each. Each needs R2.1; the "Consumes" line of each names the kernels it needs. R2.10 (Shader effect) needs only R2.1 and R1.3. R2.11 (live previews) comes after at least one effects family is built. R2.12 is the controller's check.

**Families** (each off by default, each honoured only while `cards` is on; see R2.1):

| Family | Task | Classes |
|---|---|---|
| `effects-tone` | R2.1 (pilots), R2.4 | 29 per-pixel tone, colour and light effects |
| `effects-blur` | R2.5 | 13 blur and convolution effects |
| `effects-cells` | R2.6 | Pixelate, Halftone, Kuwahara, Ascii |
| `effects-warp` | R2.7 | 15 geometry and coordinate-warp effects |
| `effects-mask` | R2.8 | 6 mask and blend effects, and Painter |
| `effects-noise` | R2.9 | 11 generators, seeded looks and Add noise |
| `shader-bake` | R2.10 | Shader effect, replayed from the browser's bake |
| `live-previews` | R2.11 | the preview route (no class of its own) |

## Rules every effect follows (binding for R2.1 and R2.4–R2.9)

1. **Rows.** Each class's rule row comes from the generated schema table (R2.1). The row has `family: <its family>`, `local: 'render'` (it writes a live preview file, as Preview image does, so it counts as work; see "Controller rulings needed" (a)), the class's widgets with ComfyUI's min/max/options, `imageInputs` for its IMAGE inputs, and `valueInputs: { <mask input>: ['mask'] }` for its MASK inputs. It is added to `SWITCHED_CLASSES` and `RUNNER_OUTPUT_CLASSES`: every one of them is `is_output_node=True` in Python.
2. **A picture in is the tensor Python holds.** The runner decodes it with `decodeRaw` and the wire's `pictureSourceOf`, then builds the float32 planar tensor with the channel count `tensorChannels` gives (3 or 4) and `channelTable`'s values (an Image card's alpha goes through its 1 − mask round trip). A mask in is decoded from the kept 16-bit PNG (`decodeMask`, u / 65535 in float32).
3. **A picture out.** Each result file is kept as an 8-bit PNG with the tensor's own channels (RGB or RGBA). The bytes are `round(255·clamp(x))` (the hand-off's rounding), unless `onlySavesRead` says only Save image / Preview image read it, in which case they are `trunc(f32(255·x))` (the R1.5 rule). A mask out is kept as the runner's 16-bit mask. The new wire source `'tensor'` (R2.1) reads it back with the channels it was written with.
4. **The live preview.** Python's `save_live_preview(preview, unique_id)` (`comfy_extras/_live_preview.py:23-63`) writes `live_preview_<node id>.png` into temp, compress level 1, from the first picture of the batch, as `np.clip(255·x, 0, 255).astype(uint8)` with the preview tensor's own channels. The runner writes the same pixels under the same name with `DeriveIO.savePreviewAs`. Its ui is `{ images: [{ filename, subfolder: '', type: 'temp' }], animated: [false] }`. The preview tensor is whatever the Python passes. That is usually output 0, but not always (Threshold mask shows image × mask, Merge alpha shows rgb × mask, and so on); each task names the exceptions. A node id that doesn't fit `savePreviewAs`'s name rule (`/^[A-Za-z0-9_.-]{1,200}$/` after the prefix) leaves the node to the engine (an eligibility check).
5. **Batches.** One result per input file, in order. An effect is one of three kinds:
   - `pure` works on each file alone, so a file listed twice is worked on once.
   - `coupled` carries state across the batch in file order: a shared random stream, one k-means over every picture, one noise field for the batch. Nothing is deduplicated.
   - `generator` has no picture input.

   Where two inputs are batched (Blend's base and top, a picture and a mask), their counts must be equal or one of them 1, as torch broadcasts. Anything else fails with `EFFECT_BATCHES_DIFFER`.
6. **Where Python raises, the runner fails the node with plain words.** Each fixture case where Python raises records the exception, and the test maps it to one message:
   - `EFFECT_NEEDS_RGB` = "This effect can’t work on a picture with see-through parts". This covers torchvision's `_assert_channels(img, [1, 3])` on 4 channels, a 3-colour target against 4 channels, and similar cases. A provider's picture is always 4 channels in Python (`compositor/decode.ts`), so for example Generate an image → Adjust color fails in Python today; the runner keeps that (spec: a known quirk is kept). See "Controller rulings needed" (c).
   - `EFFECT_PICTURE_TOO_SMALL` = "This picture is too small for this setting. Lower the setting or use a larger picture." This covers reflect padding of at least the picture's side, and an area resize down to 0 pixels.
   - `EFFECT_BATCHES_DIFFER` = "The pictures this effect combines come in different numbers".
7. **Caps, from headers, before any pixel is decoded** (the `sizes()` pattern of `cards/utilities.ts`):
   - One picture in or out is at most `EFFECT_MAX_PICTURE_PIXELS` = 8192² (hosted: `HOSTED_MAX_FRAME_ARTBOARD_PIXELS` = 4096²).
   - All the node's pictures together are at most `CARD_MAX_PIXELS`.
   - Each class may declare `work(widgets, size)` (pixel·steps). Its budget `EFFECT_MAX_WORK` is measured by R2.1 so the heaviest allowed case finishes in under 60 s on the development Mac. Past it the node fails with "This effect would take too long on a picture this size. Use a smaller picture or a lighter setting."
   - An output size known from the widgets alone (generators, Resize image's scale on a known input) is checked at eligibility where possible (an `inputCheck`), otherwise at the node's turn.
8. **Pixel work runs on the Frame's worker** (`pixelsInWorker`: its queue, 2-minute watchdog, Stop flag), one distinct file at a time: decode on the main thread, compute on the worker, encode on the main thread, let go. The effect cores are self-contained functions, as `pixelsCore` is. `workerScript` composes them from their source text, and the esbuild guard in `runner-compositor-engine.unit.spec.ts` covers the new cores too.
9. **Start-of-take refusals.** A picture an effect reads straight from an Image card or LoadImage goes through the same header check at the start of the take as the cards (`cardPictureFiles` beside `engine.ts:1552`): 16-bit, 32-bit, CMYK, a see-through GIF or an unreadable kind is refused before the hold.
10. **Parity classes.** Every kernel and every effect is marked *exact* or *library*.
    - *Exact*: what torch computes with plain IEEE float32 steps whose order the runner can reproduce. That covers + − × ÷, `sqrt`, `floor`, `round` (half-to-even), `clamp`, `where`, `max`/`min`, fmod-based `remainder`, `linspace`, nearest/bilinear/bicubic/area resizing, `grid_sample`, avg and max pooling, `roll`, `flip`, and torch's `pow` special cases (exponent 2 is `x·x`, 0.5 is `sqrt`, 3, −1, −2, −0.5). An exact result equals Python's float32 **bit for bit**.
    - *Library*: what torch leaves to library code whose order or rounding the runner can't see. That covers `conv2d` (and so torchvision's `gaussian_blur`), long sums and means (`torch.mean` over a picture, k-means centres), transcendental functions (`exp`, `pow` with other exponents, `sin`, `cos`, `tan`, `atan2`, `log`), `affine_grid`'s matrix product, and `topk` among equal values.
    - A library result is accepted when its 8-bit output (preview and kept file) equals Python's except at pixels where Python's float lies within ε of a quantisation boundary, and there differs by exactly one level. ε is per kernel, measured, written in the test as a constant, and at most 2⁻⁸ in 255-scale. This is the operational meaning of "pixel-exact" proposed for the controller's ruling (see "Controller rulings needed" (b)). Python's own output moves by the same amount between machines (this Mac's arm64 torch without oneDNN, against x86 Linux).
11. **Fixtures.** `scripts/runner_effects_fixtures.py --group <g>` writes `frontend/tests/unit/fixtures/runner-effects-<g>.json`, one file per task. Running it again gives identical bytes; the other groups' files are untouched.
    - It blocks the network before any node module is imported, runs at torch's default thread count (it refuses 1 thread, as FR1's generator does), and records `torch.__version__`, the thread count and the platform in the file.
    - It calls each **real** node's `execute` with `cls.hidden.unique_id` set, reads the preview file Python wrote, and records the output tensors.
    - Input pictures are made by `synth` (R2.1) and fed through the real Python loader of their source:
      - 'rgb': the Frame's `rgb` reading;
      - 'provider': `bytesio_to_image_tensor`, as R1.5's fixtures do;
      - 'card': the Image card's loader, as R1.3's fixtures do;
      - 'mask': a 16-bit PNG as u / 65535.
    - **The standard case set**, per class:
      - every widget at its default;
      - each numeric widget at its min, its max and one value in between, one at a time;
      - every COMBO option and both values of each BOOLEAN;
      - an 'rgb' 37×23 picture, a 'provider' 29×31, a 'card' 23×19 with partial alpha (4 channels) and a 'card' 23×19 fully opaque (3 channels);
      - a batch of two different files plus a repeat;
      - the 1×1 blank of an empty Image card;
      - one 'rgb' 320×200 case (hashed);
      - every case where Python raises.
    - Small cases record the output float32 (base64). The large case records the sha256 of its float32 bytes, of its 8-bit round and of its 8-bit trunc, and its band list `[[index, pyTrunc8, pyRound8], …]` (pixels within ε of a boundary).
12. **Tests** go in `frontend/tests/unit/runner-effects-<g>.unit.spec.ts`, with the shared helpers in `tests/unit/__runner__/effectsParity.ts` (R2.1). For every fixture case:
    - the core, called in this thread, gives the float32 output: bit-identical for an *exact* effect, within the band for a *library* one;
    - through `planEffect` with the kit (`cards` and the family on), the kept PNG decodes to Python's `round8` and the preview to Python's `trunc8` (up to the band for *library*);
    - the ui equals Python's;
    - a Python raise is the runner's message.

    Plus, per task:
    - with the family off, a workflow with the class is left to the engine and `nodesNeedingEngine` names it;
    - with **every** effects family off, the needs-engine list over every saved project graph (`user/sailor/projects/*`) is identical to before R2.1;
    - an effect feeding Generate an image hands off its kept round-8 PNG;
    - an effect → Save image saves the trunc picture;
    - an effect → Frame renders as if the Frame read the kept PNG.
13. **Every task's run line:** `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_effects_fixtures.py --group <g>` (twice, then `git diff --stat` shows the group file unchanged the second time), then `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-effects-<g>.unit.spec.ts tests/unit/runner-`. Also run the typecheck from the Global Constraints, and report (no commit).

### Task R2.1: The effects machinery, with three pilot effects

Builds everything R2.4–R2.9 share and proves it on three *exact* per-pixel effects of family `effects-tone`.

**Port (pilots):**
- `AdjustExposure`, `comfy_extras/nodes_adjust_exposure.py:9-43`: `image.clamp(0,1)` when exposure is 0; otherwise `(image * f32(2.0 ** exposure)).clamp(0, 1)`. The Python double `2.0 ** exposure` is rounded to float32 once, as torch does with a scalar.
- `AdjustInvert`, `comfy_extras/nodes_color_filters.py:259-281`: `(image * (1 − a) + (1 − image) * a).clamp(0, 1)`, op by op.
- `AdjustThreshold`, `nodes_color_filters.py:306-330`: `luma = 0.2126·r + 0.7152·g + 0.0722·b` (`_luma` :12-13: each product rounded, then `(p0 + p1) + p2`); `mask = (luma > t)`, expanded over **every** channel of the tensor (alpha too, on 4 channels).

**Files:**
- Create `scripts/runner_effect_rows.py`. It imports each effect class (network blocked) and writes `frontend/shared/runner/effectSchemas.generated.ts` from the real `define_schema()`: for each class its IMAGE and MASK inputs (and which are optional), its widgets as `RunnerWidgetSpec` (type, min, max, options, required) and its outputs (`'image' | 'mask'`). The class list, with each class's family, lives in the script. Running it twice gives identical bytes.
- Create `frontend/shared/runner/effectSchemas.generated.ts` (generated; not hand-edited).
- Create `frontend/shared/runner/effects.ts`. It holds `EFFECT_FAMILY_OF: Record<string, EffectFamily>`, `effectRows(): Record<string, RunnerNodeRule>` (built from the schemas under rule 1), `EFFECT_OUTPUT_KINDS` (a mask output is `'mask'`), and `EFFECT_PICTURE_OUTPUTS` (the image slots).
- Modify `frontend/shared/runner/families.ts`: add the eight families of the table above to `RunnerFamily` and `RUNNER_FAMILIES`; add `FAMILY_REQUIRES: Partial<Record<RunnerFamily, RunnerFamily>>` (every `effects-*`, `shader-bake` and `live-previews` require `cards`); `parseFamilies` drops a family whose requirement is off. The effects read Image cards and LoadImage and pass masks, which are all `cards` machinery (R1.3's gating).
- Modify `frontend/shared/runner/eligibility.ts`:
  - spread `effectRows()` into `RUNNER_NODE_RULES` and each class into `SWITCHED_CLASSES` with its family;
  - `PICTURE_OUTPUTS` gains `EFFECT_PICTURE_OUTPUTS`, and `carriesImage` counts an effect's picture slot only while its family is on;
  - generalise `outputKindsFor(families)` so each class's declared kinds apply only while its family is on (today it is special-cased for `cards`);
  - add `INPUT_CHECKS['effect-preview-name']` (rule 4) and `INPUT_CHECKS['effect-output-size']` (rule 7, where known).
- Modify `frontend/shared/runner/validate.ts` (`RUNNER_OUTPUT_CLASSES` gains every effect class).
- Modify `frontend/server/runner/compositor/decode.ts` and `compositor/plan.ts`:
  - `PictureSource` gains `'tensor'`, a picture an effect made;
  - `decodeRaw(bytes, 'tensor')` reads the PNG's IHDR colour type (`pngColourType`) and returns the picture as source `'provider'` (4 channels, alpha as it is, no EXIF turn) when it has alpha, else `'rgb'`. The Frame's `toTensor` is unchanged;
  - `pictureSourceOf` returns `'tensor'` for every image slot of an effect class.
- Create `frontend/server/runner/effects/core/tensor.ts`. It holds `tensorCore(px: PixelsCore)`, self-contained apart from its argument, which works on `Tensor { c: number; h: number; w: number; data: Float32Array }` (planar, C × H × W):
  - `fromPicture(p: PixelsPicture): Tensor` (rule 2);
  - `fromMask16(scanlines, w, h): Tensor`;
  - `quantize(t, 'trunc' | 'round'): Uint8Array` (interleaved, `t.c` channels; trunc as `saveBytes`, round half-to-even of `f32(clamp·255)` as `clip`);
  - `mask16(t): Uint8Array` (`pixels.mask16Of`);
  - `s32(x)` = `Math.fround` (a Python double scalar meeting a tensor);
  - `luma709(t): Float32Array` (the `_luma` order above);
  - `EFFECT_ERRORS` (the three message keys of rule 6, thrown as `Error(key)` and mapped on the main thread).
- Create `frontend/server/runner/effects/core/tone.ts`, which holds `toneCore(k: TensorCore)`. It starts with the three pilots and grows in R2.4.
- Create `frontend/server/runner/effects/table.ts`. It holds `EFFECTS: Record<string, EffectSpec>` and `effectSpec(classType): EffectSpec | undefined`:

  ```ts
  export interface EffectSpec {
    family: EffectFamily
    /** The worker op that runs one picture (or one generator frame): '<core>.<fn>'. */
    op: string
    batch: 'pure' | 'coupled' | 'generator'
    /** Checked from widgets and the first picture's size before decoding (rule 7). */
    work?(widgets: Record<string, unknown>, size: { w: number; h: number } | null): number
    /** The output size when it isn't the input's (Crop, Resize, generators). */
    outSize?(widgets: Record<string, unknown>, size: { w: number; h: number } | null): { w: number; h: number }
  }
  ```
- Create `frontend/server/runner/effects/plan.ts` with `planEffect(ctx: PlanContext): NodePlan` (a `derive` plan). It:
  - reads the wired pictures and masks (the `wired`, `sizes` and `decoded` helpers, moved from `cards/utilities.ts` into `effects/io.ts` and re-exported where they were);
  - applies the caps (rule 7);
  - runs the op on the worker one file at a time (`batch` rule 5, with `fx.begin` / `fx.run` / `fx.end`);
  - keeps each output (rule 3) and writes the preview from the first file (rule 4);
  - returns `{ values, ui }`.
- Modify `frontend/server/runner/compositor/worker.ts`:
  - `workerScript` also composes `tensorCore`, `kernelsCore` (R2.2), `rngCore` (R2.3) and the effect cores, each from its source text, in dependency order;
  - add ops `fx.begin { cls, params, count }`, `fx.run { cls, params, inputs: Record<string, PixelsPicture | { mask16, w, h }>, first: boolean, want: { round: boolean[]; trunc: boolean[] } }` returning `{ outputs: ({ w, h, channels, round8?, trunc8? } | { w, h, mask16 })[], preview?: { w, h, channels, px } }`, and `fx.end`;
  - `PixelsWorker` gains `effectBegin`, `effectRun` and `effectEnd`;
  - a Stop check every 64 rows inside each op, as `pilResize` does.
- Modify `frontend/server/runner/executors.ts`: before the default case, `const fx = effectSpec(n.class_type); if (fx) return planEffect(ctx)`.
- Modify `frontend/server/runner/engine.ts`: the start-of-take check (rule 9) takes the effects' picture inputs through `cardPictureFiles`.
- Create `scripts/runner_effects_fixtures.py`. It contains:
  - the shared helpers: `block_network`, the thread check, `synth`, the source loaders, `run_node(cls, **inputs)`, `band_list`, and the writer;
  - group `machinery`: `synth` itself (10 pictures, their bytes' sha256), the three pilots over the standard case set, and `save_live_preview` of a 4-channel tensor (proving the preview keeps RGBA).
- Create `frontend/tests/unit/__runner__/effectsParity.ts`:
  - `synth(w, h, channels, seed): Uint8Array` (below);
  - `pictureOf(case)`;
  - `expectExact(ts: Float32Array, pyB64: string)`;
  - `expectBand(ts8: Uint8Array, py8: Uint8Array, pyF32: Float32Array | null, band: [number, number, number][] | null, eps: number, mode: 'trunc' | 'round')`;
  - `runEffectCase(case, { families })`, which runs the case through `planEffect` with the kit.
- Create the tests `frontend/tests/unit/runner-effects-machinery.unit.spec.ts` and `runner-effects-rows.unit.spec.ts`.

**`synth`** is the same in Python and TypeScript, and it is the fixture's first case (the bytes' sha256 must agree):
```
s = (seed >>> 0) || 0x9e3779b9
next(): s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s
for y in 0..h-1, x in 0..w-1, k in 0..channels-1 (in that order):
  k < 3:  byte = ((x * 37 + y * 11 + k * 71) & 255) ^ (next() & 31)
  k == 3: r = next(); byte = (x + y) % 5 == 0 ? 0 : (x * y) % 3 == 0 ? 255 : r & 255
```
It gives gradients, texture, fully see-through, fully opaque and partial alpha. Pictures go to Python as PNGs written by PIL, and to the runner as the same PNG bytes.

**Behaviour:**
- `local: 'render'`. The node's value is `{ kind: 'files', files }` (or `'mask'`) per output slot, one file per input file. A 1×1 blank in gives Python's result for its 1×1 black tensor.
- With every effects family off, nothing changes: eligibility, `nodesNeedingEngine`, `OUTPUT_KINDS` and `PICTURE_OUTPUTS` are byte-for-byte as before, over every saved project graph.
- `EFFECT_MAX_WORK` and the two pixel caps are exported from `shared/runner/effects.ts`. The implementer measures the worker's speed on the pilots and on a stand-in convolution (a 2k-tap separable pass over 8192² × 4), and writes the numbers into the report.

**Test (`runner-effects-machinery`), each a separate `it`:**
- `synth` agrees with Python on the 10 recorded pictures;
- every pilot fixture case passes as described in rule 12 (the pilots are *exact*: bit-identical floats);
- a 'provider' picture through Adjust threshold keeps 4 channels: the kept PNG is RGBA and the preview is RGBA, as Python writes it;
- the wire source `'tensor'` of an RGBA kept PNG reads as 4 channels and of an RGB one as 3, in a following pilot and in a Frame;
- batch: two files and a repeat give three results in order, the repeat worked on once (a spy on `fx.run`); a 1×1 blank gives Python's 1×1 result;
- caps: a picture over 8192² (header only, never decoded) fails with the plain message before any `fx.run`; hosted over 4096² fails; the total over `CARD_MAX_PIXELS` fails;
- Stop mid-batch: the worker stops within one 64-row block, and nothing is written after `live` aborts;
- a picture from an Image card whose file is 16-bit is refused at the start of the take, before the hold (rule 9);
- families: with `effects-tone` on and `cards` off, `parseFamilies` drops `effects-tone`, and the workflow is left to the engine;
- `runner-effects-rows`: `effectSchemas.generated.ts` has exactly the 78 classes plus Painter, and every row's widgets are the generated ones.

**Acceptance:** the three pilots are bit-exact on every fixture case; the families-off invariant holds; `runner-compositor*.unit.spec.ts` and `runner-cards-*.unit.spec.ts` stay green unchanged; the esbuild guard passes with the new cores.

---

### Task R2.2: Kernels for sampling, pooling and convolution, and torchvision's colour operations

No family: a library the effect tasks call, proven kernel by kernel against torch before any effect uses it.

**Files:**
- Create `frontend/server/runner/effects/core/kernels.ts` with `kernelsCore(k: TensorCore, px: PixelsCore)` (self-contained apart from its arguments).
- Modify `scripts/runner_effects_fixtures.py` (group `kernels`).
- Test: `frontend/tests/unit/runner-effects-kernels.unit.spec.ts`.

**Interfaces (all float32 in, float32 out; `t` planar; "cl" means the torch tensor is channels-last in memory, which only matters where noted). Each entry is marked *exact* or *library* (rule 10):**

| Function | Torch it reproduces | Class |
|---|---|---|
| `linspace(a, b, n): Float32Array` | `torch.linspace` float32: `step = (b − a)/(n − 1)`; index below `n/2`: `a + step·i`, else `b − step·(n − 1 − i)` (verify against the fixture; ATen `RangeFactoriesKernel.cpp`) | exact |
| `arange(n)` | `torch.arange` float32 | exact |
| `remainder(a, b)` | `torch.remainder` float (`%` on tensors), scalar and vectorised paths | exact |
| `powScalar(t, e)` | `pow` with a Python-float exponent: special cases 2, 3, 0.5, −0.5, −1, −2; else `powf` | exact on the special cases, else library |
| `unary(t, 'exp' \| 'sin' \| 'cos' \| 'tan' \| 'log' \| 'atan2')` | float32 transcendental functions, computed in double and rounded once | library |
| `areaOutSize(inSize, scaleFactor)` | `F.interpolate(scale_factor=…)` output size: `floor(double(in) · scale)` | exact |
| `resizeArea(t, oh, ow)` | `F.interpolate(mode='area')` = `adaptive_avg_pool2d`: window `[floor(i·in/out), ceil((i+1)·in/out))`, row-major float sum, then divide | exact |
| `resizeNearest(t, oh, ow)` | `mode='nearest'`: `min(floor(dst · f32(in/out)), in − 1)`, with torch's equal-size and 2× shortcuts | exact |
| `resizeBilinear(t, oh, ow, cl)` | R1.4's `pixels.bilinear` (reused, not copied) | exact |
| `resizeBicubic(t, oh, ow)` | `mode='bicubic', align_corners=False`: A = −0.75, unclamped source index, clamped taps (ATen `UpSampleKernel.cpp`) | exact |
| `gridSample(t, gx, gy, { padding: 'zeros' \| 'border' \| 'reflection', alignCorners })` | `F.grid_sample(mode='bilinear')`: unnormalise, then clip or reflect (`grid_sampler_compute_source_index`), then the four taps (`GridSamplerKernel.cpp`, the vectorised path) | exact |
| `affineGrid(theta, h, w)` | `F.affine_grid(align_corners=False)`: base grid `linspace(−1, 1, n)·(n − 1)/n`, times θᵀ | library |
| `avgPool2d(t, k, pad)` | stride 1, `count_include_pad=True`, `ceil_mode=False` | exact |
| `avgPool2dStrided(t, k)` | `avg_pool2d(kernel_size=k)` (stride k, no padding: Ascii, Stipple) | exact |
| `maxPool2d(t, k, pad)` | stride 1, −∞ padding | exact |
| `padReflect(t, l, r, top, bottom)` | `F.pad(mode='reflect')`; a pad ≥ the side throws `EFFECT_PICTURE_TOO_SMALL` | exact |
| `conv2dDepthwise(t, kernel, kh, kw)` | `F.conv2d(groups=c)` on a padded tensor | library |
| `conv2dSame(t1, kernel, kh, kw, pad)` | `F.conv2d(padding=p)` with zero padding, one channel (Outline, relief) | library |
| `gaussianKernel1d(ksize, sigma)` | torchvision `_get_gaussian_kernel1d` (`.venv/…/torchvision/transforms/_functional_tensor.py:727-734`) | library (exp) |
| `gaussianBlur(t, ksize, sigma)` | torchvision `gaussian_blur` (`:746-765`): reflect pad of ksize/2, then the 2-D kernel `k_y[:,None] @ k_x[None,:]` depthwise. The runner computes it **separably with float64 accumulation**, rounded to float32 once per output: mathematically the same kernel, faster (2k taps instead of k²), and nearer the true value than torch's own float sums; the band covers the difference | library |
| `rgbToGrayscale(t)` | `(0.2989·r + 0.587·g + 0.114·b)`, op by op (`:148-169`); 4 channels throws `EFFECT_NEEDS_RGB` | exact |
| `blend(a, b, ratio)` | `_blend` (`:258-261`): `(ratio·a + (1 − ratio)·b).clamp(0, 1)` | exact |
| `adjustBrightness(t, f)` / `adjustSaturation(t, f)` | `:171-180`, `:224-235` | exact |
| `adjustContrast(t, f)` | `:182-196`: the mean of the greyscale over the whole picture (`torch.mean`: port ATen's cascade sum; library if not bit-exact) | library |
| `adjustHue(t, f)` | `:199-222`, `_rgb2hsv` / `_hsv2rgb` (`:264-330`) | exact |
| `meanAll(plane)` | `torch.mean` of one plane (ATen `SumKernel.cpp` cascade sum) | exact if the port matches, else library |
| `topk(values, k, largest)` | the indices of the k largest; ties by lowest index | exact where values differ; ties are the band case (the test accepts any choice among values tied at the cut, and the fixture records the cut value) |

**Fixtures (`kernels`):** each function on seeded float32 tensors (`torch.manual_seed(0)`, stored as their float32 bytes or rebuilt from the seed and hashed, as R1.4's `bilinear`):
- sizes 1×1, 2×3, 7×5, 37×23 and 320×200;
- 1, 3 and 4 channels, contiguous and channels-last;
- resizes up, down, non-integer and equal (area 320×200 → 213×133, → 80×50, → 1×1; nearest 2× and 3×; bicubic 17×13 → 64×48);
- `grid_sample` with grids inside, on and outside [−1, 1] in each padding and both `align_corners`;
- pools with k = 1, 2, 3, 13 and pads 0 and k//2;
- `padReflect` up to side − 1 and the failure at side;
- `conv2d` with 3×3 Sobel, the emboss kernel, a 17×17 motion kernel and a 21×21 disk;
- gaussian kernels for (ksize, σ) = (3, 0.3), (7, 1), (31, 5), (61, 10), (181, 30), (301, 50), and `gaussian_blur` on a 64×48 4-channel picture for each;
- `adjust_*` over each factor's range, and hue at ±0.5;
- `torch.mean` of planes of 1, 15, 16, 17, 4096 and 64 000 elements;
- `topk` with ties.

For library kernels the fixture also records the band list at ε candidates 2⁻¹², 2⁻¹⁰ and 2⁻⁸.

**Test:** every exact kernel equals torch bit for bit (compare `Float32Array` bytes). Every library kernel is within its ε (the smallest candidate that passes, written as a named constant per kernel and reported). `gaussianBlur`'s float error against torch is reported as a maximum |Δ| per (ksize, σ). There is also a speed check: `gaussianBlur(ksize 181)` on 1024² × 4 finishes within the budget R2.1 set.

**Acceptance:** every *exact* kernel is bit-exact. If one can't be made so, the implementer stops and reports rather than downgrading it. Every *library* kernel is within ε ≤ 2⁻⁸.

---

### Task R2.3: Torch's CPU random numbers

No family: the port that the seeded looks (R2.9) and Add noise use.

**Files:**
- Create `frontend/server/runner/effects/core/rng.ts` with `rngCore()` (self-contained).
- Modify `scripts/runner_effects_fixtures.py` (group `rng`).
- Test: `frontend/tests/unit/runner-effects-rng.unit.spec.ts`.

**Interfaces:**
```ts
export interface TorchGenerator {
  /** torch.Generator().manual_seed(seed): mt19937 initialised from the seed's low 32 bits; the cached normals cleared. */
  seed(seed: bigint | number): void
  random(): number            // one 32-bit mt19937 draw (CPUGeneratorImpl::random)
  random64(): bigint          // two draws, as make64BitsFrom32Bits
  /** torch.rand(n, dtype=float32): serial, one random() per element, (x & (2^24 − 1)) · 2^-24. */
  rand(n: number): Float32Array
  /** torch.randn(n, dtype=float32): n < 16 → normal_distribution<double> per element (random64, Box–Muller, the cached second sample); n ≥ 16 → normal_fill (uniforms first, then Box–Muller in float over blocks of 16, the tail recomputed on the last 16), as ATen's DistributionTemplates / cpu normal_kernel. */
  randn(n: number): Float32Array
  /** torch.randperm(n): as randperm_cpu does for this n. */
  randperm(n: number): Int32Array
}
export function rngCore(): { generator(): TorchGenerator }
```
The implementer reads the torch 2.10 sources for the exact paths (`aten/src/ATen/core/MT19937RNGEngine.h`, `CPUGeneratorImpl.cpp`, `native/cpu/DistributionTemplates.h`, `native/cpu/DistributionKernels.cpp`, `native/TensorFactories.cpp` `randperm_cpu`), and states in the header comment which path each function follows.

**Fixtures (`rng`):**
- seeds 0, 1, 42, 123456789 and 2³¹ − 1;
- `rand(n)` for n = 1, 7, 15, 16, 17, 100 and 10 000;
- 50 calls of `rand(1).item()` from one generator (Glitch);
- `rand(points, 2)` then `rand(points, 3)` from one generator (Voronoi);
- `randn(n)` for n = 1, 2, 15, 16, 17, 31, 33 and 10 000;
- `randn(1, 1, gh, gw)` for FilmGrain's sizes;
- `randperm(n)` for n = 2, 10 and 9216;
- the interleaving `rand` → `randn(15)` → `randn(16)` → `rand`, to prove the state and the cached normal carry across calls.

Each case records its float32 or int64 bytes (a sha256 plus the first 64 values explicit).

**Test:**
- `random` and `rand` are bit-exact on every case, and on 10 000 draws for three seeds;
- `randperm` is exact;
- `randn` is bit-exact wherever torch's float `log`/`sin`/`cos` (this Mac's libm) rounds as the correctly rounded value does. Any other draw must be within 1 ulp, and those mismatches are counted and reported (expected: none or a handful). They are why the seeded looks that use `randn` are *library*.

**Acceptance:** `rand`, `random`, `random64` and `randperm` are exact on every fixture; `randn` is within 1 ulp on all and exact on at least 99.9% of draws.

---

### Task R2.4: Tone, colour and light effects (family `effects-tone`)

**Port** (all `pure` and per-pixel, with no neighbourhood, into `effects/core/tone.ts`):

| Class | Python | Notes | Class |
|---|---|---|---|
| AdjustBrightnessContrast | `nodes_adjust_brightness_contrast.py:10-54` | torchvision brightness, then contrast; 4 channels raises | library (contrast's mean) |
| AdjustColor | `nodes_adjust_color.py:10-65` | hue (`hue/360`), saturation, then lightness = `adjust_brightness`; 4 channels raises | exact |
| AdjustCurves | `nodes_adjust_curves.py:9-64` | `+blacks`, clamp, `pow(1/midtones)`, `·whites`, clamp | library (pow) |
| AdjustExposure, AdjustInvert, AdjustThreshold | R2.1 | pilots | exact |
| AdjustLevels | `nodes_adjust_levels.py:9-61` | `in_white = max(white, black + 1e-6)` in double; `pow(1/gamma)` | library |
| AdjustTemperature | `nodes_color_filters.py:16-45` | writes channels 0–2 only; alpha kept | exact |
| AdjustVibrance | `:46-79` | `x.max/min(dim=-1)` over **every** channel (alpha too on 4); `pow(2.0)` is `x·x`; `_luma(x).expand_as(x)` | exact |
| AdjustColorBalance | `:80-126` | `pow(2.0)` | exact |
| AdjustBlackWhite | `:127-154` | weights in double, each rounded to float32 as a scalar | exact |
| AdjustPhotoFilter | `:155-191` | the preset tint is `view(1,1,1,3)`; 4 channels raises (a broadcast error) | exact |
| AdjustGradientMap | `:192-221` | `_gradient_map.py:84-106` `gradient_lut` (bucketize, the flat hold) and `apply_gradient_map`, with a `parse_stops` port (JSON tolerant as Python; the Moodboard `pyStrip` precedent) | exact |
| AdjustChannelMixer | `:222-258` | 3 channels out whatever comes in (alpha dropped) | exact |
| AdjustPosterize | `:282-305` | `floor(x·(n−1) + 0.5)/(n−1)` | exact |
| AdjustVignette | `nodes_tone_extras.py:28-64` | `_radial_falloff` :14-25 (`linspace`, `sqrt`, smoothstep) | exact |
| AdjustShadowsHighlights | `nodes_tone_extras.py:109-145` | | exact |
| Duotone | `nodes_glsl_grading.py:15-43` | `_gradient_map.py:109-117` `apply_duotone`, `parse_duotone`, `hex_to_rgb`; output 3 channels | exact |
| SplitToning | `nodes_glsl_grading.py:44-83` | `l.pow(e)` with e from the balance | library |
| GradientMap | `nodes_glsl_unicorn.py:65-111` | `_hex_to_rgb` :28-38 (`h.strip()`: Python's `str.strip`, i.e. `pyStrip`) | exact |
| Posterize | `nodes_glsl_unicorn.py:112-157` | per channel, or luma-scaled | library (pow) |
| Hologram | `nodes_glsl_unicorn.py:316-372` | `torch.tensor(angle·π/180)` in float32, then `cos`/`sin` of the tensor | library |
| TwoDLight | `nodes_glsl_unicorn.py:530-592` | four blend modes; `pow(falloff)` | library |
| LightLeak | `nodes_glsl_atmosphere.py:78-123` | `exp`; the colour is `view(1,1,1,3)` (4 channels raises) | library |
| LensFlare | `nodes_glsl_atmosphere.py:166-243` | ghosts loop in Python doubles; `exp` | library |
| Caustics | `nodes_glsl_lab.py:225-275` | five sine layers; `abs().pow(2.5)` | library |
| Blinds | `nodes_glsl_lab.py:276-329` | `(perp·count) % 1.0` (tensor remainder) | exact |
| CrossHatch | `nodes_glsl_stylize.py:150-201` | `%` on `arange` grids; output expanded to the input's channel count | exact |
| Dither | `nodes_glsl_stylize.py:202-231` | the Bayer tile `_BAYER_4 / 16`; `.round()` half-to-even | exact |

That is 29 classes. The three pilots are already in.

**Files:** modify `effects/core/tone.ts`, `effects/table.ts` (entries), `scripts/runner_effect_rows.py` (the classes into `effects-tone`), `scripts/runner_effects_fixtures.py` (group `tone`); create `frontend/shared/runner/gradientStops.ts` (`parseStops`, `parseDuotone`, `hexToRgb`, as `_gradient_map.py:24-81`, shared so the inspector can reuse it later). Test: `runner-effects-tone.unit.spec.ts`.

**Fixtures (`tone`):** the standard case set. In addition:
- `parse_stops` over malformed JSON, an empty list, one stop, unsorted stops, out-of-range positions and bad colours;
- `parse_duotone` over non-dict JSON;
- `_hex_to_rgb` over `"#abc"`, `" #a1b2c3 "`, `"zz0000"` and `""`;
- Adjust color with hue ±180 (±0.5, the torchvision bound);
- every channel-count raise.

**Test:** rule 12. Also: `parseStops` and `hexToRgb` deep-equal Python on every recorded input.

**Acceptance:** every exact class is bit-exact on every case; every library class is within its ε.

---

### Task R2.5: Blur and convolution effects (family `effects-blur`)

**Consumes:** R2.2's `gaussianBlur`, `conv2dDepthwise`, `conv2dSame`, `padReflect`, `resizeArea`, `resizeBilinear`, `affineGrid`, `gridSample`, `maxPool2d`, `topk`, `unary`.

**Port** (into `effects/core/blur.ts`, `blurCore(k, kern)`):

| Class | Python | Notes | Batch |
|---|---|---|---|
| Sharpen | `nodes_sharpen_noise.py:14-44` | ksize `2·ceil(3r)+1`; `x + a·(x − blur)` | pure |
| Denoise | `nodes_sharpen_noise.py:82-113` | | pure |
| AdjustGlow | `nodes_tone_extras.py:65-108` | luma threshold; `scale = max(1, int(r/4))`; area down (an output of 0 raises), gaussian, bilinear up (channels-last) | pure |
| HighPass | `nodes_stylize.py:115-141` | | pure |
| Emboss | `nodes_stylize.py:85-114` | `kernel·depth` in float32, reflect pad 1, depthwise conv, `+0.5` | pure |
| FindEdges | `nodes_stylize.py:46-84` | Sobel depthwise, `sqrt`, `mean(dim=1)` over every channel (alpha too); output 3 channels | pure |
| Blur | `nodes_blur.py:99-167` | `_gaussian` :45-56, `_motion` :59-78 with `_motion_kernel` :15-42 (built in Python doubles, stored float32, then normalised in float32), `_zoom` :81-96 (12 `affine_grid` + `grid_sample(border)` summed, then `/12`) | pure |
| Bokeh | `nodes_glsl_lens.py:169-219` | disk kernel, `pow(boost)` before and `pow(1/boost)` after | pure |
| TiltShift | `nodes_glsl_lab.py:19-67` | the mask is `linspace` over H; the blur is at the max radius | pure |
| FrequencySeparation | `nodes_glsl_lab.py:68-106` | **two image outputs** (low, high); the preview is low, high, or `cat([low, high], dim=2)` side by side, by `show` | pure |
| HeightmapRelief | `nodes_glsl_lab.py:168-224` | Sobel on luma (reflect), normals, a light vector in doubles | pure |
| Outline | `nodes_glsl_unicorn.py:158-224` | zero-padded Sobel; `mag / amax` (per picture); `max_pool2d` thickness; three fill modes | pure |
| Sparkle | `nodes_glsl_unicorn.py:442-529` | 9×9 max-pool peaks; `topk(max_n)` over `peaks·lu` (ties: band, per R2.2); the star kernel (ks up to 161) applied by **stamping at each kept peak** instead of a full conv2d (the same sum, far fewer products: at most `max_density·h·w` peaks) | pure |

That is 13 classes. Every one is *library* (convolution or transcendental), except Outline's `max_pool2d` and `amax` steps, which are exact inside it.

**Work** (rule 7): `work = pixels · channels · taps`, with taps as follows:
- gaussian: 2 · ksize (separable);
- motion: kernel area;
- zoom: 12 · 4;
- Bokeh: disk area after downsampling;
- Sparkle: `max_n · ks²`;
- Outline: 9 + the max-pool area.

**Files:** create `effects/core/blur.ts`; modify `effects/table.ts`, `scripts/runner_effect_rows.py`, `scripts/runner_effects_fixtures.py` (group `blur`). Test: `runner-effects-blur.unit.spec.ts`.

**Fixtures (`blur`):** the standard case set. In addition:
- radii at the downsample thresholds (Glow and Blur at r = 3.5, 4, 7.9 and 8; Bokeh at r = 4.9 and 5);
- the largest radius on a picture too small for its reflect padding (Python raises → `EFFECT_PICTURE_TOO_SMALL`);
- Blur motion at angles 0, 33, 90 and 271 with lengths 1, 2, 15, 16 and 80;
- zoom strengths 0.01 and 1;
- FrequencySeparation with each `show`;
- Sparkle with more peaks than `max_n`, including tied lumas.

**Test:** rule 12. Also:
- a time check: Sharpen at radius 10 on a 4096² 'rgb' picture on the worker, reported;
- the work refusal: HighPass at radius 30 on 8192² when that is over budget fails before decoding;
- FrequencySeparation's two outputs feed two different readers correctly.

**Acceptance:** every class is within its ε on every case, and the ε values are reported.

---

### Task R2.6: Cells and glyphs (family `effects-cells`)

**Consumes:** R2.2's `resizeArea`, `resizeNearest`, `avgPool2d`, `avgPool2dStrided`, `remainder`.

**Port** (into `effects/core/cells.ts`):
- `Pixelate`, `nodes_stylize.py:14-45`: area to `(max(1, h//n), max(1, w//n))`, then nearest back. Exact.
- `Halftone`, `nodes_glsl_lens.py:64-111`: rotated `arange` grid, `%` cell, `sqrt`; `avg_pool2d(k=cell, stride 1, pad cell//2)` of luma, then nearest to (h, w) (the pooled size is h + 1 when the cell is even); output expanded to the input's channels. Exact (Python-double `cos`/`sin` as scalars).
- `Kuwahara`, `nodes_glsl_stylize.py:99-149`: two `avg_pool2d`s; the variance summed over **every** channel; four `roll`s; `argmin` over 4 (first on ties); gather. Exact.
- `Ascii`, `nodes_glsl_stylize.py:232-367`: presets and custom text (:275-281), `pos_x`/`pos_y` rolls, the crop to whole cells, cell luma, gamma, phase and index (`round`, then Python's `%` on the long tensor, which is floor-mod), the glyph atlas, monochrome or texture, background, invert, padding, `_apply_blend` (:84-96) and mix.
  - The **glyph atlas** (`_ascii_bitmaps`, :51-81) is PIL text rendering with a system font, which the runner can't reproduce. The fixture script renders it once with Python's own function and ships it as `frontend/server/runner/effects/asciiGlyphs.bin`:
    - one entry per (cell 4–64, character);
    - the characters are the union of the eight presets and printable ASCII 32–126, each rendered alone, as `_ascii_bitmaps` renders each character independently;
    - each entry's float32 bitmap is stored as the uint8 `np.array(small)` it came from, so it is exact;
    - the file is gzip, with a small index.
  - A custom `characters` string with a character outside that set leaves the node to the engine (eligibility `inputCheck: 'ascii-glyphs'`).
  - The font is whatever `_load_mono_font` finds on the machine that makes the fixtures: Menlo on this Mac, DejaVu Sans Mono on Linux. See "Controller rulings needed" (d).

**Files:** create `effects/core/cells.ts` and `frontend/server/runner/effects/asciiGlyphs.bin` (generated by the fixtures script, `--group cells`); create `effects/asciiGlyphs.ts` (reads the file once, lazily, and hands the worker one (cell, characters) atlas per node); modify `effects/table.ts`, `shared/runner/effects.ts` (the `ascii-glyphs` check against a generated character list, `shared/runner/asciiGlyphSet.generated.ts`), and the two scripts. Test: `runner-effects-cells.unit.spec.ts`.

**Fixtures (`cells`):** the standard case set. In addition:
- Pixelate sizes 1, 2 and 64 (bigger than the picture);
- Halftone with an odd and an even cell and angles 0, 15 and 90;
- Kuwahara radius 1–12 on 37×23;
- Ascii over every preset, `custom` with a short string (falls back to `_ASCII_DEFAULT`) and a long one, both `color_mode`s, `background` on and off, `invert_order`, rolls ±32, `gamma` 0.1 and 3, `phase` 1, `mix` 0.5, every `blend_mode`, and a picture not a whole number of cells;
- the atlas's sha256 and entry count.

**Test:** rule 12 (all four are *exact*). Also: the atlas entries equal Python's for every (cell, character); a custom character outside the set is left to the engine.

**Acceptance:** bit-exact on every case; the atlas file is under 3 MB (report its size).

---

### Task R2.7: Geometry and coordinate warps (family `effects-warp`)

**Consumes:** R2.2's `linspace`, `gridSample`, `affineGrid`, `resizeBilinear`, `resizeBicubic`, `resizeNearest`, `resizeArea`, `unary`, `remainder`.

**Port** (into `effects/core/warp.ts`):

| Class | Python | Notes | Class |
|---|---|---|---|
| CropImage | `nodes_geometry.py:13-43` | `int(left·w)` in doubles; `outSize` | exact |
| ResizeImage | `:44-75` | `scale_factor` output size (`areaOutSize`); bilinear or bicubic (channels-last, `align_corners=False`), nearest or area; `outSize` checked at the node's turn | exact |
| RotateImage | `:76-111` | `affine_grid` + `grid_sample(zeros)` | library (affine_grid) |
| FlipImage | `:112-143` | | exact |
| Pinch | `nodes_distortion.py:28-63` | `r.pow(power)` | library |
| Twirl | `:64-100` | `cos`/`sin` of a tensor | library |
| Wave | `:101-138` | | library |
| LensCorrection | `:139-171` | border | exact |
| Kaleidoscope | `nodes_glsl_distortion.py:28-65` | `atan2`, `%` | library |
| PolarCoords | `:66-103` | | library |
| Fisheye | `:146-179` | `tan`, zeros padding | library |
| ChromaticAberration | `nodes_glsl_lens.py:29-63` | one `grid_sample` per channel over **3** channels, so output is 3 channels (alpha dropped) | exact |
| CRT | `:112-168` | barrel, chroma (3 channels), `sin(arange·3.14159)`, RGB stripes (a 4-channel picture raises in chroma or in the stripe broadcast; the fixture records which) | library |
| Mirror | `nodes_glsl_unicorn.py:225-315` | six modes, `round(seam·w)` in Python; the quadrant modes' `zeros_like` fill | exact |
| GodRays | `nodes_glsl_atmosphere.py:24-77` | `samples` × `grid_sample(zeros)` accumulated with a Python-double decay | exact |

That is 15 classes. `work`: Rotate, Pinch and the others count 4 taps a pixel; GodRays counts `samples · 4`; the zoom-like ones count likewise. Resize and Crop change the size (rule 7).

**Files:** create `effects/core/warp.ts`; modify `effects/table.ts` and the two scripts (group `warp`). Test: `runner-effects-warp.unit.spec.ts`.

**Fixtures (`warp`):** the standard case set. In addition:
- Resize at scales 0.1, 0.33, 0.5, 1, 1.5 and 4 in each mode, including a 1-pixel result;
- Rotate at ±180, ±90, 45 and 1;
- Crop at 0.49 on each side (the `max(x0+1, …)` guard);
- Mirror with every mode, seam 0, 0.5 and 1, and an odd width;
- GodRays with centres at the corners and samples 4 and 80;
- Kaleidoscope with 2 and 20 segments.

**Test:** rule 12. Also: Resize's kept PNG has the new size, a Frame reading it sizes its canvas from it, and a scale that would pass 8192² is refused (at eligibility when the input's size is known from a header at the start of the take, else at the node's turn).

**Acceptance:** exact classes bit-exact; library classes within ε.

---

### Task R2.8: Masks, blends and Painter (family `effects-mask`)

**Consumes:** R2.2's `resizeBilinear`, `maxPool2d`, `gaussianBlur`, `powScalar`; `pixels.pilResize` (R1.5; factor out a premultiplied `pilResizeRgba` from `savePixels` without changing its results).

**Port** (into `effects/core/mask.ts`):
- `Blend`, `nodes_composite.py:51-82`: `_match_size` (:11-17; top resized to base with bilinear, channels-last), the 11 modes of `_blend` (:20-48), and opacity. The base and top channel counts must broadcast (3 against 4 raises). The batch rule is rule 5; the batch is `coupled` over two inputs, paired by index. Exact.
- `ApplyMask`, `:83-118`: the mask is resized to the picture (bilinear, contiguous) when the sizes differ; `invert`; image × mask over every channel. Exact.
- `ThresholdMask`, `:119-155`: a **mask** out; the preview is image × mask. Exact.
- `ColorRangeMask`, `:156-188`: `(image − target).pow(2).sum(-1).sqrt()`, so 4 channels raises. A mask out; the preview is image × mask. Exact (`pow(2)` is `x·x`; the sum is over 3).
- `MatteGrowShrink`, `nodes_matte.py:23-80`: mask in, mask out; `max_pool2d` dilate or erode (−max(−x)); the gaussian feather; the preview is the mask as grey RGB. Library when feathered, exact otherwise.
- `MergeAlpha`, `nodes_matte.py:81-123`: picture plus mask to **RGBA** (always 4 channels); the mask resized when the sizes differ; the preview is `rgb × m` (3 channels). Exact.
- `Painter`, `comfy_extras/nodes_painter.py:26-117`:
  - `image` is optional (only its first picture: `image[:1]`); `mask` is an uploaded painter file (a widget, not a wire); `width`/`height` are 64–4096; `bg_color` goes through the painter's own `hex_to_rgb` (:16-23, no `#abc` shorthand).
  - The painter file is read with `Image.open(...).convert("RGBA")`, **no** EXIF turn, and resized with `Image.LANCZOS` when its size differs (the premultiplied RGBA path).
  - `composited = rgb·a + base·(1 − a)` in numpy float32; a 4-channel base with a painter file raises.
  - Outputs: IMAGE and a **mask** (the painter's alpha, not 1 − alpha).
  - Its ui is `UI.PreviewImage` (a random temp name, as Preview image; reuse R1.5's `planPreviewImage` naming), not a live preview.
  - Hosted ownership: `collectInputFiles` adds the painter file (`parseInputFileRef`), and the file goes through the start-of-take header refusal (rule 9).
  - Exact apart from the Lanczos resize, which is exact to Pillow (R1.5's port).

**Files:** create `effects/core/mask.ts` and `effects/painter.ts` (the painter file's decode and Lanczos on the main thread's worker call, then the composite in the core); modify `effects/table.ts`, `server/runner/inputs.ts` (`collectInputFiles`), `pixels/core.ts` (the `pilResizeRgba` factor-out) and the two scripts (group `mask`). Test: `runner-effects-mask.unit.spec.ts`.

**Fixtures (`mask`):** the standard case set. In addition:
- every Blend mode × opacity 0, 0.37 and 1, top of a different size, and batches 1:2, 2:2 and 2:3 (the last raises);
- a mask from each producer the runner has: LoadImage's MASK (R1.3), Image to mask, Threshold mask and Text mask's mask, at the same size and at a different size;
- MatteGrowShrink with amounts −50, −1, 0, 1, 50 and 0.4 (rounds to 0), feather 0, 0.5 and 30;
- Painter with no image and no file; a file the canvas size; a file of another size (Lanczos); a base picture of 3 and of 4 channels; and a painter file with EXIF orientation 6 (not turned).

**Test:** rule 12. Also:
- a mask output (Threshold mask → Apply mask) chains through the 16-bit kept mask exactly as Python's float mask does node by node (the fixture feeds Python the same 16-bit-quantised mask);
- Merge alpha → Save image saves RGBA;
- Painter's painter file owned by someone else is refused 403 before any hold.

**Acceptance:** bit-exact except the feathered Matte (within ε).

---

### Task R2.9: Generators, seeded looks and Add noise (family `effects-noise`)

**Consumes:** R2.3's `TorchGenerator`; R2.2's `resizeBicubic`, `resizeBilinear`, `resizeArea`, `resizeNearest`, `gridSample`, `topk`, `avgPool2dStrided`, `padReflect`, `conv2dDepthwise` (the 3×3 laplacian), `linspace`, `unary`, `meanAll`.

**Port** (into `effects/core/noise.ts`):

| Class | Python | Random numbers | Batch | Class |
|---|---|---|---|---|
| FilmGrain | `nodes_glsl_atmosphere.py:124-165` | `randn(1,1,gh,gw)`, one field for the whole batch | coupled | library (randn, bilinear of it exact) |
| Glitch | `nodes_glsl_distortion.py:104-145` | one `rand(1).item()` per slice (Python double arithmetic on the float), the same shifts for every picture of the batch | coupled | exact |
| PerlinNoise | `nodes_glsl_generative.py:17-67` | `rand(1,1,gh,gw)` per octave (seed `(seed + o·17) & 0x7fffffff`), bicubic up | generator | exact |
| Voronoi | `:68-118` | `rand(points,2)`, then `rand(points,3)`; `topk(k=2)` over N | generator | exact (topk ties: band) |
| GradientGenerator | `:119-166` | none | generator | exact |
| PaletteQuantize | `nodes_glsl_lab.py:107-167` | `randperm` on the 96² area sample of **every** picture of the batch together; k-means with `argmin` (first on ties) and per-cluster `mean` | coupled (two passes: sample every file, then snap every file) | library (the means) |
| ReactionDiffusion | `nodes_glsl_fractal.py:17-74` | `rand` nucleation patch; the laplacian by conv2d with reflect padding; `iterations` steps | generator | library |
| Fractal | `nodes_glsl_fractal.py:75-153` | none; escape loop with an early break | generator | library (sin) |
| Stipple | `nodes_glsl_unicorn.py:373-441` | `rand((b, sh, sw))`, b-major over the batch | coupled | exact |
| FlowField | `nodes_glsl_unicorn.py:593-652` | `_value_noise` (:51-57): `rand` low grid, bilinear up, seeds `seed` and `seed+17`; `grid_sample(reflection, align_corners=True)` | pure (the same field for every picture) | library (cos/sin) |
| AddNoise | `nodes_sharpen_noise.py:45-81` | **unseeded** `randn`/`rand` from the global generator, shape `[B,H,W,C]` or `[B,H,W,1]` | coupled | visually equal (spec) |

**Add noise.** Python draws from the process-wide torch generator, so no two Python runs match. The runner draws from the R2.3 port, seeded by `addNoiseSeed(node)` = the first 8 bytes of the sha256 of the node's widget values and its input files' sha256, in order. That makes the noise stable while nothing changes, as ComfyUI's cache keeps it, and new when the picture or a setting changes. See "Controller rulings needed" (e).

The fixture seeds the global generator (`torch.manual_seed(s)` just before `execute`), so for those seeds the runner must reproduce Python's output **exactly** (as the library class, through `randn`). The spec's "visually equal" measurement is also recorded on a fixed 256×256 smooth mid-grey gradient (`synth`'s gradient part with noise 0), both types, mono and colour: per-channel means within 2/255 and the noise's standard deviation within 5% of Python's under a different seed. The controller's side-by-side look is R2.12.

**Work:**
- ReactionDiffusion: `w·h·iterations·6`, budgeted. At the widget maximum (1024² × 3000) it is probably over budget; the report states what it takes and the plan's cap sends bigger ones to the engine through an `inputCheck` known from the widgets.
- Fractal: `w·h·max_iter`.
- PaletteQuantize: `(96²·k·iterations) + pixels·k`.
- The generators' output size: width × height from widgets ≤ 2048², inside the caps.

**Files:** create `effects/core/noise.ts`; modify `effects/table.ts` and the two scripts (group `noise`). Test: `runner-effects-noise.unit.spec.ts`.

**Fixtures (`noise`):**
- the standard case set for the picture effects;
- for the generators: every widget at min, default and max (sizes 64, 512 and 2048, the last one hashed), seeds 0, 1 and 2³¹ − 1;
- Glitch with slices 2 and 60 on a picture shorter than `slices`;
- PaletteQuantize with a batch of two, colours 2 and 32, iterations 1 and 20, on a picture of fewer than 96 pixels a side;
- Stipple with a batch of two and `invert`;
- ReactionDiffusion 64² at 50 and 600 iterations;
- Fractal in both types, zoom 1 and 10 000, max_iter 16 and 512;
- AddNoise under `torch.manual_seed(7)` and `(8)` for each type and mono/colour, plus the fixed-picture statistics.

**Test:** rule 12. Also:
- the batch-coupled draws: a batch of two files gives Python's two results, while running each file alone gives different results;
- AddNoise's seed: the same inputs give the same noise, and a changed widget or file gives different noise;
- AddNoise's statistics are within the spec's bounds.

**Acceptance:** exact classes bit-exact; library classes within ε; AddNoise exact under the seeded fixtures and within the visual bounds.

---

### Task R2.10: Shader effect from the browser's bake (family `shader-bake`, decision 9)

The server renders no GL. The browser renders the node's shader at submit, as it already does for the node's live preview (`app/lib/shaderfx/renderer.ts` `ShaderFxRenderer`, the manifest from `/sailor/shader_effects`, served natively by `server/native/shaderCatalog.ts`). It uploads the PNG and names it in the API prompt. The runner replays that file.

**Port** (the behaviour contract), `comfy_extras/nodes_shader_effects.py:92-179`:
- `effect` goes through `LEGACY_EFFECT_IDS` (`filament` → `thread_contours`); an unknown effect raises.
- The uniforms are `to_uniforms(eff, resolve_params(eff, params))`, plus the textures' `extraUniforms`, plus `u_time`, `u_seed = seed % 10000` and `u_hasInput`.
- The size is the image's own size, or for a generative effect with no image `_aspect_size(resolution, aspect)` (:52-58). A non-generative effect with no image raises.
- The frames follow `frame_plan` (`_shader_effects.py:241-253`): a batch gives one frame per input with `u_time = time + i/fps`; a still with `duration > 0` gives `round(duration·fps)` frames (at most 300); otherwise one frame at `time`.
- The output keeps `o[..., :3]` (RGB), clamped. The ui is a **unique** live preview (`save_live_preview(unique=True)`), so it is a new temp name every run, not the fixed name.

**What the runner takes** (eligibility `inputCheck: 'shader-bake'`):
- `duration` is 0, or the image is a batch (one frame per input). An animated still (`duration > 0` with no batch) is left to the engine; see "Controller rulings needed" (f).
- The `image` is unwired, or comes (through Image cards and Gates) from an Image card holding a file or a LoadImage. That is a picture the browser has before the run.
- A Shader effect whose `image` comes from any other node in the same run is **not** taken, per the ruling: "Shader effect fed by a picture made in the same run → refused for now". Its needs-engine reason is "This shader needs its picture before the run; run the picture first" (add a per-node reason to `nodesNeedingEngine`'s output when the shared rule gives one).
- The prompt carries `inputs.sailor_baked` = JSON `{ files: [<uploaded name> …], key }`. `key` is the sha256 of the canonical JSON of `{ effect, params, time, duration, fps, seed, resolution, aspect, source: [files], catalogVersion }`. The runner recomputes it from the prompt as sent and takes the node only when they agree, so a stale or hand-made bake is not replayed. ComfyUI ignores an input its schema doesn't declare, so the engine path is unchanged.

**Files:**
- Create `frontend/app/lib/runner/shaderBake.ts`. It holds `shaderBakeKey(inputs, sources, catalogVersion): Promise<string>` (shared with the server through `frontend/shared/runner/shaderBakeKey.ts`, which holds the canonical JSON and sha256 over Web Crypto / node crypto) and `bakeShaderEffects(prompt: ApiPrompt, ctx: { catalog, renderer: ShaderFxRenderer, upload(bytes, name): Promise<string>, sourceFile(nodeId): … }): Promise<void>`. For each eligible node it renders every frame of `frame_plan` at the Python size with the Python uniforms, reads the RGBA back, drops alpha, encodes a PNG, uploads it to input (content-hash names, so repeats dedupe), and writes `sailor_baked`.
- Modify `frontend/app/layouts/default.vue`: one small, separate hunk that calls `bakeShaderEffects` on the API prompt right after it is built for a runner submit (where `directPrompt` is made in `assembleTake`), only while `shader-bake` is on in the public families. A failed bake leaves the node without `sailor_baked` (it then goes to the engine, or is named as needing it) and shows a toast.
- Create `frontend/server/runner/cards/shaderEffect.ts` with `planShaderEffect(ctx): NodePlan` (derive): each baked file is read, refused if it isn't an RGB or RGBA 8-bit PNG of the expected size, kept as an 8-bit RGB PNG (alpha dropped as Python does), and written as a unique live preview (`DeriveIO.savePreview`). The value is `{ kind: 'files', files }` and `pictureSourceOf` is `'tensor'`.
- Modify `frontend/shared/runner/eligibility.ts` (the `ShaderEffect` row: `family: 'shader-bake'`, `local: 'render'`, `imageInputs: ['image']`, the widgets as the schema, `inputCheck: 'shader-bake'`), `validate.ts` (`RUNNER_OUTPUT_CLASSES`), `server/runner/inputs.ts` (`collectInputFiles`: every `sailor_baked` file, for hosted ownership) and `executors.ts`.
- Modify `scripts/runner_effects_fixtures.py` (group `shader`: for each catalog effect, `to_uniforms(eff, resolve_params(eff, params))` over the default params, one non-default set and one malformed `params` string; `_aspect_size` for every aspect at 256, 768 and 2048; `frame_plan` cases). **No GL render is recorded**: parity with Python's render is "visually equal" at most, because the browser and moderngl are different GL implementations. The decision makes the browser's bytes the result.
- Test: `frontend/tests/unit/runner-shader-bake.unit.spec.ts` (server and pure parts), and `frontend/tests/unit/shader-bake-browser.unit.spec.ts` (the browser helper with a fake renderer and fake upload).

**Test:**
- the browser's uniform builder (the one `ShaderEffectNode.vue` uses) gives Python's `to_uniforms` for every fixture effect;
- `aspectSize` and `framePlan` equal Python's;
- `shaderBakeKey` is identical in the browser and on the server;
- the runner replays the uploaded bytes (the kept PNG's pixels are the uploaded RGB);
- a key mismatch, or no `sailor_baked`, leaves the node to the engine;
- an image from Generate an image in the same run is not taken, and names the reason;
- a baked file owned by someone else is refused 403 before the hold;
- a baked file of the wrong size fails plainly;
- the ui name is unique per run.

**Acceptance:** the replayed PNG is the browser's pixels; a saved project with a Shader effect on an Image card runs engine-free (R2.12 checks this in the browser); the refusal is plain.

---

### Task R2.11: Live previews through the runner (family `live-previews`)

Today a widget change on a live-preview node (`app/lib/livePreviewNodes.ts:21-74`) sends `sailor:liveRun`. `layouts/default.vue:2138-2152` then runs a scoped workflow: it goes to ComfyUI, or, when the runner takes the workflow, to `/api/runs` as a full take (a hold, a record, events, and a render credit when it ends). This task adds a preview route that runs the node's chain of local effects on the files the canvas already has, with no hold, no record and no charge.

**Files:**
- Create `frontend/server/api/runs/preview.post.ts`: `POST { canvasId, nodeId, prompt: ApiPrompt, pinned: Record<string, OutputFile[]> }` → `200 { ui: Record<string, unknown> }` | 400 | 403 | 409 | 413.
- Create `frontend/server/runner/preview.ts` with `runPreview(req, deps): Promise<{ ui }>`:
  - The runner must be on, `live-previews` on, and every node of `prompt` that is not pinned must be a class the runner computes itself (an effect, or a `cards` class computed with no provider: Image card pass-through, Gate open, Empty image and similar) whose family is on and whose rule allows it (`runnerTakesNode` per node, `valueWiresAllowed`). A provider class is refused 409 ("This preview needs a full run").
  - Pinned nodes (the non-local upstream: a paid node, an Image card with its file, a LoadImage) are not run. `filesFrom` returns their pinned files, and `pictureSourceOf` still sees their real class.
  - Hosted: each pinned file must lie in the user's own folders (the ownership check `/api/runs` uses, including temp), or the request gets 403.
  - Everything else follows the effects' own rules and caps.
  - It runs the derive plans in topological order on the worker queue. Kept bytes live in a per-request in-memory map and are let go when it answers. Only the target node writes its preview (`savePreviewAs`: the same `live_preview_<id>.png` the full run writes). The response gives the target's ui.
  - One preview in flight per (user, node): a newer request aborts the older one (409 for the older), and at most 2 in flight per user.
- Create `frontend/app/lib/runner/livePreview.ts` with `livePreviewRequest(prompt: ApiPrompt, nodeId: string, families: ReadonlySet<RunnerFamily>, lastFiles: (nodeId: string) => OutputFile[] | null): PreviewRequest | null`. It is a pure function: it walks upstream from `nodeId` through local classes, pins the first non-local node on each path by its last shown files, and returns null (the old path) when a pin has no files yet, or when any node isn't one the route takes.
- Modify `frontend/app/layouts/default.vue` `handleLiveRun`: a small, separate hunk. When the runner and `live-previews` are on and `livePreviewRequest` gives a request, POST it and apply the answer as the node's `executed` event through the existing runner-event path (`handleBridgeEvent` with the runner's `executed` envelope), so `ComfyNode.vue`'s display updates as it does today. Otherwise run as today. It builds the prompt the way `runVueWorkflow` builds it for a live run (`getFilteredWorkflow([id])`, then the prompt builder), and reads each pinned node's last files from `getNodes()`. **`VueNodeCanvas.vue` is not touched.** If it has to be, stop and report.
- Test: `frontend/tests/unit/runner-live-preview.unit.spec.ts` (the route with the kit's stores, fake ownership, hosted and local) and `frontend/tests/unit/live-preview-request.unit.spec.ts` (the pure browser helper).

**Test:**
- a slider change on Image card → Blur → Adjust curves builds a request with the Image card pinned and both effects in `prompt`; the route answers the Adjust curves ui; its preview file has the same pixels a full run writes; no hold, no record, no ledger entry, no event on `/api/runs/events`;
- Generate an image → Blur: the provider is pinned by its last output file; before it has one, `livePreviewRequest` returns null (the old path);
- a chain with an effect whose family is off returns null;
- hosted: a pinned file of another user gives 403; a temp preview file of the user's own gives 200;
- two requests for one node: the first is aborted, the second answers;
- a request with a provider node in `prompt` gives 409;
- with `live-previews` off, the old path runs unchanged (the helper is never called).

**Acceptance:** a slider drag on a ported effect never touches `/prompt` or `/api/runs`; hosted refuses a preview whose input isn't the user's; previews are free.

---

### Task R2.12: Controller check, fixture-level and in the browser (not delegated)

- [ ] Real routes and engine, with the fake ledger, hosted mode, `NUXT_RUNNER_FAMILIES=frame,cards,effects-tone,effects-blur,effects-cells,effects-warp,effects-mask,effects-noise,shader-bake,live-previews`, and no provider keys. Run these workflows:
  - Image card → Adjust color → Blur → Save image;
  - LoadImage → Threshold mask → Apply mask → Frame;
  - Generate an image (fake fal) → Film grain → Edit image;
  - Painter → Merge alpha → Save image;
  - Perlin noise → Gradient map → Preview image;
  - Image card → Shader effect (a fixture bake).

  For each: every effect's kept picture equals its fixture's `round8`, every preview equals its fixture's `trunc8`, and each charge equals `priceGraph` for the paid nodes that ran, plus the render credit only as ruled (a).
- [ ] With every effects family off, the needs-engine list over every saved project is identical to before R2.1, and every `runner-*.unit.spec.ts` is green unchanged.
- [ ] A restart halfway through a chain of effects after a paid node: the paid node is charged once, and the effects rerun from the kept file.
- [ ] Add noise, side by side (the controller looks once): Python's result against the runner's on the fixed test picture, both types. Record the verdict.
- [ ] The browser check on the shared :3002 server (the controller's, never a subagent's), with the families on in the local `.env`:
  - drag a slider on Adjust curves after an Image card: the network panel shows `/api/runs/preview` and no `/prompt`; the preview updates;
  - run a saved project that has a Shader effect on an Image card, with ComfyUI stopped;
  - the Frame reads an effect's output correctly.
- [ ] The full unit suite is green with the keys unset (or every area R2 touched, as R1.7 did when the full run hung); the typecheck is clean; `runner-builders.json` is unchanged.

Record the results in `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md` and `docs/STATE.md`. The effects families stay off in hosted until the user says otherwise.

### Controller rulings needed before R2 is built

- **(a) Render credit.** Effects are `local: 'render'`. Without that, a workflow of an Image card and effects isn't taken by the runner at all, because it has no "work". A finished effect then earns its stage the render credit, as Save image does (R1.5). The ComfyUI path charges the render credit on any graph with an output class (an Image card is one), so this matches it. But it means every full run of an effects-only workflow costs a render credit in hosted. Previews (R2.11) cost nothing. Confirm, or rule that effects earn no render credit.
- **(b) "Pixel-exact" for library code.** Rule 10's band: 8-bit equal except where Python's float is within ε ≤ 2⁻⁸ (in 255-scale) of a quantisation boundary, there off by exactly one level. It applies to conv2d, gaussian blur, long sums, transcendental functions, `affine_grid` and `topk` ties. Everything else is bit-exact. Python itself differs by this much between this Mac and hosted x86 Linux.
- **(c) Transparency.** Keep Python's failure of torchvision-based and 3-colour effects on 4-channel pictures (a provider's picture is always 4 channels in Python, so Generate an image → Adjust color fails there today), or drop alpha first (not parity, but friendlier)? The plan keeps the failure, with a plain message.
- **(d) Ascii's font.** The glyph atlas is shipped as rendered by the fixture machine: Menlo on this Mac. A hosted ComfyUI would have rendered DejaVu Sans Mono. Menlo is Apple's font; shipping its rendered bitmaps (about 110 characters × cells 4–64) needs your OK, or the atlas is made on Linux with DejaVu (free licence).
- **(e) Add noise's seed.** A hash of the node's inputs, so it is stable until something changes, like ComfyUI's cache. The alternative is fresh noise every run.
- **(f) Animated Shader effect** (a still with `duration > 0`, up to 300 frames). Leave it to the engine for now, as the plan does (it is then broken in hosted), or bake every frame (up to 300 uploads per run)?

---

# R3 — Paid-model nodes

R3 moves Sailor's remaining paid nodes into the runner: the 35 visible Replicate classes of `comfy_api_nodes/nodes_replicate.py` the runner doesn't take yet (inventory §1(a)), plus Pose Mannequin, Lens reframe and Turntable from `comfy_extras/`, and the hidden "Remote" twins whose Python is the very same call (ruling (q)). Each becomes a provider plan built from the real Python and proven by its request fixtures, priced in `frontend/shared/pricing/`, and switched on one family at a time after its live paid check. The outline's eight tasks are replaced by the eighteen below (expanded 2026-09-27); `.superpowers/sdd/2026-09-26-engine-free-step3/r3-expansion-report.md` lists the corrections to the outline and why.

**Order.** R3.1 (the engine's new plan shapes) comes first, then R3.2 (price, moderation and fixture harness), which uses R3.1's plan types. After both, R3.3–R3.9 and R3.11–R3.16 are independent of each other, one family each; they all edit `executors.ts`, `eligibility.ts` and the price module, so the controller runs at most two at once and merges. R3.10 (sound in) and R3.17 (Turntable with views) wait for R5.1 (ffmpeg). R3.18 is the controller's check.

**Families** (each off by default; each needs `cards` on, `FAMILY_REQUIRES`, as R2's do: their inputs come from Image cards and LoadImage, and their values go to Text cards and wired prompts, all `cards` machinery):

| Family | Task | Classes |
|---|---|---|
| `llm-text` | R3.3 | Chat with an LLM, Improve a prompt, Summarize, Translate, Rewrite in a tone, Brainstorm ideas, Think step by step |
| `describe` | R3.4 | Describe an image (+ twin), Describe a video, Extract text, Find objects |
| `image-repair` | R3.5 | Upscale, Enhance detail, Fix faces (+ twin), Restore an old photo (+ twin), Remove background (+ twin) |
| `layers` | R3.6, R3.7 | Separate text from image, Layerize an image, Expand / outpaint, Separate background and foreground |
| `audio-gen` | R3.8 | Generate music (+ twin), Generate speech (+ twin) |
| `gen-3d` | R3.9 | Generate a 3D model (+ twin), Multi-View → 3D |
| `sound-in` | R3.10 | Transcribe audio (+ twin), Identify speakers, Clone a singing voice, Sync lips to audio (+ twin) |
| `film-shot` | R3.11 | Film a shot's preset path |
| `image-extras` | R3.12 | Text effect, Sketch to image, Generate face references |
| `lora` | R3.13, R3.14 | Flux Dev + LoRA, Flux Dev + LoRAs, Restyle an Image · Style LoRA |
| `nano-extras` | R3.15 | Pose Mannequin, Lens · 3D Reframe |
| `turntable` | R3.16, R3.17 | Turntable |

## Rules every paid node follows (binding for R3.3–R3.17)

1. **From node to provider plan.** Each class gets a builder in `frontend/server/runner/generators/<group>.ts` that turns the node's inputs (after `withWiredValues`, so a wired text arrives as typed) into exactly the payload the Python `execute` sends, and a case in `planNode` (`executors.ts`) that returns one of:
   - a `provider` plan (one call), `media` as the node's output: `'image'`, `'video'`, `'audio'`, `'glb'` or `'value'` (R3.1);
   - a `pipeline` plan (several calls, R3.1) for Separate background and foreground, Flux Dev + LoRAs' reload retry, Restyle with a style LoRA and Turntable with views;
   - a `pass` plan where Python makes no call (rule 8).

   Python's own conversions are ported, not re-invented: `str.strip()` is `pyStrip`, `int()`/`float()` are `pyText.ts`, a Python `bool(x)` is `pyTruthy`. Where Python reads `_first_output_url` the plan takes the first URL only (`take: 'first'`).
2. **Values out.** A `STRING` output is a value: kind `'text'`, or `'json'` for the four JSON outputs (Find objects, Identify speakers, and the two `layers_json`). Its text is byte-identical to Python's: token lists joined with `pyStr` of each item, then `pyStrip` where Python strips; JSON through `pyJsonDumps` of the answer as Python's `json.loads` read it (R3.1: numbers keep their int/float form, keys their order). A GLB output is `{ kind: 'glb', url, file }` with Sailor's own saved copy (spec ruling 1, R3.9). The class's `OUTPUT_KINDS` row applies only while its family is on (`outputKindsFor`, as R2 generalised it).
3. **Files out.** A picture is saved as the runner has saved provider pictures since Phase B (the bytes as downloaded, `extFor`), except where Python changes the pixels before its output (drops alpha with `tensor[..., :3]`, picks one of several answers): then the kept file is the PNG Python's tensor would save, 8-bit by R1.5's truncation rule (`trunc(f32(255·x))` of the decoded `/255` value). Where Python calls `save_generation_output(tensor, prefix)` the node's ui is `{ images: [<the saved file>], animated: [false] }` under the same prefix; where Python returns no ui, `uiFor` returns null. A sound is saved with the extension of the answer (`extFor` with fallback `wav`), a video with `mp4`. Every download is capped at `MAX_MEDIA_BYTES` (`server/utils/graphInputSeconds.ts:47`, 512 MiB) unless the task names a lower cap; over it, the node fails plainly after the call (the call is charged: it was made).
4. **Request fixtures come from the real Python.** `scripts/runner_paid_fixtures.py --group <g>` (R3.2) imports each class, blocks the network before any node module loads, and runs `execute` with every provider call patched (`capture_calls`, R3.2, which extends `runner_builder_fixtures.py`'s `capture_first_call`): pictures arrive as `IMG:<input name>`, sounds as `WAV:<input name>`, uploads as `UPLOAD:<file name>`. It records every call in order as `{ provider, endpoint, payload }`. The TypeScript builder, given the same inputs, must produce payloads deep-equal to Python's, call by call. `frontend/tests/unit/fixtures/runner-builders.json` is not touched: if `runner_builder_fixtures.py` must change to share a helper, regenerate it and `git diff` must show nothing.
5. **Answer fixtures give the node's output.** For each class the script also feeds recorded or hand-written provider answers (a token list, a plain string, `null`, a dict, a JSON body text with `1.0`, `1e5` and non-ASCII) into the patched call and records what the node returns: the text or JSON string exactly, which answer URL it chose, and its ui. The TypeScript `valuesOf` / `take` / `urlsOf` must give byte-identical text and the same URL choice.
6. **Schemas saved.** Before a task is dispatched the controller saves each endpoint's published schema with `frontend/scripts/snapshot_provider_schemas.mjs` (free GETs only, never a prediction) into `frontend/tests/unit/fixtures/provider-schemas/`. Every payload the builder makes over the fixture set passes `checkPayload` (`tests/unit/helpers/providerSchema.ts`), as `runner-provider-schemas.unit.spec.ts` does for the line-up. Where the Python sends something the schema doesn't declare, the task reports it; the controller rules (the line-up's S1b precedent: follow the schema).
7. **One price calculation, hold and charge.**
   - Each class is priced by `priceNode` (`frontend/shared/pricing/nodePrice.ts:223`) through R3.2's `paidCalls` (the calls its settings can make) and rate cards (`paidRates.ts`, or an existing `EDIT_RATES` / `VIDEO_RATES` / `CLIP_RATES` card for an endpoint already carded). The class's flat row in `GRAPH_NODE_CREDITS` (`server/utils/priceBook.ts:266-354`) is removed in the same task, so the ComfyUI path's charge moves to the same calculation, and `PRICE_BOOK_VERSION` (`priceBook.ts:151`) is bumped once per task.
   - A rate card carries `service`, `source`, `read` (ISO date) and `confidence`, as `editRates.ts` does. Every figure is read from the provider's page or saved schema by the task, never from a badge. A card whose confidence is `estimate` (GPU-time billing) blocks switch-on until the live check measures it.
   - **The hold is the ceiling, taken at the start:** the dearest call the node's settings can make, every linked input at its most expensive (the price module's rule), and for a pipeline every call it may make (`editStepsUsd`'s shape: the first service marked up, fallbacks and backups covered at cost). Media-priced nodes (by picture size, sound or video length) are measured before the hold, as F22/F23 do (`nodeMedia.ts`).
   - **The charge comes from the same calculation**, fed with what was actually sent or made (the measured media, the token counts the answer reports, the calls that finished), and is **never above the hold**: the engine charges `min(hold, charge)` and reports a charge that would exceed it (`runner.charge.above-hold`).
   - An unpriced class or model (`priceNode` refuses, or prices at 0) is refused in hosted before the hold (`unpricedProviderNode`, `metering.ts:96`); local runs it free, as today.
8. **No-call branches.** Where Python returns before calling anyone (a blank text to summarise, a Pose Mannequin with a baked result, no pose source), the plan is a `pass` (or a value with no call) and R3.2's `paidNoCall(classType, inputs)` says so from the inputs as sent, so `stageEstimate` holds nothing for it (as `actionPassThrough` does, `metering.ts:159-176`) and nothing is charged. A wired input that decides the branch is priced as if the call were made; the hold for it is let go at the node's turn.
9. **Refusals before the hold, in plain words.** Anything the runner can tell from the prompt as sent or from a measured header is refused at the start of the take, before any hold: a setting the provider's schema refuses, a picture over its cap, a sound over its length, an unpriced model, a file the user doesn't own, text over the moderation limit. Messages are sentence case, plain, with no class names, field names or ids ("Improve a prompt needs an idea to work on.", not "ImprovePromptNode: idea is empty"). Where Python raises at run time with its own words (Describe a video's `"video_url is required."`), the runner refuses before the hold with plain words and the task lists the mapping. A known Python quirk that costs money (a call Python makes and then fails) is refused before the call, under the line-up's precedent (F8/F13 ruling rows).
10. **Every text sent is moderated** (hosted, fail-closed, G3). Each class lists the inputs whose text reaches a provider in R3.2's `PAID_TEXT_INPUTS`; `extraPromptTexts` reads them at the start (typed text), and R0.5's node-turn check covers wired text. Text Sailor writes itself (system prompts, templates, shot phrases) is not moderated; the user's part inside it is.
11. **Hosted ownership of every file handed off.** Every file a node sends (a picture, a sound, a baked file named in a widget, a LoRA, a voice) must be the user's own in hosted: `collectInputFiles` (`server/runner/inputs.ts:75`) lists widget-named files, and the start-of-take picture check (`cardPictureFiles`, `cards/bakeReplay.ts:83`) covers pictures read from Image cards and LoadImage. Files a node saves go under the user's subfolder (`userSubfolder`) and are recorded with `metering.addOutput`, including files saved to the input folder (Seedream layers, R3.6).
12. **Partial charges for multi-call nodes.** A pipeline records each call (`NodeRecord.calls`, R3.1). If the node fails or is stopped midway, it is charged for the calls that finished, priced by the same calculation, never above its hold (ruling (f)). A call that failed at the provider is not charged. Resume after a restart replays finished calls from the record and never sends one twice.
13. **Backups** only where the other service runs the same model and its schema carries every setting the first request carries, and only if its at-cost price doesn't raise the node's price (spec money rule 2). Each task's port table says "no backup" with the reason, or names the backup; each backup gets a `RUNNER_ROUTES` row (`generators/twins.ts:204`) and a live check of its own with `NUXT_RUNNER_BACKUP` on. Backups stay opt-in (`NUXT_RUNNER_BACKUP`, line-up F11).
14. **Families off by default.** A family is switched on only after (a) every endpoint in it has a rate card, (b) its live paid check passed with the user's go (one cheap call per family and per backup; one per endpoint whose card is an estimate), with `NUXT_RUNNER_BACKUP=off` for the first-service calls, and (c) the controller records the measured prices with source and date.
15. **Families-off parity.** With every R3 family off: `runnerTakesNode`, `nodesNeedingEngine`, `outputKindsFor`, `PICTURE_OUTPUTS` and `valueWiresAllowed` answer exactly as before R3.1 over every saved project graph (`user/sailor/projects/*`, the 866-graph check of R2.1), and every existing `runner-*.unit.spec.ts` stays green unchanged. The only intended change with families off is the ComfyUI path's price for classes whose flat row a task replaces (rule 7), pinned per class in `price-graph.unit.spec.ts`.
16. **Tests** go in `frontend/tests/unit/runner-paid-<group>.unit.spec.ts`, with the shared helpers in `tests/unit/__runner__/paidParity.ts` (R3.2). For every fixture case: the builder's payloads deep-equal Python's in order; each payload passes its saved schema; the answer fixtures give Python's output byte for byte; through `planNode` and the kit (`cards` and the family on), the engine sends those payloads to the fake provider, keeps the values or files, and charges `priceNode`'s figure. Plus per task: the hold equals the ceiling and the charge the same calculation on the answer; a refusal happens before `ledger.hold`; moderation sees every listed text; with the family off the class is left to the engine and `nodesNeedingEngine` names it; the families-off invariant (rule 15).
17. **Every task's run line:** `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group <g>` (twice; the second time `git diff --stat` shows the group file unchanged), then `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-paid-<g>.unit.spec.ts tests/unit/runner- tests/unit/price-graph.unit.spec.ts tests/unit/edit-pricing.unit.spec.ts`, and the typecheck from the Global Constraints. Report (no commit).

### Task R3.1: Paid plans that make sounds, 3D files, values and several calls

No family: engine machinery, proven with stand-in plans (the `vi.mock` pattern of `runner-value-results.unit.spec.ts`).

**Files:**
- Modify `frontend/server/runner/executors.ts`: the provider plan (`NodePlan`, :162-185) and a new `pipeline` kind.
- Modify `frontend/server/runner/types.ts`: `NodeRecord.calls` (:103-155).
- Modify `frontend/server/runner/engine.ts`: `waitForResult`'s media (:1130, :1259-1274), the download and save branch (:1162-1188), the value branch (:1145-1160), the stage charge (:786-790), and pipeline execution and resume.
- Modify `frontend/server/runner/replicateQueue.ts` (`replicateOutputUrls` :67-71; the JSON reads :129, :192, :223) and `falQueue.ts` (`falOutputUrls`; the JSON reads :89, :115, :135): outputs for `'audio'` and `'glb'`, and the raw body kept for value answers.
- Modify `frontend/server/runner/results.ts` (`extFor` :124: fallbacks `wav`, `glb`).
- Create `frontend/server/runner/rawJson.ts` and `frontend/shared/runner/pyJson.ts`.
- Modify `frontend/tests/unit/__runner__/kit.ts` (`createFakeFal` :27, `createFakeReplicate` :81): programmable answers.
- Test: `frontend/tests/unit/runner-paid-machinery.unit.spec.ts`, `frontend/tests/unit/py-json.unit.spec.ts`.

**Interfaces:**
- Consumes: R0.1 `RunnerValue`, R0.6 value plans and `ResultEntry`, `checkValue` / `filesOfValues` (`values.ts:44-67`), `DeriveIO` / `Derived`, `Handoff.toUrlBytes`, `ResultStore.save`, `metering.addOutput`.
- Produces (executors.ts):
  ```ts
  | {
    kind: 'provider'; provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
    media: 'image' | 'video' | 'audio' | 'glb' | 'value'; prefix: string
    uiFor(files: OutputFile[]): Record<string, unknown> | null
    /** Python reads `_first_output_url`: only the first URL is downloaded. Default 'all' (as before R3). */
    take?: 'first' | 'all'
    /** The answer's file URLs where they aren't Replicate's `output` list or fal's `images`/`video` (Trellis's `model_file`, Layerize's pick by extension). */
    urlsOf?(result: unknown): string[]
    /** Python drops alpha before its output: the file kept is the RGB PNG of the decoded pixels (rule 3). */
    rgb?: true
    /** For media 'value': the node's values; `raw` is the answer's body text (rawJson.ts) or null. */
    valuesOf?(result: unknown, raw: string | null): Record<number, RunnerValue>
    /** Token-priced nodes: credits for what the answer reports it used, or null (charge the hold). Never above the hold. */
    chargeOf?(result: unknown): number | null
    backup?: ProviderBackup
    keep?: KeepStep
  }
  | { kind: 'pipeline'; prefix: string; run(io: PipelineIO): Promise<Derived> }
  ```
  ```ts
  export interface PipelineCall {
    /** Stable within the node (e.g. 'cutout', 'fill', 'nb-1'): a resumed run matches calls by it. */
    key: string
    provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
    media: 'image' | 'video' | 'value'
    backup?: ProviderBackup
    /** This call's price basis in dollars (the price module's figure for it). */
    usd: number
  }
  export interface PipelineIO extends DeriveIO {
    call(c: PipelineCall): Promise<{ result: unknown; raw: string | null; urls: string[] }>
    download(url: string, o?: { maxBytes?: number }): Promise<{ bytes: Uint8Array; contentType: string | null }>
    /** Hands off bytes the node made itself (a mask, an RGB copy): kept by sha256, then uploaded. */
    handOff(bytes: Uint8Array, name: string): Promise<string>
    toUrl(file: OutputFile): Promise<string>
  }
  ```
  types.ts:
  ```ts
  export interface CallRecord {
    key: string; provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
    request: PendingRequest | null
    status: 'sent' | 'done' | 'error'
    usd: number
    /** The answer, kept so a resumed run replays it instead of calling again. */
    answer?: { result: unknown; raw: string | null; urls: string[] }
  }
  // NodeRecord gains:
  calls?: CallRecord[]
  ```
  rawJson.ts: `rememberRaw(parsed: object, text: string): void`; `rawTextOf(result: unknown): string | null` (a `WeakMap` keyed by the parsed object; the queue clients read the body as text, `JSON.parse` it and remember the text).
  shared/runner/pyJson.ts:
  ```ts
  export type PyJson = null | boolean | string | { int: string } | { float: number } | PyJson[] | { obj: [string, PyJson][] }
  /** Python's json.loads: an integer lexeme stays an int (any size), one with '.', 'e' or 'E' is a float; a repeated key keeps its first place and its last value. */
  export function parsePyJson(text: string): PyJson
  /** Python's json.dumps defaults: ensure_ascii, separators ', ' and ': ', float repr, NaN / Infinity / -Infinity. */
  export function pyJsonDumps(v: PyJson): string
  /** Python's str() of a JSON scalar: strings as they are, int digits, float repr, 'True' / 'False' / 'None'. Throws PY_STR_UNREADABLE on a list or dict. */
  export function pyStr(v: PyJson): string
  export function pyFloatRepr(x: number): string
  export const PY_STR_UNREADABLE = 'The model answered in a form Sailor can’t read'
  ```
  kit.ts: `createFakeReplicate(o?: { answer?(req: { model: string; input: Record<string, unknown> }): unknown; bodyText?(req): string })` and `createFakeFal(o?: { answer?(req: { endpoint: string; input: Record<string, unknown> }): unknown; bodyText?(req): string })`; without `answer`, today's picture answers.

**Behaviour:**
- `'glb'` waits as a video does (Python polls the 3D calls with `_VIDEO_POLL_DEADLINE_SEC`, 30 min, `nodes_replicate.py:122`); `'audio'` and `'value'` wait as a picture (Python's default 5-minute poll, `_DEFAULT_POLL_DEADLINE_SEC`, :121) unless the task says video (Describe a video, `:5447`; Sync lips to audio, `:4936`).
- `'glb'`: the first URL (or `urlsOf`) is downloaded, saved as `<prefix>_<n>_.glb` in the user's output subfolder, recorded with `addOutput`, and the node's slot 0 value is `{ kind: 'glb', url: '/view?filename=<name>&subfolder=<sub>&type=output', file }`. Reuse (R0.6) gives the same value back.
- Pipelines: `execNode` runs `plan.run(io)`. Each `io.call` looks up `rec.calls` by key: a `done` call returns its kept answer; a `sent` call waits on its recorded request (as a resumed provider node does); otherwise it is sent (with its backup under the backup rules) and written down before and after. A resumed call whose payload differs from the recorded one fails the node plainly and cancels the recorded request (the F12 rule). Stop cancels the call in flight.
- The stage charge (:786-790) sums `chargeableCredits(rec)`: a `done`, not reused node's `rec.credits`; for a node with `calls`, `creditsForUsd` of the finished calls' summed `usd` whether the node ended done, error or stopped; never above the node's hold share.
- `chargeOf`: after a value answer, `rec.credits = min(rec.credits, chargeOf(result) ?? rec.credits)`.
- A value answer's `raw` is the provider's body text for the prediction (Replicate) or result (fal).

**Test (`runner-paid-machinery`), each a separate `it`:**
- an audio plan: a fake Replicate WAV URL is downloaded, saved `.wav`, and handed to the next node; an MP3 answer is saved `.mp3`;
- a glb plan: saved `.glb`, value `{ kind: 'glb', url: '/view?…', file }`; a Model3D card reads it; reuse gives the same value; hosted: the file is recorded as the user's output;
- `take: 'first'` downloads one of three URLs; `rgb` keeps an RGB PNG whose pixels are the decoded RGB (trunc rule) of an RGBA answer;
- `rawTextOf` gives the body text for Replicate and fal answers from the fake clients' `bodyText`;
- a pipeline of three calls: all three sent in order, charged `creditsForUsd(Σ usd)`; the second call fails: charged for the first only, the third never sent; Stop during the second: the second cancelled, charged the first; a restart after the second call's answer: resumed, the first two never re-sent, the third sent once; a resumed pipeline whose second payload differs fails plainly and cancels;
- `chargeOf` lowers the charge; one returning more than the hold is charged the hold and reported;
- with no R3 plan in a prompt, every existing `runner-*.unit.spec.ts` is green unchanged.

**Test (`py-json`):** `parsePyJson` + `pyJsonDumps` reproduce Python's `json.dumps(json.loads(t))` on a fixture list of bodies written by `scripts/runner_paid_fixtures.py --group machinery` (ints past 2⁵³, `1.0`, `1e5`, `1E-7`, `-0.0`, `NaN`, `Infinity`, non-ASCII, astral characters as surrogate pairs, repeated keys, nesting); `pyFloatRepr` matches Python's `repr` on 10,000 recorded doubles; `pyStr` on every scalar.

**Acceptance:** all of the above; the families-off invariant holds (rule 15); the esbuild and typecheck guards pass.

---

### Task R3.2: The price module, moderation lists and the paid fixtures harness

No family: the shared pieces every R3 task fills in.

**Files:**
- Create `frontend/shared/pricing/paidRates.ts`: `PAID_RATES: Record<string, PaidRate>` and `paidCallUsd(call: PaidCall): number | null`, which falls back to `editUsd` / `videoPriceUsd` / the clip cards for an endpoint carded there already.
- Create `frontend/shared/pricing/paidSettings.ts`: `PAID_NODE_CLASSES`, `paidCalls`, `paidNoCall`.
- Modify `frontend/shared/pricing/nodePrice.ts`: `priceNode` (:223) prices `PAID_NODE_CLASSES` through `paidCalls`; `SHARED_PRICED_CLASS_SET` (:95) includes them; `PriceOptions` gains `inputChars?: number` and `answerUsage?: { inputTokens: number; outputTokens: number }`.
- Modify `frontend/server/runner/metering.ts`: `PAID_TEXT_INPUTS` read by `extraPromptTexts` (:125); `stageEstimate` (:159) skips `paidNoCall` nodes as it skips `actionPassThrough` ones.
- Create `scripts/runner_paid_fixtures.py` and `frontend/tests/unit/__runner__/paidParity.ts`.
- Test: `frontend/tests/unit/runner-paid-pricing.unit.spec.ts`.

**Interfaces:**
```ts
// paidRates.ts
interface RateMeta { service: 'fal' | 'replicate'; source: string; read: string; confidence: 'verified' | 'estimate' }
export type PaidRate =
  | (RateMeta & { unit: 'per_call', usd: number })
  | (RateMeta & { unit: 'per_token', inputPerMillion: number, outputPerMillion: number })
  | (RateMeta & { unit: 'per_input_second', perSecond: number, minSeconds?: number })
  | (RateMeta & { unit: 'per_output_second', perSecond: number })
  | (RateMeta & { unit: 'per_thousand_chars', perThousand: number })
  | (RateMeta & { unit: 'gpu_ceiling', usd: number, note: string })
export interface PaidCall {
  endpoint: string
  tier?: string | null
  inputTokens?: number; outputTokens?: number
  inputSeconds?: number; outputSeconds?: number
  chars?: number
  inputPixels?: number | null; outputPixels?: number | null
  fallbacks?: PaidCall[]
}
export function paidCallUsd(call: PaidCall): number | null

// paidSettings.ts
export const PAID_NODE_CLASSES: readonly string[]      // filled by each task
export type PaidCalls = { steps: { call: PaidCall, times: number }[] } | { refused: string }
/** The calls the node's settings can make, at their most expensive where an input is linked. `usage`: what the answer reported (token nodes), for the charge. */
export function paidCalls(classType: string, inputs: NodeInputs, opts: PriceOptions): PaidCalls
/** True when Python returns before calling anyone, decided from the inputs as sent (rule 8). */
export function paidNoCall(classType: string, inputs: NodeInputs): boolean

// metering.ts
export const PAID_TEXT_INPUTS: Readonly<Record<string, readonly string[]>>   // filled by each task
```
The node's price is `editStepsUsd`'s rule over `steps` (the first service marked up, fallbacks at cost), turned into credits by `creditsForUsd`.

**`scripts/runner_paid_fixtures.py`:**
- imports `block_network`, `_node_modules` and the patch list from `scripts/runner_builder_fixtures.py` (unchanged) and calls `block_network()` before any node import;
- `capture_calls(node_cls, answers: list, **kwargs) -> dict`: patches `_run_prediction`, `fal_refs.run_fal_prediction`, `_upload_public_file`, `_lipsync_hosted_media_url`, `_image_tensor_to_data_url` (→ `IMG:<name>`), `_audio_dict_to_wav_data_url` (→ `WAV:<name>`), `download_url_to_image_tensor`, `download_url_to_video_output`, `_download_url_to_audio_dict`, `save_generation_output`, `save_live_preview`, `save_image_to_input` and aiohttp GETs of JSON links (served from the case); each patched call records `{ provider, endpoint, payload }` and returns the next answer; it returns `{ calls, output, ui }` with `output` as Python returned it (strings verbatim; tensors as the URL they came from);
- `--group <g>` writes `frontend/tests/unit/fixtures/runner-paid-<g>.json`, sorted keys, stable bytes;
- group `machinery`: the `pyJson` cases of R3.1.

**`paidParity.ts`:** `runPaidCase(c: PaidCase, o: { families: ReadonlySet<RunnerFamily>; hosted?: boolean })` builds the node's prompt, runs it through the kit with the case's answers, and returns `{ sent: FakeRequest[], values, files, credits }`; `expectCalls(sent, pyCalls)` (pictures compared by input name, `IMG:<name>` ↔ the handed-off file's source).

**Test (`runner-paid-pricing`):**
- a stand-in class with a per-token card: the hold is `creditsForUsd` of the ceiling; `answerUsage` below it prices below it; above it is capped at the hold;
- a stand-in pipeline: price = `editStepsUsd` of its steps; a partial price of its first step is ≤ the whole;
- `paidNoCall` → `stageEstimate` holds nothing;
- `PAID_TEXT_INPUTS` texts reach `moderate` at the start (typed) and not twice;
- `GRAPH_NODE_CREDITS` still prices every class no task has moved (the price-graph coverage guard passes).

**Acceptance:** all green; `runner-builders.json` byte-identical; no family added.

---

### Task R3.3: The seven LLM text nodes (family `llm-text`)

**Port:**

| Class | Python | Provider · model | Sent (payload) | Outputs | Pricing basis |
|---|---|---|---|---|---|
| ChatLLMNode | `nodes_replicate.py:5584-5637` | Replicate `openai/gpt-5`, `anthropic/claude-4.5-sonnet`, `google/gemini-3-flash` by `model` (:5614-5627) | GPT-5: `{prompt, temperature, max_completion_tokens, system_prompt?}`; Claude: `{prompt, temperature, max_tokens, system_prompt?}`; Gemini: `{prompt, temperature, max_output_tokens, system_instruction?}`; the system key only when `system_prompt` is non-empty (Python truthiness) | slot 0 text: `''.join(str(x))` of a list, or the string, or `str(out or "")`, then `.strip()` (:5629-5637); no ui | tokens: in ≤ UTF-8 bytes of prompt + system; out ≤ `max_tokens` (1–8192, :5603) |
| ImprovePromptNode | `:5657-5698` | `openai/gpt-5-nano` | `{prompt: idea, system_prompt: _IMPROVE_PROMPT_SYSTEM_BASE.format(kind=target), temperature: 0.7, max_completion_tokens: 200}` (:5648-5654, :5683-5689) | text as Chat; no ui | tokens, out 200 |
| SummarizeTextNode | `:5774-5808` | `_run_llm` (:5723-5754) over `_SUMMARIZE_MODELS` (:5765): Gemini 3 Flash, GPT-5 nano, Claude 4.5 Haiku | system `"You are a precise summarizer. " + _SUMMARIZE_LENGTHS[length] + …` (:5766-5771, :5802-5806), temperature 0.3, max 400 | text; ui `{text: [result]}`; blank `text` → `""`, ui `{text: [""]}`, no call (:5800-5801) | tokens, out 400 |
| TranslateTextNode | `:5828-5864` | `_run_llm("Gemini 3 Flash")` | target = `custom_language.strip()` or `target_language` (:5820-5825); system :5858-5862; temperature 0.2; max 2048 | as Summarize; blank → no call | tokens, out 2048 |
| RewriteToneNode | `:5904-5939` | `_REWRITE_MODELS` (:5875): Claude 4.5 Haiku, Gemini 3 Flash, Claude 4.5 Sonnet | `_TONE_GUIDANCE` (:5889-5901, tones :5876-5888), system :5933-5937; temperature 0.6; max 1024 | as Summarize; blank → no call | tokens, out 1024 |
| BrainstormIdeasNode | `:5961-6018` | `_run_llm("GPT-5 mini")` | angles `_BRAINSTORM_ANGLES` (:5951-5958); system :5991-5996 with `count` (2–12); temperature 0.9; max 600 | the clean-up loop (:6001-6017: `splitlines`, strip, drop leading `-•*` and `1.`/`1)` markers, first `count` lines, `"\n".join`); ui `{text: [joined]}`; blank → no call | tokens, out 600 |
| ReasonStepByStepNode | `:6033-6073` | `_REASON_MODELS` (:6030): DeepSeek R1 (OpenAI-shaped, :5718), GPT-5, Claude 4.5 Sonnet | system by `include_reasoning` (:6062-6071); temperature 0.4; max 2048 | as Summarize; blank → no call | tokens, out 2048 |

`_run_llm`'s slug table (`_LLM_MODEL_SLUGS`, :5710-5719) and its three input shapes (:5737-5746) are ported once. The seven endpoints: `openai/gpt-5`, `openai/gpt-5-mini`, `openai/gpt-5-nano`, `anthropic/claude-4.5-sonnet`, `anthropic/claude-4.5-haiku`, `google/gemini-3-flash`, `deepseek-ai/deepseek-r1`. No backup: no fal twin of these models has a saved schema or a rate card.

**Deviations (precedent, not new rulings):** a blank `prompt` (Chat) or `idea` (Improve a prompt) is refused before the hold ("Chat with an LLM needs a question." / "Improve a prompt needs an idea to work on."): Python sends it and pays for an empty answer (the line-up's empty-prompt rows, F8/F13). The four nodes that return `""` for blank text keep Python's behaviour (no call, no charge).

**Files:**
- Create `frontend/server/runner/generators/llm.ts`: `LLM_MODEL_SLUGS`, `llmInput(model, prompt, { system, temperature, maxTokens })`, the seven builders, `llmText(result)` (the join / `pyStr` / `pyStrip`), `brainstormLines(text, count)`.
- Modify `frontend/shared/runner/pyText.ts`: `pySplitlines(s)` (Python's `str.splitlines` line breaks: `\n`, `\r`, `\r\n`, `\v`, `\f`, `\x1c`–`\x1e`, `\x85`, ` `, ` `) and `pyIsDigit(ch)` (Unicode `Nd` plus the digit-like characters Python's `str.isdigit` accepts; checked by fixture).
- Modify `executors.ts` (seven cases), `eligibility.ts` (rows: `family: 'llm-text'`, widgets from the schema with their options and bounds, `valueInputs` on each text input `['text', 'json']`), `shared/runner/values.ts` (`OUTPUT_KINDS` rows `{ 0: 'text' }`), `families.ts` (`llm-text`, `FAMILY_REQUIRES` → `cards`), `validate.ts` (`RUNNER_OUTPUT_CLASSES`: all seven are `is_output_node`), `paidSettings.ts` / `paidRates.ts` (seven token cards), `priceBook.ts` (drop rows :343-349), `metering.ts` (`PAID_TEXT_INPUTS`: Chat `prompt`, `system_prompt`; Improve `idea`; Summarize, Translate, Rewrite `text`, Translate also `custom_language`; Brainstorm `topic`; Reason `question`), `scripts/runner_paid_fixtures.py` (group `llm`).
- Test: `frontend/tests/unit/runner-paid-llm.unit.spec.ts`.

**Interfaces:** consumes R3.1's value plans and `chargeOf`, R3.2's `paidCalls` (token calls with `inputTokens` = UTF-8 bytes of every text sent, capped per text at `MODERATION_MAX_INPUT_BYTES` in hosted, `server/utils/moderation.ts:38`; `outputTokens` = the max sent), `pyStrip`. Produces `planLlm(ctx: PlanContext): NodePlan` and the seven builders `chatLlmInput(inputs)`, `improvePromptInput(inputs)`, `summarizeInput(inputs)`, `translateInput(inputs)`, `rewriteInput(inputs)`, `brainstormInput(inputs)`, `reasonInput(inputs)`, each `{ slug: string; input: Record<string, unknown> } | { noCall: true }`.

**Pricing.** Hold: the token ceiling above at each endpoint's card (ruling (c)). Charge: the token counts the prediction reports (the saved schema and the live check show where Replicate puts them), through the same card; no counts → the hold.

**Fixtures (`llm`):** every class × every model × blank, spaces-only, one line, 2,000 characters, non-ASCII and emoji text; Chat with and without a system prompt, temperature 0, 1 and 2, max tokens 1 and 8192; Translate with each language and a custom one with spaces around it; every tone and angle; Brainstorm counts 2 and 12. Answers: a token list, a string with surrounding spaces, `null`, `[1, 2.0, true, null]`, a numbered and bulleted list with blank lines, ` ` and `\x85` line breaks, `"１."` (a full-width digit) for the clean-up loop.

**Test:** rule 16. Also: a Text card fed by Summarize shows Python's text; Summarize → Generate an image's `prompt_in` is moderated at the node's turn (R0.5) and refused when blocked; a blank wired text makes no call and releases its hold; the hold for Chat at `max_tokens` 8192 equals the card's ceiling; reuse follows ruling (d).

**Acceptance:** payloads equal Python's on every case; outputs byte-identical; the charge never exceeds the hold.

**Live check (`llm-text`):**

| Call | Settings | Est. cost |
|---|---|---|
| Summarize text | Gemini 3 Flash, "Short", 1 sentence in | ≈ $0.001 (badge `:5794`) |
| Summarize text | GPT-5 nano | ≈ $0.001 |
| Summarize text | Claude 4.5 Haiku | ≈ $0.001 |
| Rewrite in a tone | Claude 4.5 Sonnet | ≈ $0.002 (badge `:5924`) |
| Brainstorm ideas | GPT-5 mini, count 2 | ≈ $0.003 (badge `:5982`) |
| Chat with an LLM | GPT-5, max tokens 64 | ≈ $0.005 (badge `:5608`) |
| Think step by step | DeepSeek R1 | ≈ $0.01 (badge `:6053`) |

One call per endpoint, so each token card is checked against a real bill: ≈ $0.023.

---

### Task R3.4: Describe, read and find (family `describe`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| DescribeImageNode | `nodes_replicate.py:4865-4896` | Replicate `lucataco/moondream2` | `{image, prompt}` | text, joined and stripped as Chat; no ui | GPU time: `EDIT_RATES['lucataco/moondream2']` ($0.002, estimate, `editRates.ts:214`) |
| DescribeImageRemoteNode (hidden twin) | `:2154-2195` | same | same (no `model` widget) | same | same |
| DescribeVideoNode | `:5410-5456` | `google/gemini-2.5-flash`, 30-min wait (:5447) | `{prompt, videos: [video_url]}`; blank `video_url` raises (:5437-5438) | text, stripped | tokens (ruling (s)) |
| ExtractTextNode | `:5209-5247` | `bytedance/dolphin` | `{file: image, output_format: "markdown_content"}` | list → `"\n".join(str(x))`; dict → `text` or `markdown` or `transcription` or `""`; string; else `""`; then strip (:5237-5246) | GPU time (badge $0.005, `:5225`) |
| FindObjectsNode | `:5267-5305` | `zsxkib/yolo-world` | `{input_media: image, class_names: query, score_thr: confidence}` | slot 0 **json**: the answer string as it is, else `json.dumps(out)` (:5305) | GPU time (badge $0.005, `:5288`) |

No backups (no same-model twin on fal is carded). A picture is sent as Python sends the first frame of its batch (`_image_tensor_to_data_url`, `:195-211`): the handed-off file of the linked slot.

**Refusals before the hold:** Describe a video with a blank address → "Describe a video needs a link to the video."; an address that isn't `https:` in hosted → ruling (r).

**Files:** create `frontend/server/runner/generators/describe.ts` (`describeImageInput`, `describeVideoInput`, `extractTextInput`, `findObjectsInput`, `extractTextOf(result)`, `findObjectsJson(result, raw)`); modify `executors.ts`, `eligibility.ts` (rows, `imageInputs: ['image']`, `valueInputs` for `prompt` / `query` `['text']`), `values.ts` (`OUTPUT_KINDS`: Describe ×2, Describe a video, Extract text `{ 0: 'text' }`; Find objects `{ 0: 'json' }`), `families.ts`, `validate.ts`, `paidSettings.ts` / `paidRates.ts`, `priceBook.ts` (rows :338-342), `metering.ts` (`PAID_TEXT_INPUTS`: `prompt`, `query`), the script (group `describe`). Test: `runner-paid-describe.unit.spec.ts`.

**Interfaces:** consumes R3.1 (`valuesOf` with `raw`, `pyJsonDumps`), `pictureSourceOf`; produces `planDescribe(ctx): NodePlan`.

**Fixtures (`describe`):** each class with the default prompt, an empty prompt, non-ASCII; Find objects at confidence 0, 0.25 and 1 and a query with spaces and commas; answers for Find objects as a string, a dict with float coordinates written `12.0`, `1e-3`, a list, `null`; Extract text as a list of pages, a dict with each key, a dict with none.

**Test:** rule 16. Also: Find objects → Text card shows Python's exact JSON; a picture from Generate an image (4 channels) is handed off as its file, as the line-up's builders do.

**Acceptance:** requests equal; JSON byte-identical to Python on every recorded answer.

**Live check (`describe`):** Describe an image (default prompt, ≈ $0.002); Extract text (≈ $0.005); Find objects (≈ $0.005); Describe a video on a 3-second public clip (≈ $0.01, badge `:5431`). ≈ $0.022.

---

### Task R3.5: Upscale, enhance, fix faces, restore, remove background (family `image-repair`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| UpscaleImageNode | `nodes_replicate.py:4173-4311` | `_UPSCALE_SLUGS` (:4164-4170): `philz1337x/clarity-upscaler`, `philz1337x/crystal-upscaler`, `nightmareai/real-esrgan`, `recraft-ai/recraft-crisp-upscale`, `topazlabs/image-upscale` | per engine, :4265-4306 (Clarity's `seed` only when > 0; Topaz's face fields only with `face_enhance`) | first URL, picture; no ui | already by settings and measured size: `editCalls` (`editSettings.ts:354-392`, `upscaleCall` :327-335) and `EDIT_RATES` (`editRates.ts:186-210`, :223-226) |
| EnhanceDetailNode | `:4314-4392` | `build_enhance_input` (`replicate_refs.py:387-457`): Clarity at scale 1, Topaz with `upscale_factor "None"`, `fermatresearch/magic-image-refiner` at `"original"` | as `build_enhance_input` | first URL; no ui | already: `enhanceCall` (`editSettings.ts:337-341`) |
| FixFacesNode | `:4473-4506` | `sczhou/codeformer` | `{image, codeformer_fidelity, background_enhance, face_upsample, upscale}` | first URL; no ui | per call (badge $0.005, `:4491`) |
| CodeformerRemoteNode (hidden twin) | `:2102-2146` | same | same | first URL; ui `codeformer` | same |
| RestorePhotoNode | `:4434-4465` | `flux-kontext-apps/restore-image` | `{input_image, safety_tolerance, output_format}` | first URL; ui `restore_photo` | per call (badge $0.04, `:4449`) |
| RestorePhotoRemoteNode (hidden twin) | `:2063-2094` | same | same | same | same |
| RemoveBackgroundNode | `:4400-4426` | `851-labs/background-remover` | `{image}` | first URL (RGBA kept); ui `remove_bg` | per call, $0.0004 (verified, `priceBook.ts` `MODEL_COSTS['851-labs/background-remover']`; carded here) |
| RemoveBackgroundRemoteNode (hidden twin) | `:2029-2055` | same | same | same | same |

No backups: fal's CodeFormer and ESRGAN bill per megapixel or compute-second, a different basis (inventory §1(c) notes), and the others aren't on fal.

**Refusals before the hold:** a picture over `LARGEST_INPUT_PIXELS` (`editSettings.ts:65`) for the size-priced engines, through the existing `measuredInputProblem` (`requestRules.ts`) — already the ComfyUI gate's rule.

**Files:** create `frontend/server/runner/generators/repair.ts` (`upscaleInput(inputs, image)`, `enhanceInput(inputs, image)` — a port of `build_enhance_input` — `fixFacesInput`, `restorePhotoInput`, `removeBackgroundInput`); modify `executors.ts`, `eligibility.ts` (rows with the schema's widgets; the upscalers keep their `model` widget per engine), `families.ts`, `validate.ts` (Remove background, Restore photo and the twins are output nodes), `paidRates.ts` (three per-call cards) and `paidSettings.ts`, `priceBook.ts` (rows :294-299), `metering.ts` (`PAID_TEXT_INPUTS`: Upscale and Enhance `prompt`, `negative_prompt`), the script (group `repair`). Test: `runner-paid-repair.unit.spec.ts`.

**Interfaces:** consumes `measuredInput` (`metering.ts:59`), `editCalls`, R3.1 `take: 'first'`; produces `planRepair(ctx): NodePlan`.

**Fixtures (`repair`):** every engine at default; Clarity seeds 0 and 42, scale 1 and 10; Topaz each factor, face enhance on and off; Crystal each format; Real-ESRGAN face enhance; Enhance each engine at detail 0, 0.4, 1; Fix faces upscale 1 and 4; Restore both formats.

**Test:** rule 16. Also: a 4K picture into Upscale Topaz 6x is refused before the hold; the hosted gate's chained sizing (G1) sizes Upscale's output as input × factor².

**Acceptance:** requests equal; prices unchanged for Upscale and Enhance (the ComfyUI path's figures), new for the three per-call nodes.

**Live check (`image-repair`):** Real-ESRGAN 2× on a 512² picture ($0.002); Recraft Crisp ($0.006); Crystal ≤ 4.4 MP ($0.05); Topaz "None" ($0.08); Clarity at scale 1 (card floor $0.20, estimate — required); Enhance "Diffusion Refine" (floor $0.10, estimate — required); Fix faces (≈ $0.005); Restore (≈ $0.04); Remove background ($0.0004). ≈ $0.48.

---

### Task R3.6: Layers from one call, and outpaint (family `layers`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| LayerizeGraphicNode | `nodes_replicate.py:4514-4595` | Replicate `ideogram-ai/layerize` | `{flat_graphic_image, prompt: prompt.strip() (only when non-blank), seed (when > 0, max 0x7FFFFFFF)}` (:4554-4559) | slot 0 picture: the first URL with a picture extension, else the first that isn't the JSON (:4566-4574); slot 1 **json**: the JSON link's body text as it came (30 s timeout); on a fetch failure `json.dumps({"error": "failed to fetch layer data: <why>"})` (:4576-4587); ui `layerize` images plus `text: [layers_json]` when non-empty | per call (badge $0.08, `:4548`) |
| SeedreamLayerizeNode | `:4719-4774`, `seedream_layerize.py:12-60` | fal `bytedance/seedream/v5/pro/layerize` (no function), 300 s wait | `{prompt: prompt or "", image_url, image_size}` (`image_size` outside `auto`, `auto_1K`, `auto_1.5K`, `auto_2K` becomes `auto`) | each layer downloaded and saved to the **input** folder as `seedream_layer_<n>_.png` (RGBA kept, trunc rule); slot 1 **json** `json.dumps({"source": "seedream", "width": W, "height": H, "layers": [{filename, z_index, box, name, description}]})`; slot 0 the answer's `images[0]`, else the input picture; ui `seedream_layerize` plus `text` when there are layers | per call (badge $0.34, `:4742`); fal's rate read into a card |
| OutpaintImageNode | `:4789-4857` | Flux Fill: `black-forest-labs/flux-fill-pro` `{image, outpaint: direction, prompt, output_format: "png", safety_tolerance: 6, seed?}`; Bria Expand: `bria/expand-image` `{image, aspect_ratio, prompt?, seed?}` (:4831-4849) | first URL, alpha dropped (`rgb`, :4854-4856); no ui | per call by engine (badge $0.05, `:4823`) |

No backups (none carded). Layerize's error text: the runner's `<why>` is its own plain words, not aiohttp's message — a documented difference on a failure path only.

**Files:** create `frontend/server/runner/generators/layers.ts` (`layerizeInput`, `layerizeUrls(result)`, `seedreamLayerizeInput`, `parseSeedreamLayers(result)` — a port of `seedream_layerize.py:23-60` — `outpaintInput`); modify `executors.ts` (Seedream Layerize is a `pipeline` of one call plus its downloads, so the layers are saved in order with their names), `eligibility.ts` (rows; `imageInputs: ['image']`), `values.ts` (`OUTPUT_KINDS`: Layerize and Seedream `{ 1: 'json' }`), `PICTURE_OUTPUTS` (slot 0), `families.ts`, `validate.ts` (both layerizers are output nodes), `paidRates.ts` / `paidSettings.ts`, `priceBook.ts` (rows :289, :291, :293), `metering.ts` (`PAID_TEXT_INPUTS`: `prompt`), `inputs.ts` (Seedream's saved layers counted as the user's input files), the script (group `layers`). Test: `runner-paid-layers.unit.spec.ts`.

**Interfaces:** consumes R3.1 (`urlsOf`, `rgb`, `pipeline`), `ResultStore.save` with `folder: 'input'` (a new option: the user's input subfolder, `metering.addOutput` owning it; ruling (o)); produces `planLayers(ctx): NodePlan`.

**Fixtures (`layers`):** Layerize with blank and spaced prompts, seeds 0, 1, 2³¹−1; answers with the picture first, the JSON first, no extension, no JSON link, a JSON link that fails. Seedream every `image_size` and a bad one; answers with 2 and 17 layers, a layer without `bounding_box`, a non-dict layer, no `images`. Outpaint every direction and ratio, seeds 0 and 42, an RGBA answer.

**Test:** rule 16. Also: Layerize's `layers_json` feeds a Text card byte-identically; Seedream's layer files are owned by the user in hosted and refused to another user.

**Acceptance:** requests equal; JSON byte-identical; the picture chosen is Python's.

**Live check (`layers`):** Layerize a 512² poster (≈ $0.08); Seedream Layerize at `auto_1K` (≈ $0.34, badge); Outpaint Flux Fill "Make square" (≈ $0.05); Outpaint Bria Expand 1:1 (≈ $0.04, `:4803`). ≈ $0.51.

---

### Task R3.7: Separate background and foreground (family `layers`)

**Port:** `SplitPhotoLayersNode`, `nodes_replicate.py:4614-4711`, a pipeline:

| Call | Python | Provider · model | Sent | When |
|---|---|---|---|---|
| `cutout` | :4659-4663 | Replicate `851-labs/background-remover` | `{image, background_type: "rgba", format: "png"}` | always |
| `map` | :4672-4677 | same | `{image, background_type: "map", format: "png"}` | only when the cutout has no alpha |
| `fill` | :4688-4698 | `_PHOTO_FILL_SLUGS[background_fill]` (:4608-4611): `zylim0702/remove-object` ("LaMa (fast)") or `bria/eraser` ("Bria Eraser (quality)") | `{image: the RGB of the input (alpha dropped, :4695), mask: PNG data URL}` | always |

- The mask: the cutout's alpha as `round(clamp(a)·255)` (:4669-4670; the identity on an 8-bit PNG's alpha), or the map's channel 0; then, when `mask_grow` > 0, PIL's `MaxFilter(2·mask_grow + 1)` (:4680-4681); saved as an 8-bit greyscale PNG. The runner's `maxFilterL(l, w, h, size)` ports PIL's `RankFilter` max over a square, edges as PIL's fixture shows (PIL expands the image before filtering; the fixture proves the edge rule). The mask and the RGB copy are handed off by `io.handOff` (kept bytes, sha256).
- Outputs: slot 0 subject (the cutout as downloaded, RGBA kept), slot 1 background (alpha dropped, `rgb`). ui: `{ images: [split_subject file, split_background file], animated: [false] }` in slot order (:4706-4710).
- Price: hold = cutout + map + fill (the worst case, three calls); charge = the calls made (rule 12). Rate cards: `851-labs/background-remover` (R3.5), the two fill models (read by the task; the node's description quotes "~$0.003 total" for LaMa and "~$0.04" for Bria, `:4629-4630`).

**Files:** create `frontend/server/runner/generators/splitLayers.ts` (`planSplitLayers(ctx): NodePlan`, the mask step); create `frontend/server/runner/pixels/maxFilter.ts` (`maxFilterL`, self-contained, run on the Frame's worker with its Stop checks, as R2's cores are); modify `executors.ts`, `eligibility.ts` (row; `PICTURE_OUTPUTS: { SplitPhotoLayersNode: [0, 1] }`), `validate.ts`, `paidSettings.ts`, `priceBook.ts` (row :292), the script (group `split`, with `MaxFilter` fixtures). Test: `runner-paid-split.unit.spec.ts`.

**Fixtures (`split`):** the three calls in order for both fill engines, `mask_grow` 0, 1, 12 and 50, an RGBA and an RGB input; the mask PNG's pixels (not its bytes: PIL's and sharp's PNG encoders differ) for each case; the no-alpha path (the `map` call); `MaxFilter` alone on 37×23 and 320×200 masks at sizes 3, 25 and 101.

**Test:** rule 16. Also: the mask sent decodes to Python's mask pixels exactly; a fill failure charges the cutout only; a restart after the cutout resumes at the fill; a picture 50 px wide with `mask_grow` 50 matches Python.

**Acceptance:** calls and mask pixels exactly Python's; partial charges as rule 12.

**Live check (`layers`, the same family as R3.6):** Separate with LaMa on a 512² photo (≈ $0.003); with Bria Eraser (≈ $0.04). ≈ $0.045.

---

### Task R3.8: Music and speech (family `audio-gen`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| GenerateMusicNode | `nodes_replicate.py:5057-5087` → `MusicGenRemoteNode.execute` (:1722-1737) | Replicate `meta/musicgen` | `{prompt, duration (1–30), model_version, temperature, output_format: "wav", normalization_strategy: "peak", top_p (when > 0), seed (when > 0)}` | slot 0 a sound file (first URL, `.wav`) | GPU time by duration (badge $0.02, `:5078`) |
| MusicGenRemoteNode (hidden twin) | `:1689-1737` | same | same | same | same |
| GenerateSpeechNode | `:5094-5126` → `MiniMaxSpeechRemoteNode.execute` (:1818-1836) | `minimax/speech-02-hd` | `{text, voice_id, speed, volume, pitch, sample_rate: 32000, bitrate: 128000, channel: "mono", english_normalization: true, emotion (unless "auto"), language_boost (unless "auto")}` | slot 0 a sound file (first URL) | per thousand characters of `text` (badge $0.30 / 1K, `:5117`); a wired text at its ceiling (the moderation limit in hosted) |
| MiniMaxSpeechRemoteNode (hidden twin) | `:1783-1836` | same | same | same | same |

- Voices: `_MINIMAX_VOICES` (:1744-1749) plus cloned ids read from `models/voices/*.json` (`_list_cloned_voice_ids`, :1753-1780); a cloned id in hosted follows ruling (j).
- Python's output is a decoded waveform; the runner's is the sound file. Its readers, until R5.2: the Audio card (`comfy_extras/nodes_audio.py:279-350`) with `source` wired from one of these classes and `export` off shows the file (ruling (t)); Lip-sync a character on sync-3 reading it through that card. Any other reader is left to the engine.
- No backups (MiniMax Speech and MusicGen aren't carded on fal).

**Files:** create `frontend/server/runner/generators/audioGen.ts` (`musicGenInput`, `speechInput`, `MINIMAX_VOICES`); modify `executors.ts` (media `'audio'`), `eligibility.ts` (rows; the `Audio` row's `linkSources.source` gains `[['GenerateMusicNode', 0], ['GenerateSpeechNode', 0], ['MusicGenRemoteNode', 0], ['MiniMaxSpeechRemoteNode', 0]]` while `audio-gen` is on, and its `mustNotLink` drops `source` for them), `families.ts`, `paidRates.ts` / `paidSettings.ts` (`chars` = Python's `len(text)`, counted in code points), `priceBook.ts` (rows :325-328), `metering.ts` (`PAID_TEXT_INPUTS`: Music `prompt`, Speech `text`), the script (group `audio-gen`). Test: `runner-paid-audio-gen.unit.spec.ts`.

**Interfaces:** consumes R3.1 media `'audio'`; produces `planAudioGen(ctx): NodePlan`.

**Fixtures (`audio-gen`):** Music at durations 1 and 30, each version, top_p 0 and 0.5, seeds 0 and 7; Speech with every emotion and language boost, speed and pitch bounds, a non-ASCII text (character count), a cloned id.

**Test:** rule 16. Also: the Audio card shows the node's file and plays it; export on leaves the card to the engine; Speech's hold for a wired text is the ceiling, its charge the characters sent.

**Acceptance:** requests equal; the sound saved with the answer's extension; priced from the settings sent.

**Live check (`audio-gen`):** Generate music, 1 s, "large" (≈ $0.02, badge); Generate speech, 20 characters (≈ $0.006 at the badge's $0.30 / 1K). ≈ $0.03.

---

### Task R3.9: 3D (family `gen-3d`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| Generate3DNode | `nodes_replicate.py:5133-5164` → `Hunyuan3DRemoteNode.execute` (:1876-1894) | Replicate `tencent/hunyuan3d-2`, 30-min wait | `{image, steps, guidance_scale, octree_resolution, remove_background, texture, seed (when > 0)}` | slot 0 **glb** (first URL) | GPU time (badge $0.30, `:5152`) |
| Hunyuan3DRemoteNode (hidden twin) | `:1844-1894` | same | same | same | same |
| Hunyuan3DMultiViewNode | `:1902-2021` | by `engine`: `tencent/hunyuan3d-2mv` (:1966-1980), `hyper3d/rodin` (:1982-2003), `firtoz/trellis` (:2005-2021) | Hunyuan: `{front_image, steps, guidance_scale, octree_resolution, remove_background, file_type: "glb", back/left/right_image?, seed?}`; Rodin: `{images: [front, back?, left?, right?], prompt: prompt.strip() or "a full-body character", material: "PBR", mesh_mode: "Quad", quality, geometry_file_format: "glb", tapose, quality_override (when poly > 0), seed % 65536 (when > 0)}`; Trellis: `{images, generate_model: true, generate_color: false, texture_size: 1024, mesh_simplify: 0.95, seed and randomize_seed: false (when > 0)}` | slot 0 **glb**: Trellis's `output.model_file`, else the first URL (`urlsOf`) | GPU time per engine (badge $0.30, `:1951`; the description's "~$0.30–0.60", `:1916`) |

- The GLB is saved as Sailor's own copy (spec ruling 1; ruling (k)): value `{ kind: 'glb', url: '/view?filename=…&subfolder=…&type=output', file }`, read by the Model3D card (`eligibility.ts:649`), 3D Studio's `glb_url` and a Text card (the address as text). The address survives the provider link's expiry.
- Hunyuan3DMultiViewNode's `front_image` is required; the other views optional (`imageInputs`), `prompt` optional and moderated.
- No backups for now: fal's `fal-ai/hunyuan3d/v2`, `fal-ai/hyper3d/rodin` and `fal-ai/trellis-2` (`MODEL_COSTS`, `priceBook.ts`) have no saved schema, so it isn't known whether they are the same versions or can carry these settings; a later task may add them under rule 13.

**Files:** create `frontend/server/runner/generators/gen3d.ts` (`hunyuan3dInput`, `multiViewInput(engine, …)`, `trellisGlbUrl(result)`); modify `executors.ts` (media `'glb'`), `eligibility.ts` (rows), `values.ts` (`OUTPUT_KINDS` `{ 0: 'glb' }` for the three), `families.ts`, `validate.ts` (all three are output nodes), `paidRates.ts` / `paidSettings.ts` (one card per engine), `priceBook.ts` (rows :333-335), `metering.ts` (`PAID_TEXT_INPUTS`: Multi-View `prompt`), the script (group `gen-3d`). Test: `runner-paid-3d.unit.spec.ts`.

**Fixtures (`gen-3d`):** each engine with one, two and four views; seeds 0, 1, 65 536 and 0xFFFFFFFF (Rodin's modulo); Rodin blank and spaced prompts, poly 0 and 300 000, every quality; Trellis answers as a dict with `model_file`, a dict without, a list.

**Test:** rule 16. Also: the saved GLB's address is served by `/view` to its owner and refused to another user in hosted; a Model3D card and 3D Studio read it; a 600 MB answer is refused by the download cap after the call and charged (rule 3).

**Acceptance:** requests equal; the value is Sailor's own address.

**Live check (`gen-3d`):** Generate a 3D model at steps 20, octree 128, no texture (≈ $0.30, badge); Multi-View Hunyuan3D-2mv, front only (≈ $0.30); Rodin at "extra-low" (≈ $0.60, the description's top); Trellis front only (≈ $0.30). ≈ $1.50.

---

### Task R3.10: Sound in — transcribe, identify speakers, clone a singing voice, sync lips (family `sound-in`; after R5.1)

Each of these sends a sound Python has decoded and re-encoded as a 16-bit WAV of at most 60 seconds (`_audio_dict_to_wav_data_url`, `nodes_replicate.py:379-421`: the first `int(60 · rate)` samples, `clamp(-1, 1) · 32767` truncated to int16, `pcm_s16le`, mono or stereo by channel count). The runner makes the same samples with R5.1's ffmpeg decode (float32, as `comfy_extras/nodes_audio.py` `load` reads it) and writes its own WAV; parity is on the decoded samples (PyAV's WAV header carries an encoder tag, so the bytes differ). Ruling (l) is whether to wait for R5.1 or send the file as it is.

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| TranscribeAudioNode | `nodes_replicate.py:5024-5050` → `WhisperRemoteNode.execute` (:1662-1681) | fal `fal-ai/wizper` (no function); the WAV uploaded to fal storage (`_lipsync_hosted_media_url`, :2311-2332) | `{audio_url, task: "translate" \| "transcribe", version: "3", language (unless "auto")}` | slot 0 text: `str(result.text or "")`, **not** stripped | per second of the sound sent (≤ 60 s; badge $0.005/min, `:5042`) |
| WhisperRemoteNode (hidden twin) | `:1631-1681` | same | same | same | same |
| IdentifySpeakersNode | `:5531-5569` | Replicate `thomasmol/whisper-diarization` | `{file: WAV data URL, num_speakers (when > 0), language (unless "auto")}` | slot 0 **json**: the answer string, else `json.dumps(output)` | per second sent (badge $0.05/min, `:5553`) |
| CloneSingingVoiceNode | `:5470-5523` | `zsxkib/realistic-voice-cloning` | `{song_input: WAV, rvc_model, pitch_change, pitch_change_all: float(semitones), pitch_detection_algorithm, output_format, custom_rvc_model_download_url (when "CUSTOM" and set)}`; presets `_RVC_PRESET_VOICES` (:5464-5467) | slot 0 a sound file | per second sent (badge $0.02/min, `:5502`); ruling (m) |
| LipsyncNode | `:4904-4940` | `sync/lipsync-2-pro`, 30-min wait | `{video: video_url as typed, audio: WAV, sync_mode}`; blank `video_url` raises (:4929-4930) | slot 0 video (first URL) | already per measured second: `clipSettings.ts:508-514`, `CLIP_RATES['sync/lipsync-2-pro']` $0.08325/s (`clipRates.ts:109-112`) |
| LipsyncRemoteNode (hidden twin) | `:2203-2256` | same | same | same | same |

- Sources: an Audio card holding a file (the sync-3 machinery, `mediaInputs.ts`), and after R5.2 any runner sound. Measured before the hold (`nodeMedia.ts` gains a `'sound-in'` kind); a sound longer than 60 s is sent cut to 60 s, as Python does, and priced at 60 s.
- Hosted: the Audio card's file and a `/view` video link must be the user's own (rule 11); ruling (r) for typed addresses.

**Files:** create `frontend/server/runner/generators/soundIn.ts` (`wizperInput`, `diarizationInput`, `rvcInput`, `lipsync2ProInput`), `frontend/server/runner/soundWav.ts` (`pythonWav(file): Promise<{ wav: Uint8Array; seconds: number }>`, on R5.1's `decodeAudio`); modify `executors.ts`, `eligibility.ts`, `values.ts` (Transcribe ×2 `{ 0: 'text' }`, Identify `{ 0: 'json' }`), `families.ts`, `nodeMedia.ts`, `paidRates.ts` / `paidSettings.ts`, `priceBook.ts` (rows :323-324, :329-330), `metering.ts` (`PAID_TEXT_INPUTS`: none but the RVC URL is not text), the script (group `sound-in`; Python's WAV samples recorded). Test: `runner-paid-sound-in.unit.spec.ts`.

**Fixtures (`sound-in`):** 3 s mono and stereo clips at 16, 44.1 and 48 kHz, a 75 s clip (cut at 60 s), a clip with samples beyond ±1; each class's settings across their options; wizper answers with `text` missing, `null`, surrounding spaces.

**Test:** rule 16. Also: the WAV's samples equal Python's exactly; a 75 s clip is priced at 60 s; Transcribe's text keeps its spaces (Python doesn't strip).

**Acceptance:** requests equal (sound compared by samples); outputs byte-identical.

**Live check (`sound-in`):** Transcribe 10 s (≈ $0.001); Identify speakers 10 s (≈ $0.01); Clone a singing voice 10 s, preset "Guitar" (≈ $0.004); Sync lips to audio 2 s ($0.17). ≈ $0.19.

---

### Task R3.11: Film a shot — the preset path (family `film-shot`)

Already taken (commit 729060504, `eligibility.ts:1186-1211`): a shot-directed Film a shot (`__shot_directed` in `model_options`) on Seedance 2.0, Veo 3.1, Veo 3.1 Fast, and Kling 3 with `replicate-video`. This task takes the rest: a Film a shot whose prompt the node writes from a preset.

**Port:** `FilmShotNode`, `nodes_replicate.py:4016-4152`, and `comfy_api_nodes/shot_presets.py`:
- the 28 presets (`PRESETS`, :38-189), the override options (`SIZE_OPTIONS` … `COMPOSITION_OPTIONS`, :199-231, `AUTO = "auto (preset)"`, :20; default preset `"push-in"`, :22);
- `resolve_recipe` (:236-247: an unknown preset falls back to the default; an override that isn't `AUTO` replaces the preset's field);
- `dialect_for_model` (:307-313: `veo*` → veo, `hailuo*` → hailuo, else standard) and `build_shot_phrase` (:289-304, the three dialects; `_hailuo_brackets` :276-282 over `_HAILUO_COMMANDS` :251-273; `_cap` :285-286);
- `full_prompt = f"{shot_phrase} {prompt.strip()}".strip()` unless shot-directed (:4124-4134); `model_options` JSON (a bad or non-object one is `{}`, :4110-4115), `__shot_directed` popped, local `/view` refs resolved (`_resolve_local_refs`, :3812-3826; the runner's `shotRefs.ts`);
- `fabric-1.0` refused (:4098-4102) and an image-to-video-only model without `image` refused (:4104-4108), both before the hold: "Film a shot can't use a lip-sync model. Pick a camera model." and "This model needs a first frame. Connect a picture to Film a shot.";
- the request is then exactly Generate a video's for that model (`planVideoGeneration`, `executors.ts`), so its backups and checks are Generate a video's.

Taken on every video model the runner films for Generate a video, each under that model's own family as well as `film-shot`. Pricing already exists (`FilmShotNode` is model-priced, `nodePrice.ts:79`); the video rate cards are the line-up's.

**Files:** create `frontend/shared/runner/shotPresets.ts` (`SHOT_PRESETS`, the option lists, `resolveShotRecipe`, `shotDialectForModel`, `buildShotPhrase`; shared so the canvas can preview the phrase later); modify `eligibility.ts` (`filmShotTaken` :1205: a non-directed shot is taken while `film-shot` is on and the model's own rule allows it; the preset and overrides are widgets checked against the option lists), `executors.ts` (`FilmShotNode` case :611: the phrase), `families.ts`, the script (group `film-shot`). Test: `runner-paid-film-shot.unit.spec.ts`.

**Fixtures (`film-shot`):** every preset × three dialects (a Veo, a Hailuo and a standard model) with blank and spaced prompts; each override on its own and all five at once; an unknown preset; `model_options` bad JSON, a list, `__shot_directed: false`; `capture_first_call` on FilmShotNode for every model in the node's list, with and without `image`.

**Test:** rule 16. Also: the shot-directed cases of `runner-film-shot.unit.spec.ts` are unchanged; with `film-shot` off a preset shot stays with the engine.

**Acceptance:** the phrase and the request equal Python's on every case.

**Live check (`film-shot`):** one preset shot on the cheapest model the node offers, e.g. PixVerse v6 360p silent 5 s on fal (5 × $0.025 = $0.125, `videoRates.ts:299-303`). ≈ $0.13.

---

### Task R3.12: Text effect, sketch to image, face references (family `image-extras`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| TextEffectNode | `nodes_replicate.py:3691-3762`, `text_effects.py:1-244` | generate: Replicate `ideogram-ai/ideogram-v3-turbo`; restyle (a picture wired): `black-forest-labs/flux-kontext-pro` | generate `{prompt: build_prompt(effect, text), aspect_ratio: aspect_ok(ar), magic_prompt_option: "Off", seed?}`; restyle `{prompt: build_edit_prompt(effect, text, freedom), input_image, aspect_ratio: edit_aspect(ar), output_format: "png", seed?}` (`build_text_effect_request`, :200-244) | first URL; ui `text_effect` | per call by path (badge $0.04, `:3738`) |
| SketchToImageNode | `:5171-5201` | `google/nano-banana` | `{prompt, image_input: [image]}` | first URL; no ui | per call: `EDIT_RATES['google/nano-banana']` $0.039 (verified, `editRates.ts:161`) |
| ConsistentFaceNode | `:5313-5353` | `ideogram-ai/ideogram-character` | `{prompt, character_reference_image, aspect_ratio, seed (when > 0)}` | first URL; no ui | per call ($0.08 estimate, `MODEL_COSTS['ideogram-ai/ideogram-character']`) |

- Text effect's catalogue: the 16 effects (`EFFECTS`, `text_effects.py:61-118`), `build_prompt` (blank text → `"TEXT"`, unknown effect → the default), `_preserve_clause` (the freedom bands 0.12 / 0.45 / 0.78), `aspect_ok`, `edit_aspect`, `MATCH_INPUT_AR = "Match input"`. Generate mode with blank text is refused before the hold with Python's words, "Enter some text to render." (`text_effects.py:236`).
- Replicate's Ideogram V3 takes a seed only up to 2³¹−1 (`twins.ts` RUNNER_ROUTES reason for `image:ideogram-v3-*`); the node's seed goes to 0xFFFFFFFF, so Python sends a seed Replicate refuses after the hold. The runner refuses it first: "Text effect takes a seed up to 2147483647. Pick a smaller one." (precedent: refuse what the provider would refuse).
- No backups now: fal's `fal-ai/ideogram/v3` and `fal-ai/flux-pro/kontext` are the same models, but Replicate's own prices for these slugs aren't carded, so the backup rule can't be checked; a later task adds them.

**Files:** create `frontend/server/runner/generators/textEffects.ts` (the catalogue and builders, ported line for line), `frontend/server/runner/generators/imageExtras.ts` (`sketchInput`, `consistentFaceInput`); modify `executors.ts`, `eligibility.ts` (rows; `imageInputs`), `families.ts`, `paidRates.ts` / `paidSettings.ts` (Ideogram V3 Turbo and Kontext Pro on Replicate, Ideogram Character), `priceBook.ts` (rows :287-288, :290), `metering.ts` (`PAID_TEXT_INPUTS`: Text effect `text`, the others `prompt`), the script (group `image-extras`). Test: `runner-paid-image-extras.unit.spec.ts`.

**Fixtures (`image-extras`):** every effect × both paths × freedom 0, 0.12, 0.45, 0.78, 1 and none; every ratio in both paths; seeds 0, 42, 2³¹−1, 2³¹; Sketch and Face with blank and non-ASCII prompts, every ratio.

**Test:** rule 16. Also: the gallery catalogue (`app/data/text-effects.ts`) has the same ids as the port.

**Acceptance:** requests equal on every case.

**Live check (`image-extras`):** Text effect generate "HELLO" 1:1 (≈ $0.03, fal's carded figure for the same model as a stand-in); restyle a 512² word picture (≈ $0.04); Sketch to image ($0.039); Face references 1:1 ($0.08, estimate — required). ≈ $0.19.

---

### Task R3.13: Flux Dev + LoRA and Flux Dev + LoRAs (family `lora`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| FluxLoRARemoteNode | `nodes_replicate.py:480-665` | the user's trained model run directly (`resolve_flux_lora_plan`, `replicate_refs.py:233-249`), else `black-forest-labs/flux-dev-lora` | `{prompt, aspect_ratio, megapixels, num_inference_steps, num_outputs: 1, output_format: "png", disable_safety_checker: false, seed?}`; image-to-image adds `{image, prompt_strength}`; trained model: `guidance_scale`, `lora_scale`; flux-dev-lora: `guidance`, and `lora_weights` + `lora_scale` when a ref resolved (:618-656) | first URL, alpha dropped; ui `flux_lora` | per call: `EDIT_RATES['black-forest-labs/flux-dev-lora']` $0.04 (estimate, `editRates.ts:219`); the LoRA category (`LORA_RENDER_CREDITS`, `priceBook.ts:175`) |
| FluxMultiLoRARemoteNode | `:678-977` | `lucataco/flux-dev-multi-lora` | `{prompt (prompt_in folded ahead, style_in prepended, :883-887), aspect_ratio, num_inference_steps, guidance_scale, hf_loras, lora_scales, num_outputs: 1, output_format: "png", disable_safety_checker: false, seed?}` + `{image, prompt_strength}` | first URL, alpha dropped; ui `flux_multilora` | per call × 2 (the reload retry, ruling (g)) |

- LoRA resolution: `_read_lora_sidecar` (`replicate_refs.py:95-111`), `_resolve_trained_model` (:114-132), `_is_replicate_model_ref` (:135-150), `_bare_owner_model` (:153-157), `_resolve_lora_url` (:160-174), `_resolve_lora_weights_url` (:177-193), `_replicate_model_to_lora_ref` (:196-206), `_normalize_lora_ref` (:209-230), `_multilora_collect` (:517-540), and `_autodetect_huggingface` (`nodes_replicate.py:162-192`, ruling (h)).
- Flux Dev + LoRAs' reload guard: the order is reversed on every other call with two or more LoRAs (a process-wide toggle, :927-931; the runner keeps its own, ruling (g)); after the answer, if its logs lack `"Downloading LoRA weights"`, it calls once more with the order flipped (:955-968). That is a `pipeline` of one or two calls.
- `prompt_in` and `style_in` take wired text (R1.2's pattern: `valueInputs: { prompt_in: ['text'], style_in: ['text'] }`), `_fold_prompt_in` (:113-117) ported.
- Hosted: ruling (i).
- No backups (fal's `fal-ai/flux-lora` is another service's LoRA loader, priced per megapixel, `MODEL_COSTS`).

**Files:** create `frontend/server/runner/generators/lora.ts` (the resolution functions, `fluxLoraInput`, `fluxMultiLoraInput`, `foldPromptIn`), `frontend/server/runner/loraFiles.ts` (reads a sidecar from `models/loras/` by name, refuses a path outside it, hosted ownership per ruling (i)); modify `executors.ts`, `eligibility.ts` (rows; `lora_name` / `lora_a`…`lora_d` checked against the LoRA list the canvas sends), `families.ts`, `inputs.ts` (LoRA sidecars named by widgets), `paidSettings.ts`, `priceBook.ts` (rows :272-273), `metering.ts` (`PAID_TEXT_INPUTS`: `prompt`, and the wired `prompt_in` / `style_in` at the node's turn), the script (group `lora`, with fixture sidecars in a temporary `models/loras/`). Test: `runner-paid-lora.unit.spec.ts`.

**Fixtures (`lora`):** a sidecar with `replicate_model` (with and without `:version`), one with `replicate_url` only, none, a broken JSON; `lora_url` as a trained ref, an `https://huggingface.co/…` URL, `hf.co/…`, a bare `owner/model`, a `.safetensors` URL; image-to-image on and off; seeds 0 and 42; Flux Dev + LoRAs with 0, 1, 2 and 4 slots, a repeated LoRA (collapsed to its highest scale), `prompt_in` and `style_in` blank and set; answers whose logs have and lack the marker.

**Test:** rule 16. Also: with the marker missing, the second call is sent with the order flipped and charged; with it present, one call; the rotation alternates across two runs in one process.

**Acceptance:** requests equal on every case (with the network blocked, as the fixtures run: the HuggingFace look-up's offline branch).

**Live check (`lora`):** Flux Dev + LoRA with a public HuggingFace LoRA URL, 0.25 MP (≈ $0.04); with a trained model of the user's (≈ $0.04); Flux Dev + LoRAs with two public LoRAs (≈ $0.04, ≈ $0.08 if the retry fires). ≈ $0.16.

---

### Task R3.14: Restyle an Image · Style LoRA (family `lora`)

**Port:** `RestyleWithLoRANode`, `nodes_replicate.py:3234-3432`, a pipeline whose calls are already priced (`editSteps`, `editSettings.ts:557-567`; `RESTYLE_LORA_NB_RETRIES = 2`, :547):

| Call | Python | Provider · model | Sent |
|---|---|---|---|
| `describe` | :3328-3345 | Replicate `lucataco/moondream2` | `{image: content, prompt: describe_prompt}` (the old default `"Describe this image in detail."` becomes `_RESTYLE_DESCRIBE_PROMPT`, :337-341, :3328-3329) |
| `stylize` | :3347-3386 | the LoRA plan (R3.13's `resolve_flux_lora_plan`): the trained model or `black-forest-labs/flux-dev-lora` | `{prompt: build_flux_style_prompt(trigger, sidecar_aesthetic(sidecar), caption) (replicate_refs.py:460-514), image: content, prompt_strength, num_inference_steps, num_outputs: 1, output_format: "png", disable_safety_checker: false, seed: int(seed)}` + guidance / LoRA fields as R3.13 |
| `classify-ref` | `_classify_image_style` (:344-376) | `lucataco/moondream2` | `{image: style_url, prompt: <the classify text, :357-365>}`; any failure → `"photo"`; `classify_style_answer` (`replicate_refs.py:331-348`) |
| `nb-1` … `nb-3` | :3401-3423 | Nano Banana 2 edit: fal `fal-ai/nano-banana-2/edit` first, as Python's `_run_nano_banana_edit` (:1165-1223) | `[content, style_url]`, `build_restyle_instruction(structure_strength, extra_style_direction)` (`replicate_refs.py:351-378`, `+ RESTYLE_ANTIPHOTO_RETRY` :315 from the second attempt), resolution, output format, seed `(seed + attempt) & 0xFFFFFFFF` |
| `classify-1` … | :3420 | `lucataco/moondream2` | each NB answer, only for an illustration target |

- `restyle_style_strength_to_knobs` (`replicate_refs.py:294-312`) gives the structure strength and the Flux prompt strength. A caption that comes back empty is `"a high quality image"` (:3344-3345). A photo target takes the first NB answer; an illustration target stops at the first answer still classified an illustration, else the Flux picture is the result (:3425). Alpha dropped; ui `restyle_lora`.
- The stylize answer is handed to NB by its provider link (Python does, :3380-3383); the runner hands off its own kept copy instead (the hand-off rule: never a provider link that can expire), the same picture.
- NB step: fal first, no backup — Replicate's Nano Banana 2 takes no seed (`twins.ts` reason for `image:nano-banana-2`), and this node's seeds are its promise of repeatable results. Python's middle step (fal Nano Banana Pro) is not sent; its price stays covered (`editSteps` prices the chain).
- Partial charges per call (rule 12): e.g. a failure in `nb-2` charges describe, stylize, classify-ref, nb-1 and classify-1.

**Files:** create `frontend/server/runner/generators/restyleLora.ts` (`planRestyleLora(ctx): NodePlan`, the ported helpers `buildFluxStylePrompt`, `sidecarAesthetic`, `aestheticToKeywords`, `classifyStyleAnswer`, `restyleStyleStrengthToKnobs`); modify `executors.ts`, `eligibility.ts` (row), `families.ts`, `validate.ts` (output node), `metering.ts` (`PAID_TEXT_INPUTS`: `describe_prompt`, `extra_style_direction`), the script (group `restyle-lora`, answers scripted for each branch). Test: `runner-paid-restyle-lora.unit.spec.ts`.

**Fixtures (`restyle-lora`):** style strength 0, 0.5, 1 with flux strength 0 and 0.7; a trained-model sidecar and a URL LoRA; photo target; illustration target that holds on the first, the third, and never; a classifier that fails; an empty caption; seeds 0 and 0xFFFFFFFF (the mask on the NB seed); each resolution and format.

**Test:** rule 16 (every call in order equals Python's). Also: the partial charges above; a restart between `nb-1` and `classify-1` resumes without re-sending.

**Acceptance:** call sequences equal Python's for every branch; the charge is the calls made, never above the hold.

**Live check (`lora`, with R3.13):** one photo-target restyle at 1K (describe + stylize + classify + one NB: ≈ $0.002 + $0.04 + $0.002 + $0.08 = $0.124); one illustration target (up to ≈ $0.29). ≈ $0.29 budgeted.

---

### Task R3.15: Pose Mannequin and Lens · 3D Reframe (family `nano-extras`)

**Port:**

| Class | Python | Provider · model | Sent | Outputs | Pricing basis |
|---|---|---|---|---|---|
| LensReframe | `comfy_extras/nodes_lens_reframe.py:30-83` | Replicate `google/nano-banana-2` | `{prompt: reframe_instruction(source, target, strength, custom_focal) (_lenses.py:65-90), image_input: [image], resolution: "1K", output_format: "png"}` | first URL; ui `reframe` | already: `editSettings.ts:271` (`google/nano-banana-2` 1K, $0.067 verified, `editRates.ts:137-140`) |
| PoseMannequin | `comfy_extras/nodes_pose_mannequin.py:54-142` | `google/nano-banana-2` | `{prompt: pose_instruction(source, prompt, pose_prompt) (_pose_prompts.py:50-68), image_input: [character, cond or pose_image], resolution: "1K", output_format: "png"}` | first URL; ui `pose` (a call); the baked result or the character as a live preview (no call) | NB2 1K as Lens reframe for a call; nothing for the no-call branches (ruling (p)) |

- Pose Mannequin's branches (:115-140): `image` mode with both pictures → call; `prompt` mode with a non-blank `pose_prompt` → call; mannequin mode: a readable `result_image` is the result (no call); else `pose_cond_image` or `mannequin_image` with the character → call; otherwise the character passes through (no call). The baked files are loaded as Python's `_load_input_image` does (:35-45: EXIF turned, RGB), which is R1.3's `rgbTurnedPng` (`pictures/pythonView.ts:105`); the no-call branches' ui is a live preview of that picture (unique for the baked result, :130).
- Lens reframe: only an `image`-wired node is taken (Python's blank 16×16 path, :61-63, stays with the engine).
- Backup: fal `fal-ai/nano-banana-2/edit` via `nanoBananaOnFal` (`twins.ts:599`), as the nano actions have it (Replicate first, fal the backup at cost, `RUNNER_ROUTES` rows `LensReframe` and `PoseMannequin`); the price already covers it for Lens reframe (the nano-action call shape).
- Hosted: the three baked file names are the user's own (`collectInputFiles`), checked at the start of the take (`cardPictureFiles` rule).

**Files:** create `frontend/server/runner/generators/nanoExtras.ts` (`reframeInstruction`, `LENSES` (ported from `_lenses.py:9-39`), `poseInstruction`, `posePlanBranch(inputs)`); modify `executors.ts`, `eligibility.ts` (rows; `imageInputs`; the mode widget), `families.ts`, `validate.ts` (both output nodes), `inputs.ts`, `paidSettings.ts` (`paidNoCall` for Pose Mannequin; `editSettings.ts` gains `PoseMannequin: nanoAction`), `priceBook.ts` (row :352), `metering.ts` (`PAID_TEXT_INPUTS`: Pose `prompt`, `pose_prompt`), `twins.ts` (two rows), the script (group `nano-extras`). Test: `runner-paid-nano-extras.unit.spec.ts`.

**Fixtures (`nano-extras`):** every lens pair including Custom with focal 10 and 300, strength 0, 1, 1.5; every Pose branch, blank and spaced prompts and pose prompts, a baked file with EXIF orientation 6, a missing baked file.

**Test:** rule 16. Also: a baked result makes no call and no charge; the fal backup sends the same prompt and pictures.

**Acceptance:** requests equal; no-call branches free.

**Live check (`nano-extras`):** Lens reframe 50 → 85 mm on Replicate ($0.067); Pose Mannequin prompt mode ($0.067); the fal backup once with `NUXT_RUNNER_BACKUP=on` and Replicate forced off ($0.08). ≈ $0.21.

---

### Task R3.16: Turntable, front view only (family `turntable`)

**Port:** `TurntableNode`, `comfy_extras/nodes_turntable.py:23-99`, path A (:70-78): no right, back or left view wired → one call to Luma Ray 2 720p through the video table: `spec.build_input(simple_spin_instruction(direction, instructions), "1:1", 5, 0, image, None, {"loop": True})` → `_b_luma_ray_2_720p` (`video_models.py:432-443`) → Replicate `luma/ray-2-720p` `{prompt, aspect_ratio: "1:1", duration: 5, loop: true, start_image_url}`. Prompts: `_turntable_prompts.py:5-26` (`_SPIN`, `_append`). Output: a video (first URL); Python returns no ui.

- Views wired → left to the engine until R3.17.
- Price: `videoPriceUsd('luma-ray-2-720p', 5 s)` = 5 × $0.18 = $0.90 (`videoRates.ts:250-253`) → 135 credits, against the flat 75 today (`priceBook.ts:353`; ruling (b)).
- No backup (Luma Ray 2 is hidden; `RUNNER_ROUTES['video:luma-ray-2-720p']` has none).

**Files:** create `frontend/server/runner/generators/turntable.ts` (`simpleSpinInstruction`, `segmentInstruction`, `planSegments` (a port of `_turntable_plan.py:10-28`, used by R3.17)); modify `executors.ts` (reuses `planVideoGeneration`'s Luma builder), `eligibility.ts` (row: `mustNotLink: ['right_reference', 'back_reference', 'left_reference']` until R3.17), `families.ts`, `validate.ts`, `paidSettings.ts` (the path's video call), `priceBook.ts` (row :353), `metering.ts` (`PAID_TEXT_INPUTS`: `instructions`), the script (group `turntable`). Test: `runner-paid-turntable.unit.spec.ts`.

**Fixtures (`turntable`):** both directions, blank, spaced and set instructions; `plan_segments` for every subset of views and both directions (for R3.17).

**Test:** rule 16.

**Acceptance:** request equal; priced 135.

**Live check (`turntable`):** one front-only spin ($0.90).

---

### Task R3.17: Turntable with views (family `turntable`; after R5.1)

**Port:** path B (`nodes_turntable.py:80-97`): `plan_segments(extra, direction)` arcs; for each, Seedance 2.0 through the video table (`video_models.py:563-570`, `_b_seedance_2_0` :286-310): fal `bytedance/seedance-2.0`, function "firstLast" (`_fal_fn_for_input`, `nodes_replicate.py:3829-3838`), `{prompt: segment_instruction(degrees, direction, instructions), duration: "5", resolution: "720p", image_url: <start view>, end_image_url: <end view>}`; then `stitch_clips` (`_turntable_stitch.py:15-61`): every clip after the first drops its first frame; output H.264 `yuv420p`, CRF 20, preset veryfast, at the first clip's size and frame rate, frames numbered in the output's own time base.

- A `pipeline` of 2–4 calls (`seg-1` …), then the stitch on R5.1's `encodeVideo`.
- Parity: the frame count, frame rate and duration equal Python's; decoded frames within the lossy tolerance the ledger ruled (≤ 2/255 mean, ≤ 8/255 max); the concatenation order and dropped frames exact.
- Price: segments × 5 s × $0.3034 at 720p (`videoRates.ts:125-129`): 2 segments $3.03, 4 segments $6.07 (ruling (b)). Partial charges per segment (rule 12).
- No backup (Seedance 2.0 has none, `RUNNER_ROUTES['video:seedance-2.0']`).

**Files:** modify `turntable.ts` (the pipeline), `eligibility.ts` (drop the `mustNotLink`), `paidSettings.ts`; create `frontend/server/runner/turntableStitch.ts` (`stitchClips(files): Promise<Uint8Array>` on R5.1); the script (group `turntable-views`, clips decoded to frame hashes). Test: `runner-paid-turntable-views.unit.spec.ts`.

**Test:** rule 16. Also: a failure in segment 3 charges segments 1–2; the stitched clip's frame count is Σ frames − (segments − 1).

**Acceptance:** requests equal; stitch parity as above.

**Live check (`turntable`):** front + back (2 segments, $3.03).

---

### Task R3.18: Controller check, fixture-level and in the browser (not delegated)

- [ ] Real routes and engine, fake ledger, hosted mode, `NUXT_RUNNER_FAMILIES=cards,llm-text,describe,image-repair,layers,audio-gen,gen-3d,film-shot,image-extras,lora,nano-extras,turntable` (plus `sound-in` after R5.1), no provider keys, the fake providers answering from the fixtures:
  - Text → Summarize text → Generate an image's `prompt_in` → Image card;
  - Image card → Describe an image → Text card;
  - LoadImage → Separate background and foreground → Frame (both layers);
  - Image card → Upscale (Real-ESRGAN) → Remove background → Save image;
  - Generate music → Audio card;
  - Image card → Generate a 3D model → Model3D card;
  - Image card → Flux Dev + LoRAs → Image card;
  - Image card → Restyle an Image · Style LoRA (illustration branch, second attempt holds);
  - Pose Mannequin with a baked result (free).

  For each: the requests equal the fixtures, every value and file is Python's, each hold is the ceiling and each charge `priceNode`'s figure for what ran, never above the hold.
- [ ] A failure injected mid-pipeline charges the finished calls only; a restart mid-pipeline sends no call twice.
- [ ] With every R3 family off, the needs-engine list over every saved project is identical to before R3.1; every `runner-*.unit.spec.ts` green unchanged; the ComfyUI path's prices differ only where a task moved a class (listed with old and new credits).
- [ ] The live paid checks (each task's list), with the user's go, `NUXT_RUNNER_BACKUP=off` except the backup checks; the measured prices recorded with source and date; an estimate card that the bill contradicts is corrected before switch-on.
- [ ] The browser check on the shared :3002 server (the controller's), families on in the local `.env`: run a saved project with an LLM node and a 3D node with ComfyUI stopped; the Text card and the 3D viewer show the results; the badge shows the ceiling and the run's charge the calculation.
- [ ] The full unit suite (or every area R3 touched) green with the keys unset; the typecheck clean; `runner-builders.json` unchanged.

Record the results in `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md` and `docs/STATE.md`. The R3 families stay off in hosted until the user says otherwise.

### Controller rulings needed before R3 is built

- **(a) Prices for models Sailor hasn't priced yet.** Almost every R3 node is charged today from the rough "about $x" figure on its own badge (`GRAPH_NODE_CREDITS`), not from the provider's real price. The plan gives each model a proper price read from its provider's page, moves both paths (runner and ComfyUI) onto it, and keeps a family off until its live check confirms the price. *Recommend:* yes. *Cost:* some ComfyUI-path prices change (a few up, like Turntable; some down); a model whose page gives no clear price waits for a measured call.
- **(b) Turntable is priced below cost today.** The flat 75 credits assume $0.50; the front-only spin costs $0.90 (Luma Ray 2, 5 s × $0.18), and with extra views $3.03–$6.07 (Seedance 720p, 5 s per arc). *Recommend:* price it by what it sends, on both paths, now (135 credits front-only; 456–911 with views). *Cost:* the node gets much dearer with views; the alternative keeps losing money on every run.
- **(c) The hold and charge for text models priced by the word (tokens).** Sailor can't know in advance how long the model's answer will be. *Recommend:* hold for the most it could cost — the text sent counted generously (one token per byte, at most the 32,768-byte moderation limit per text in hosted) plus the node's maximum answer length — then charge what the provider reports it used, never more than the hold; if it reports nothing, charge the hold. *Cost:* the up-front hold can be 10–20× the final charge (e.g. Chat with GPT-5 at 8,192 tokens); a user near zero credits may be refused a cheap question. The alternative, a flat per-call price, overcharges short answers or loses on long ones.
- **(d) Text nodes and repeat runs.** ComfyUI reuses a node's last answer when nothing about it changed; Sailor's runner only reuses results that carry a seed, and these text nodes have none. *Recommend:* give back the last answer when the request is byte-for-byte the same (as ComfyUI does), free. *Cost:* someone who wants a fresh answer to the same question has to change something (ComfyUI users already do); the alternative charges for every repeat.
- **(e) "Describe nodes sharing a call".** The outline expected describe nodes to share one call; in Python they never do — each node makes its own call, and the only hidden describe step is inside Restyle with a style LoRA. *Recommend:* one call per node, as Python. *Cost:* none (two identical Describe nodes in one run are charged twice, as today).
- **(f) Charging for part of a node.** A node that makes several calls (Separate background and foreground, Flux Dev + LoRAs' retry, Restyle with a style LoRA, Turntable with views) may fail after some calls were made and paid for. The ComfyUI path charges such a node nothing (it only charges whole nodes that finished). *Recommend:* the runner charges the calls that finished, from the same price calculation and never above the hold — the spirit of your 09-26 "charge the nodes that finished". *Cost:* the two paths charge differently for a half-finished node; the alternative leaves Sailor paying for those calls.
- **(g) Flux Dev + LoRAs' second call.** Replicate's shared multi-LoRA model sometimes skips loading the LoRAs; Python spots this in the logs and quietly calls again (paid), and it flips the LoRA order on every other call using a counter shared across the whole Python process. *Recommend:* keep the retry, hold for two calls, charge the calls made; keep the runner's own order counter (it can't match Python's). *Cost:* the hold doubles (8 → about 16 credits); runs occasionally cost twice. The alternative drops the retry and sometimes returns a picture without the LoRA.
- **(h) The HuggingFace look-up.** For a bare "owner/model" LoRA address, Python first asks huggingface.co whether that model exists and, if so, sends it as a HuggingFace address. *Recommend:* the runner makes the same look-up through its safe fetcher (8-second limit, as Python). *Cost:* one outside request per such run; without it, those LoRAs would be read as Replicate models and fail.
- **(i) LoRA files in hosted.** Trained LoRAs live in one shared `models/loras/` folder with no owner, and a trained-model address like "finnyjules/…" runs a private model under Sailor's own Replicate account. *Recommend:* in hosted, refuse LoRAs picked by name and private trained-model addresses until LoRAs are stored per user; allow public LoRA links (HuggingFace, CivitAI, `.safetensors`). Local unchanged. *Cost:* hosted users can't use trained LoRAs yet; the alternative lets any user run anyone's LoRA and Sailor's private models on Sailor's bill.
- **(j) Cloned voices in hosted.** Generate speech lists cloned voices from one shared `models/voices/` folder. *Recommend:* hosted offers only the 17 preset voices until voices are stored per user. *Cost:* hosted users can't use a cloned voice yet.
- **(k) Where 3D files are kept.** Python hands on the provider's link, which expires within hours. *Recommend (spec ruling 1):* save Sailor's own copy in the user's output folder as a normal asset, hand on its address, cap the download at 512 MiB. *Cost:* disk space per model (typically a few to tens of MB).
- **(l) Nodes that send a sound wait for the server's video/sound tools.** Transcribe, Identify speakers, Clone a singing voice and Sync lips to audio send a re-encoded 60-second WAV, which needs ffmpeg (R5.1). *Recommend:* build them after R5.1 so the sound sent matches Python's. *Cost:* those four keep needing ComfyUI until then. The alternative sends the original sound file as it is (a different file from Python's WAV, and not cut at 60 s), refusing anything longer than 60 s. No R3 node lacks a hosted service otherwise; Turntable's stitching is the other piece waiting on R5.1.
- **(m) Real people's voices.** Clone a singing voice offers presets named Trump, Biden, Obama and Drake (and cartoon characters). *Recommend:* refuse those presets in hosted with a plain message; keep "Guitar", "Voilin" (sic) and custom models. *Cost:* fewer presets in hosted; the alternative is a legal and misuse risk on Sailor's own service.
- **(n) Film a shot's own switch.** *Recommend:* the preset path gets its own family `film-shot`, so it can be turned on separately from the shot-directed path that already runs. *Cost:* one more switch.
- **(o) Seedream layers in hosted.** Layerize an image saves each layer into the shared input folder so the Frame can open it. *Recommend:* save them in the user's own input folder and record them as the user's, so only they can open them. *Cost:* none visible; the alternative exposes layer names to other users.
- **(p) Pose Mannequin's free branches.** With a baked result, or nothing to pose with, the node makes no call, yet both paths charge a flat 10 credits (badge $0.05) — and a real call costs $0.067, so 10 is below cost. *Recommend:* charge nothing for the no-call branches and 14 credits (Nano Banana 2 at 1K) for a call, on both paths. *Cost:* a real re-pose gets dearer by 4 credits.
- **(q) The hidden "Remote" twins.** The 09-26 ruling remaps them to their visible twin. *Recommend:* R3 takes the nine whose Python is the very same call (Describe Image · Moondream, Whisper, MusicGen, MiniMax Speech, Hunyuan3D, Remove Background, Restore Photo, CodeFormer, Lipsync · sync.so) with the visible node's builder; the other seven (Flux 1.1 Pro, Ideogram V3 Turbo, Flux Kontext, Clarity Upscale, Seedance 2.0, Veo 3, Kling 2.1) are left to a later remap task. *Cost:* none beyond nine more rows.
- **(r) Web addresses typed into a node.** Describe a video and Sync lips to audio take a video address as typed; Python sends it on unchanged. *Recommend:* in hosted, refuse anything but an `https:` address or the user's own uploaded file, before the hold. *Cost:* local-only forms (data links, `/view` links of other users) are refused in hosted.
- **(s) Describe a video's price.** It's priced by how long the video is, but Sailor never sees a video given by web address. *Recommend:* in hosted, take only a video the user uploaded to Sailor (measured, then priced by its length); leave web addresses to local use. *Cost:* hosted users must upload the video first. The alternative holds a large fixed ceiling on every call.
- **(t) How a made sound is shown.** Python's Audio card shows a FLAC copy it encodes; before R5 the runner can't encode FLAC. *Recommend:* the Audio card shows the provider's own file (WAV or MP3) until R5, and a card with "export" on stays with ComfyUI. *Cost:* a different file format on the card, same sound.

### R3 size

Eighteen tasks: two of machinery (R3.1, R3.2), fifteen porting tasks (R3.3–R3.17) and the controller's check (R3.18). They cover 38 classes — the 35 visible Replicate classes not yet taken, plus Pose Mannequin, Lens · 3D Reframe and Turntable — and nine hidden twins, in twelve families (`llm-text`, `describe`, `image-repair`, `layers`, `audio-gen`, `gen-3d`, `sound-in`, `film-shot`, `image-extras`, `lora`, `nano-extras`, `turntable`). Two tasks (R3.10, R3.17) wait for R5.1. The live paid checks come to about **$7.70** in all (about **$4.50** for everything that doesn't wait on R5.1), estimated from the code's rate cards and, where none exists, the nodes' own price badges; the largest single items are Turntable with views ($3.03), 3D ($1.50) and the front-only spin ($0.90).

---

# R5 — Server video and sound tools

R5 gives Sailor's own server a way to read and write video and sound: an ffmpeg program built without any GPL parts (decision 7; ledger ruling "ffmpeg = an LGPL build with OpenH264 for H.264"). It then moves the video and sound reading and writing nodes, and the Timeline's video thumbnails and sound waveforms, off the engine. The outline's three tasks are replaced by the eight below (expanded 2026-09-28). `.superpowers/sdd/2026-09-26-engine-free-step3/r5-expansion-report.md` lists the corrections to the outline and why. In short:

- The outline's "13 codec classes" are 11 here, plus the Audio and Video cards. Timeline is the thirteenth; decision 5 makes it a browser export (R9.1). Audio waveform (`nodes_video_pro.py:632-802`) moves to R6.1: it decodes a sound, but the hard part is PIL's line and ellipse drawing and a numpy FFT, which are effect work, not codec work.
- R5.6 also covers `POST /sailor/asset_import`'s video and sound probe (`nodes_timeline.py:2077-2120`), which the outline left out. Without it, an imported clip has no length or size.
- The waveform route is at `nodes_timeline.py:2354`, not `:2332` (the header of `server/native/media.ts` is stale too).
- The server needs `ffprobe` as well as `ffmpeg`. Python reads frame counts and rates from libavformat's fields (`video_types.py:140-233`), which only ffprobe reports the same way. mediabunny keeps measuring for prices, as today.
- Python's H.264 comes from **libx264** (PyAV 17.0.0's wheel picks `libx264` for `'h264'`, measured 2026-09-28). An LGPL build can't make the same bytes, so the H.264 comparison needs its own rule (ruling (c)).
- Python decodes a sound in two different ways. A loaded sound goes through `load()`, divided by 32768. A sound a paid node downloaded goes through `_download_url_to_audio_dict`, which is scaled to its peak and leaves stereo WAV samples interleaved. The runner must know which way applies to each sound (R5.2).

**Order.** R5.1a (the program: which build, where it lives, its licence) comes first. Then R5.1b (the server's media module: run, probe, decode, encode, all proven against PyAV), then R5.2 (how videos, frame batches and sounds travel between runner nodes). After R5.2, R5.3 (sound nodes) and R5.4 (video nodes) are independent, but both edit `eligibility.ts`, `values.ts` and `executors.ts`, so the controller runs them one after the other or merges them. R5.5 (frame batches to and from files) comes after R5.4. R5.6 (thumbnails, waveforms, the asset probe) needs only R5.1b. R5.7 is the controller's check.

R3.10 and R3.17, which waited on "R5.1", can start once R5.1b has landed. R3.10's "any runner sound" part needs R5.3.

**Families** (each off by default; each needs `cards` on, `FAMILY_REQUIRES`; each also answers as off while the tools are missing or refused, R5.1a):

| Family | Task | Classes |
|---|---|---|
| `media-sound` | R5.3 | LoadAudio, RecordAudio, SaveAudio, SaveAudioMP3, PreviewAudio, and the Audio card beyond its sync-3 and audio-gen rows |
| `media-video` | R5.4, R5.5 | LoadVideo, GetVideoComponents, CreateVideo, SaveVideo, LoadVideoFrames, SaveVideoFrames, and the Video card's export and made videos |
| (no family; on when the tools are ready) | R5.6 | `/sailor/input_thumbnail` and `/sailor/asset_thumbnails` for videos, `/sailor/asset_waveform`, `/sailor/asset_import`'s probe. See ruling (l). |

**What R3.10 and R3.17 need from R5** (both are expanded in R3 and wait on R5.1):

| R3 task | Needs | Provided by |
|---|---|---|
| R3.10 `soundWav.ts` `pythonWav(file)` | The float32 samples Python's AUDIO holds for the source sound, bit for bit. That is `load()` (`nodes_audio.py:376-400`) for an Audio card's file, LoadAudio and RecordAudio. It is `_download_url_to_audio_dict` (`nodes_replicate.py:425-465`) for a sound a paid node made (Generate music, Generate speech, Clone a singing voice). R3.10 names only `load`: that is correct for its first source (the Audio card), and wrong for sounds made in the run. | R5.1b `decodeAudio(path, { decoder: 'load' \| 'download' })`; R5.2 `soundNoteOf` / `readSound` pick the decoder for a wired sound |
| R3.10 `nodeMedia.ts` `'sound-in'` | A sound's length before the hold. Python cuts at `int(60 · rate)` samples, so the price reads `min(60, samples / rate)`. | R5.1b `probeMedia` (stream duration, rate); mediabunny's measure stays for the price as today |
| R3.10 later sources | Any runner sound (LoadAudio, an Audio card with `source`, Get video components' sound) | R5.2 (the sound value and its note), R5.3 (the classes) |
| R3.17 `turntableStitch.ts` `stitchClips(files)` | `_turntable_stitch.py:15-61`: decode each clip's frames as YUV; drop the first frame of every clip after the first; scale to the first clip's size with swscale bilinear only if the size differs; H.264 `yuv420p` at the first clip's `average_rate` (a fraction), frames numbered 0, 1, 2… in 1/fps; the libx264 settings `crf 20`, `preset veryfast`; no sound. | R5.1b `encodeVideo({ input: { kind: 'clips', paths, dropFirstAfterFirst: true }, fps, size, quality: { crf: 20, preset: 'veryfast' } })`, and `probeMedia` for the first clip's rate and size |
| R3.17 parity | Frame count Σ − (k − 1), the rate and the duration exact; decoded frames within the H.264 rule | R5 rule 3 and ruling (c) (the ledger's "≤ 2/255 mean, ≤ 8/255 max" can't hold between two different H.264 encoders) |

## Rules every media task follows (binding for R5.1b–R5.6)

1. **One way to the tools.** Every probe, decode and encode goes through `frontend/server/media/` (R5.1b). No other file starts ffmpeg or ffprobe. PyAV is never called from the server. mediabunny keeps only its existing job: measuring lengths for prices (`server/utils/graphInputSeconds.ts`).
   - When `mediaTools()` (R5.1a) is null, the media families answer as off: eligibility leaves the class to the engine, and `nodesNeedingEngine` names it.
   - If the tools disappear during a run, a node fails with `MEDIA_TOOLS_MISSING` = "This needs the video tools, which aren’t installed on this server".
   - Nothing crashes.
2. **Values between runner nodes (R5.2).**
   - A video file (LoadVideo, the Video card, a paid video) stays a `files` value, as today. Python's `VideoFromFile` is the file itself.
   - A video a node assembles (CreateVideo) is a new `video` value: its frames, its sound and its rate, kept losslessly and encoded only when saved or shown (Python's `VideoFromComponents`).
   - An IMAGE batch from a video is a new `frames` value: one kept FFV1 file of exact 8-bit RGB frames.
   - A sound is a `files` value with a `sound` note that says how Python decodes it (`'load'`, `'download'`, or `'exact'` for a float WAV the runner wrote itself).
3. **Parity**, always against fixtures from the real PyAV:
   - **Probe numbers:** frame count, frame rate (as a fraction), durations, width, height, sample rate and channel count. Each must equal what the named Python function returns for the same file (`video_types.py:94-233`, `nodes_timeline.py:2077-2120`).
   - **Decoded pictures:** byte-equal to PyAV's `frame.to_ndarray(format='rgb24')`. The build is FFmpeg 8.0.3, the same 8.0 branch as PyAV 17.0.0's own libraries (libavcodec 62.11.100, libswscale 9.1.100). The swscale settings are PyAV's defaults (`av/video/reformatter.py`: `SWS_BILINEAR`, the frame's own colour space, colour range *unspecified*). A fixture case that can't be made byte-equal is named in the task's report; the controller rules on it case by case.
   - **Decoded samples:** bit-equal float32 to Python's (`load`, `download`, or `get_components`' `fltp`).
   - **Lossless outputs** (FLAC, WAV, FFV1): decoded, equal to Python's decoded output exactly.
   - **MP3 and AAC:** the build uses the same LAME (3.100) and FFmpeg's own AAC encoder from the same branch. So the decoded samples are expected to equal Python's decoded samples exactly. Where they don't, the audio tolerance of ruling (c) applies, and the report says which case.
   - **H.264:** OpenH264 here, libx264 in Python. Frame count, rate, duration and size must be exact. The decoded frames are judged by ruling (c). They must also equal, after decoding, a Python run of the same pipeline with PyAV switched to `libopenh264` (its wheel includes it, and the fixture script records that run too). That run proves the runner feeds the encoder the same frames with the same settings.
   - **Around the files:** names, subfolders, counters and ui equal Python's. Metadata tags (`prompt`, workflow) are JSON-value-equal.
4. **Fixtures.** `scripts/runner_media_fixtures.py --group <g>` writes `frontend/tests/unit/fixtures/runner-media-<g>.json`. The clips themselves go in `frontend/tests/unit/fixtures/media/`, made by the script with PyAV: synthetic frames from R2.1's `synth`, and tones from a fixed formula.
   - The script blocks the network before any node module is imported. It records `av.__version__`, `av.library_versions` and the platform.
   - Encoders run with `threads=1` so the clips come out byte-identical. Running the script twice gives identical bytes, and the other groups' files are untouched.
   - All clips together stay under 3 MB.
   - **The standard clips:**
     - H.264 `yuv420p` untagged (read as BT.601), BT.709-tagged, and `yuvj420p` full range;
     - HEVC 10-bit;
     - VP9 in WebM at an odd size (63×47);
     - ProRes in MOV;
     - an MP4 with an edit list (leading B-frames with negative time stamps);
     - a variable-frame-rate MP4;
     - a video with no sound, one with stereo AAC, and one with two sound streams (Python takes the last);
     - mono MP3; stereo WAV at s16, s24 and s32; FLAC at 16 and 24 bits; Ogg Vorbis;
     - Opus in WebM, which is what a browser recording makes;
     - M4A AAC with encoder delay;
     - a 75-second 8 kHz mono WAV;
     - a WAV with samples at −32768.
5. **Child processes, time and Stop.** `runMedia` (R5.1b) is the only thing that starts a tool.
   - It spawns with an argument list, never a shell, with `-nostdin -hide_banner -loglevel error`.
   - Each job has a time limit: `MEDIA_JOB_TIMEOUT_MS` (10 minutes hosted, 30 local; 30 s for the thumbnail and waveform routes).
   - Stop (the run's `AbortSignal`) kills the process (SIGKILL) within one second and removes its partial output.
   - stderr is capped at 64 KiB, logged, and never shown to a person. A failure is mapped to plain words.
   - Jobs wait in order behind a limiter: `MEDIA_JOBS_PER_USER` (1 hosted, 2 local) and `MEDIA_JOBS_MAX` = max(1, ⌊cpus / 2⌋). The routes have their own two slots, so a long render never blocks a thumbnail.
   - Hosted runs pass `-threads 2` and `-filter_threads 1`.
6. **Hosted safety.**
   - **Owned files only.** Every widget that names a file is listed by `collectInputFiles` (`server/runner/inputs.ts:75`): LoadVideo, LoadAudio, RecordAudio, LoadVideoFrames' `file`, SaveVideoFrames' `audio_file`, and the cards. Value files are the run's own.
   - **Size, length and dimensions are checked before any decode.** The order is `stat`, then a header probe capped at `-probesize 5000000 -analyzeduration 5000000` with a 10 s limit. The caps are in `frontend/shared/runner/media.ts` (ruling (f)). A file whose length can't be read is refused in hosted.
   - **No network.** The build has no network protocols (`--disable-network`, protocols `file,pipe` only). At run time, every input is passed as `file:<absolute path>` after `-protocol_whitelist file,pipe`, with the demuxer named explicitly (`-f`) from the file's first bytes (`mediaFormat`, `server/runner/mediaInputs.ts`, extended with Matroska and AVI). The demuxers that open other files or addresses (`hls`, `dash`, `concat`, `image2`, `tee` and the rest) are not built. A playlist uploaded as a "video" therefore can't make ffmpeg read other files.
   - Every job runs with `-max_alloc 536870912`.
   - A decode that goes past its frame or sample cap fails plainly as it streams, and never grows memory past one frame or one block.
   - Outputs are written into a temporary folder of the run's own, then moved into the store.
7. **Files out.**
   - Saved files use Python's names and counters (`folder_paths.py:428-473`, R1.5's `saveImagePrefix`), in the user's subfolder in hosted, and are recorded with `metering.addOutput`.
   - Previews go to temp under Python's names.
   - Kept files use `KeptBytes.putPath` (R5.2), by sha256, and are never assets.
   - A saved file is written from a path, never read whole into memory.
8. **Families off, and cards-off parity.** Two things must hold with both media families off, and also with them on but the tools missing:
   - `runnerTakesNode`, `nodesNeedingEngine`, `outputKindsFor`, `PICTURE_OUTPUTS` and `valueWiresAllowed` answer exactly as before R5.2 over every saved project graph (`user/sailor/projects/*`);
   - every existing `runner-*.unit.spec.ts` stays green, unchanged.

   With `cards` off, `parseFamilies` drops both media families.
9. **Free.** Media work has no price, no hold and no charge. Savers and every node that decodes or encodes are `local: 'render'`, so they count as work. LoadVideo, LoadAudio and a card that only hands a file on are `local: 'source'`.
10. **Tests.**
    - Tests go in `frontend/tests/unit/runner-media-<g>.unit.spec.ts`, with shared helpers in `tests/unit/__runner__/mediaParity.ts`.
    - A spec that needs the real tools calls `requireMediaTools()`, which **fails** with "The video tools aren’t built on this machine: run scripts/media-tools/build.sh" when they are missing. It never skips: a skipped parity test reads as a pass.
    - Machinery tests use a fake tools folder and need nothing.
11. **Every task's run line:**
    - Run `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_media_fixtures.py --group <g>` twice. The second time, `git diff --stat` must show the group's files unchanged.
    - Then run `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-media-<g>.unit.spec.ts tests/unit/runner-`.
    - Run the typecheck from the Global Constraints, with `server/media` added to its grep.
    - Report (no commit).

---

### Task R5.1a: The video tools — which build, where it lives, and its licence

No family. This task writes the build and the finder. **The build itself is the controller's step**: it downloads about 25 MB of pinned sources and compiles for about 10 minutes, so it needs the user's go. Implementers don't download.

**The build (ledger ruling: LGPL, OpenH264 for H.264).** It is built from source everywhere, by one script, with the same versions and switches on the Mac and in the Fly image:

| Part | Version | Licence | Why this one |
|---|---|---|---|
| FFmpeg | **8.0.3** (released 2026-06-18, 8.0 branch) | LGPL 2.1 or later (no `--enable-gpl`, no `--enable-version3`, no `--enable-nonfree`) | Same branch as PyAV 17.0.0's own FFmpeg (8.0.1), so the decoders and swscale are Python's. Later branches (8.1.3, 9.0.2) move swscale. |
| OpenH264 | **2.5.1** (built from Cisco's source on GitHub) | BSD 2-clause | H.264 without GPL. It is the same ABI generation (`.so.7`) as the `libopenh264.7` inside PyAV's wheel, so the fixture script can make the "Python with OpenH264" comparison of rule 3. |
| LAME | **3.100** | LGPL 2 | MP3, the same version PyAV bundles (`libmp3lame.0`) |
| Opus | **1.5.2** | BSD 3-clause | The Audio card's Opus export |
| dav1d | **1.5.1** | BSD 2-clause | AV1 decoding, as PyAV's wheel does |

- **Nothing else is linked.** `--disable-autodetect` keeps configure from picking up libraries on the build machine, such as a Homebrew x264.
- **Switches** (the exact line lives in `scripts/media-tools/configure.args`, one per line, so a test can read it):
  - `--disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-devices --disable-hwaccels`
  - `--disable-network --disable-protocols --enable-protocol=file,pipe`
  - `--disable-demuxers --enable-demuxer=mov,matroska,wav,mp3,ogg,flac,aac,avi`
  - `--disable-muxers --enable-muxer=mp4,mov,matroska,wav,flac,mp3,ogg,opus,rawvideo,f32le,null`
  - `--disable-encoders --enable-encoder=libopenh264,aac,libmp3lame,flac,libopus,ffv1,pcm_f32le,pcm_s16le,rawvideo`
  - `--enable-libopenh264 --enable-libmp3lame --enable-libopus --enable-libdav1d`
  - `--enable-static --disable-shared --extra-version=sailor1`
  - The implementer adds only the decoders, parsers, filters and bitstream filters the tasks prove they need. All native FFmpeg decoders stay on (they are LGPL). The list and each addition are reported.
- **Reproducible.**
  - `scripts/media-tools/versions.env` pins, for every part, its version, source URL and sha256 (the implementer fills each sha256 from the upstream tarball and says where they read it). For FFmpeg it also pins the signing key's fingerprint.
  - The script refuses a tarball whose sha256 differs. When `gpg` is present, it checks FFmpeg's `.asc` signature.
  - It sets `SOURCE_DATE_EPOCH` and builds in a fixed order.
  - The Docker stage builds on `python:3.12-slim` pinned by digest, the runtime's own base, so glibc matches.
  - The same sources and switches give the same program. The binary's bytes are not promised identical across compilers. `manifest.json` records its sha256 per build.
- **Where it lives.**
  - Local: `frontend/.media-tools/<platform>-<arch>/`, which is ignored by git. `bin/ffmpeg`, `bin/ffprobe`, `licenses/`, `manifest.json`.
  - Fly: `/opt/media-tools/`, the same layout, copied from a build stage, with `ENV NUXT_MEDIA_TOOLS_DIR=/opt/media-tools/bin`.
  - The Mac build needs Xcode's command-line tools, `pkg-config`, `meson` and `ninja`. The script checks for them and says which is missing.
- **The licence honoured.**
  - `licenses/` holds FFmpeg's `COPYING.LGPLv2.1` and `LICENSE.md`, and the licence files of OpenH264, LAME, Opus and dav1d, copied from their own tarballs.
  - It also holds `SOURCES.md`, which lists each exact source (URL and sha256), and the configure line.
  - FFmpeg's legal checklist is followed: LGPL switches only, FFmpeg itself unmodified, a separate program called by its path (Sailor doesn't link it), and its notices kept beside it.
  - OpenH264 built from source is covered by its BSD licence. Cisco's patent grant covers only Cisco's own binaries downloaded by an end user; see ruling (b).
  - Distributing the image to anyone would add the source tarballs themselves (ruling (n)).

**Files:**
- Create `scripts/media-tools/build.sh`, `scripts/media-tools/versions.env`, `scripts/media-tools/configure.args`, `scripts/media-tools/README.md` (how to build locally, where the output goes, how to bump a version).
- Create `frontend/server/media/tools.ts`.
- Modify `Dockerfile`:
  - a new stage `media-tools` before `runtime`, running `scripts/media-tools/build.sh /opt/media-tools`;
  - in `runtime`, `COPY --from=media-tools /opt/media-tools /opt/media-tools` and the `ENV`.
- Modify `.gitignore` (`frontend/.media-tools/`) and `.dockerignore` (`frontend/.media-tools`).
- Create `docs/deploy/media-tools.md` for deploy notes: the size added to the image as measured, how to bump a version, how to check the licence folder on a running machine.
- Test: `frontend/tests/unit/media-tools.unit.spec.ts`.

**Interfaces (`server/media/tools.ts`):**
```ts
export interface MediaTools {
  ffmpeg: string; ffprobe: string
  /** `ffmpeg -version`'s first line, e.g. 'ffmpeg version 8.0.3-sailor1'. */
  version: string
  /** `ffmpeg -buildconf`, one switch per entry. */
  buildconf: readonly string[]
  encoders: ReadonlySet<string>
  protocols: { input: readonly string[]; output: readonly string[] }
}
export const MEDIA_TOOLS_VERSION = '8.0.3'
export const MEDIA_TOOLS_MISSING = 'This needs the video tools, which aren’t installed on this server'
/** Switches whose presence refuses a build (the ledger's no-GPL ruling). */
export const FORBIDDEN_BUILDCONF: readonly string[] // '--enable-gpl', '--enable-nonfree', '--enable-version3', '--enable-libx264', '--enable-libx265'
export const REQUIRED_ENCODERS: readonly string[]   // libopenh264, aac, libmp3lame, flac, libopus, ffv1, pcm_f32le, pcm_s16le, rawvideo
/** NUXT_MEDIA_TOOLS_DIR, else frontend/.media-tools/<platform>-<arch>/bin when it exists, else null. Never PATH. */
export function mediaToolsDir(): string | null
/** The tools, checked once and remembered (null when missing or refused; a `media.tools.refused` log line says why). */
export function mediaTools(): Promise<MediaTools | null>
/** The remembered answer, for eligibility (false until the first check has finished; the server warms it at start). */
export function mediaToolsReady(): boolean
/** Tests only. */
export function resetMediaTools(): void
```
- `NUXT_MEDIA_TOOLS=off` makes `mediaTools()` null.
- A tool that answers slower than 5 s, a version that isn't 8.0.3, a forbidden switch, a missing encoder, or any input protocol other than `file` and `pipe` makes it null.
- `server/runner/index.ts` (or the plugin that builds the runner) calls `mediaTools()` at start, so `mediaToolsReady()` is right before the first run.

**Tests:**
- Take a fake tools folder of small shell scripts that print canned `-version`, `-buildconf`, `-encoders` and `-protocols` answers:
  - a good build is ready;
  - `--enable-gpl`, `--enable-libx264` or `--enable-nonfree` in its build line refuses it;
  - a missing `libopenh264` refuses it;
  - an `http` protocol refuses it;
  - a wrong version refuses it;
  - a script that hangs refuses it after 5 s;
  - an `ffmpeg` put on PATH is never used;
  - `NUXT_MEDIA_TOOLS_DIR` wins;
  - `off` wins over everything.
- `versions.env` is well formed: every part has a version, an https URL and a 64-hex sha256.
- `configure.args` holds `--disable-network` and none of `FORBIDDEN_BUILDCONF`.
- The Dockerfile has the `media-tools` stage, the `COPY` and the `ENV`.

**Acceptance (the controller's build step):**
- `scripts/media-tools/build.sh` builds on this Mac (arm64) and in `docker build --target media-tools`.
- `ffmpeg -version` says 8.0.3, and `-buildconf` has no GPL switch.
- `ffmpeg -protocols` lists only `file` and `pipe`.
- `mediaTools()` is ready with the real build.
- The image grows by the measured amount, reported; expected under 80 MB.
- The licence folder is present in both places.

---

### Task R5.1b: The media module — run, probe, decode, encode

No family: a library the node tasks call, proven against PyAV one piece at a time before any node uses it.

**Files:**
- Create `frontend/server/media/run.ts`, `probe.ts`, `decode.ts`, `encode.ts`, `h264Quality.ts`, and `frontend/shared/runner/media.ts`.
- Modify `frontend/server/runner/mediaInputs.ts`: `mediaFormat` also tells Matroska (non-WebM) and AVI (RIFF…AVI); `MediaFormat` gains `'mkv' | 'avi'`.
- Create `scripts/runner_media_fixtures.py` (the shared helpers, the standard clips, groups `probe`, `decode`, `encode`).
- Create `frontend/tests/unit/__runner__/mediaParity.ts`.
- Tests: `runner-media-probe.unit.spec.ts`, `runner-media-decode.unit.spec.ts`, `runner-media-encode.unit.spec.ts`, `runner-media-run.unit.spec.ts`.

**Port:**

| Piece | Python | The runner |
|---|---|---|
| Duration | `VideoFromFile._get_raw_duration`, `video_types.py:110-138`: `container.duration / AV_TIME_BASE`; else `frames / average_rate`; else count the packets | `pyRawDuration(p)` from the probe; the packet count by `ffprobe -count_packets` only when both are missing |
| Frame count | `get_frame_count`, `:140-210`: the stream's `frames` when > 0; else `round(duration · average_rate)`; else decode and count | `pyFrameCount(p, path)` |
| Frame rate | `get_frame_rate`, `:212-233`: `average_rate`, else `frames / duration` (`limit_denominator()`), else 1 | `pyFrameRate(p): { num, den }` (exact fraction; `limit_denominator` ported with BigInt) |
| Dimensions | `get_dimensions`, `:78-92`: first video stream | `probe.video[0]` |
| Pictures | `get_components_internal`, `:247-267`: every decoded frame of the first video stream whose `pts ≥ 0` (start 0), `to_ndarray('rgb24')` | `decodeFrames` |
| Sound in a video | `:272-307`: the **last** sound stream, `AudioResampler(format='fltp')`, samples before t = 0 skipped (`to_skip = max(0, int((0 − pts·tb) · rate))`), float32 | `decodeAudio(path, { decoder: 'fltp', stream: 'last' })` |
| A loaded sound | `load`, `nodes_audio.py:376-400`, with `f32_pcm` `:366-374`: the first sound stream, the codec's own sample format; packed → `view(-1, C).t()`; int16 / 32768, int32 / 2³¹, float as is | `decodeAudio(path, { decoder: 'load' })` |
| A downloaded sound | `_download_url_to_audio_dict`, `nodes_replicate.py:425-465`: the first stream, `to_ndarray()` **not** de-interleaved (a packed stereo file stays one row, interleaved), `astype(float32)`, divided by the peak when the peak > 1.5 | `decodeAudio(path, { decoder: 'download' })`, quirk kept, ruling (k) |
| H.264 out | `VideoFromComponents.save_to`, `video_types.py:409-470` (`(x·255).clamp(0,255).byte()`, rgb24 → `reformat('yuv420p')`, `add_stream('h264', rate=Fraction(round(fps·1000), 1000))`, libx264 defaults, AAC in one frame with layout by channel count); `SaveVideoFramesNode`, `nodes_video_effects.py:676-714`; `stitch_clips`, `_turntable_stitch.py:15-61` | `encodeVideo` |
| Sound out | `AudioSaveHelper.save_audio`, `comfy_api/latest/_ui.py:265-370` | `encodeAudio` |

**Interfaces:**
```ts
// shared/runner/media.ts: caps and words (numbers per ruling (f))
export const MEDIA_CAPS: { local: MediaCaps; hosted: MediaCaps }
export interface MediaCaps {
  videoBytes: number; soundBytes: number
  videoSeconds: number; soundSeconds: number
  framePixels: number          // one frame, w·h
  batchFrames: number; batchPixels: number   // a frame batch: count, and count·w·h
  soundSamples: number         // channels·samples decoded at once
  keptBytesPerRun: number
}
export const MEDIA_WORDS: Record<'tooBig' | 'tooLong' | 'tooManyFrames' | 'unreadable' | 'noVideo' | 'noSound' | 'oddSize' | 'stopped' | 'timedOut' | 'failed' | 'sizeChanged', string>

// run.ts
export interface MediaJob {
  tool: 'ffmpeg' | 'ffprobe'; args: string[]
  userId: string | null; route?: boolean       // route: the thumbnail and waveform slots
  signal?: AbortSignal; timeoutMs?: number
  stdin?: AsyncIterable<Uint8Array>             // piped frames or samples
  onStdout?(chunk: Uint8Array): Promise<void> | void  // back-pressure: the process is paused while this runs
  cleanup?: string[]                            // paths removed when the job fails or is stopped
}
export function runMedia(job: MediaJob): Promise<{ stdout: Uint8Array | null; stderrTail: string }>
/** ['-protocol_whitelist', 'file,pipe', '-f', <demuxer for fmt>, '-i', 'file:' + absolute path]; throws for a relative path or an unknown format. */
export function inputArgs(path: string, fmt: MediaFormat): string[]
export function mediaLimiter(): { pending(userId: string | null): number } // for tests

// probe.ts
export interface Rational { num: number; den: number }
export interface VideoStreamProbe {
  index: number; w: number; h: number; codec: string; pixFmt: string
  averageRate: Rational | null; frames: number | null
  duration: number | null; timeBase: Rational          // stream duration in its time base
  colorRange: string | null; colorSpace: string | null
}
export interface SoundStreamProbe {
  index: number; rate: number; channels: number; layout: string | null; codec: string; sampleFmt: string
  duration: number | null; timeBase: Rational
}
export interface MediaProbe {
  format: MediaFormat; formatName: string       // libavformat's own, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'
  containerDuration: number | null              // AV_TIME_BASE units, as PyAV's container.duration
  video: VideoStreamProbe[]; sound: SoundStreamProbe[]
  bytes: number
}
export function probeMedia(path: string, o: { userId: string | null; signal?: AbortSignal; route?: boolean }): Promise<MediaProbe>
export function pyRawDuration(p: MediaProbe): number | null
export function pyFrameCount(p: MediaProbe, path: string, o: { userId: string | null; signal?: AbortSignal }): Promise<number>
export function pyFrameRate(p: MediaProbe): Rational
export function checkMediaCaps(p: MediaProbe, kind: 'video' | 'sound', hosted: boolean): string | null  // a MEDIA_WORDS entry, or null

// decode.ts
export function decodeFrames(path: string, o: {
  userId: string | null; signal?: AbortSignal
  maxFrames: number                              // past it: MEDIA_WORDS.tooManyFrames
  onFrame(rgb: Uint8Array, index: number, pts: number): Promise<void>
}): Promise<{ count: number; w: number; h: number }>
export type SoundDecoder = 'load' | 'download' | 'fltp'
export interface DecodedSound { rate: number; channels: Float32Array[] }   // [C][N]; 'download' of a packed file: one row, interleaved
export function decodeAudio(path: string, o: {
  decoder: SoundDecoder; stream?: 'first' | 'last'
  userId: string | null; signal?: AbortSignal; maxSamples: number
}): Promise<DecodedSound>

// encode.ts
export interface H264Quality { crf: number; preset: 'veryfast' | 'fast' | 'medium' | 'slow' }
export const PYAV_H264_DEFAULT: H264Quality      // { crf: 23, preset: 'medium' }: libx264 with no options
export type VideoSource =
  | { kind: 'rgb'; w: number; h: number; frames: AsyncIterable<Uint8Array> }          // rgb24, already 8-bit
  | { kind: 'ffv1'; path: string; w: number; h: number }                             // a kept frame batch
  | { kind: 'clips'; paths: string[]; dropFirstAfterFirst: true }                     // Turntable
export type SoundSource = { sound: DecodedSound } | { path: string; stream: 'first'; cutSeconds?: number }
export function encodeVideo(o: {
  input: VideoSource; out: string
  fps: Rational                                  // the stream rate as Python sets it
  size?: { w: number; h: number }                // clips: the first clip's; else the input's
  quality: H264Quality
  sound?: { source: SoundSource; layout: 'mono' | 'stereo' | '5.1'; rate: number; cutSamples?: number } | null
  metadata?: Record<string, string>              // written with -movflags use_metadata_tags
  userId: string | null; signal?: AbortSignal
}): Promise<{ frames: number }>
export function encodeAudio(o: {
  sound: DecodedSound; format: 'flac' | 'mp3' | 'opus'
  quality: 'V0' | '64k' | '96k' | '128k' | '192k' | '320k'
  sampleFmt: string                              // the encoder input format PyAV picks, from the fixtures
  out: string; metadata?: Record<string, string>
  userId: string | null; signal?: AbortSignal
}): Promise<void>
/** WAV, IEEE float32, interleaved: the runner's exact sound (no tools needed). */
export function floatWav(s: DecodedSound): Uint8Array
/** An FFV1 Matroska of rgb24 frames (stored as bgr0, lossless). */
export function writeFfv1(o: { frames: AsyncIterable<Uint8Array>; w: number; h: number; out: string; userId: string | null; signal?: AbortSignal }): Promise<{ count: number }>

// h264Quality.ts
/** OpenH264 settings for Python's libx264 settings, measured (ruling (d)). */
export const OPENH264_FOR: Readonly<Record<string, readonly string[]>>  // key `${crf}`; the preset is not used
export function h264Args(q: H264Quality): string[]  // ['-c:v', 'libopenh264', ...OPENH264_FOR[crf], '-pix_fmt', 'yuv420p']
```

**Behaviour:**
- **The probe** is `ffprobe -of json -show_format -show_streams`, read into the fields PyAV reads:
  - `avg_frame_rate` for `average_rate`, where `0/0` is null;
  - `nb_frames` for `frames`;
  - `duration_ts` with `time_base`;
  - `format.duration` × 1e6 for `container.duration`.

  The probe is under the route or job limits of rule 5 and the probe caps of rule 6.
- **Pictures:**
  - ffmpeg runs `-map 0:v:0 -fps_mode passthrough -vf scale=flags=bilinear:<source colour matrix and range as PyAV passes them>,format=rgb24 -f rawvideo pipe:1`, read one frame (w·h·3 bytes) at a time.
  - Frames whose pts < 0 are dropped, as Python's `pts < start_pts` does.
  - A frame whose size differs from the first fails with `MEDIA_WORDS.sizeChanged`. Python's `torch.stack` fails there too.
  - The implementer finds the exact scale options that make every standard clip byte-equal to PyAV. PyAV sets the source range to *unspecified* (read as limited), so a full-range clip reads washed out in Python; that is kept, ruling (t). The final options are written down in the report.
- **Sound:** `-map 0:a:<first|last> -f f32le -c:a pcm_f32le`, then de-interleaved. `load` needs the codec's native sample format first (from the probe), for its integer scale:
  - `s16`/`s16p` go out as `pcm_s16le`, divided by 32768;
  - `s32` goes out as `pcm_s32le`, divided by 2³¹, rounded to float32 once;
  - float and double formats go out as `pcm_f32le`. A `dbl` source rounds to float32; Python keeps float64 there, which is noted as a deviation.

  The `fltp` decoder applies Python's skip rule, using the first packet's pts (`ffprobe -show_packets -read_intervals %+#1`).
- **H.264:**
  - Frames arrive as rgb24 and are converted to `yuv420p` by the scale filter with `flags=bilinear` (PyAV's `reformat` default) and colour space and range unspecified. This is proven against Python's own `reformat('yuv420p')` planes.
  - `-r <num>/<den>`, `-fps_mode passthrough`, frame i stamped i/fps.
  - The encoder arguments come from `h264Args(quality)`, and the output is `-movflags +faststart+use_metadata_tags`.
  - An odd width or height fails with `MEDIA_WORDS.oddSize` before any work: libx264 `yuv420p` refuses it in Python.
  - `clips` builds one filter graph: `[i:v]trim=start_frame=1` for every clip after the first; `scale=W:H:flags=bilinear` only for a clip whose size differs; `concat=n=k:v=1:a=0`; then `setpts=N/(FR*TB)` at the first clip's rate.
- **Sound out:**
  - FLAC, MP3 and Opus as `save_audio` does. Every setting is given explicitly, never left to ffmpeg's negotiation: the input format `-f f32le` interleaved, the layout (`mono` for 1 channel, `stereo` otherwise, as Python), `-sample_fmt` as PyAV picked it (`flac` → `s16`, `libmp3lame` → `s32p`, `libopus` → `flt`; each confirmed by the fixture script, which records `stream.codec_context.format.name`), the MP3 quality (`V0` → `-q:a 0`; `128k`/`320k` → `-b:a`) and the Opus bit rate.
  - More than 2 channels fails plainly, as PyAV does with a stereo layout of 6 rows.
- **`OPENH264_FOR`** is measured by the implementer. For each CRF 10–32, and the default 23, it is the OpenH264 setting (a constant quantiser pair `-qmin/-qmax`, or `-rc_mode quality` with a bit rate) whose decoded result is **no further from the source** than libx264 at that CRF (PSNR over the standard clips, within 0.5 dB). The file size ratio is reported. `preset` changes only libx264's speed, not what the picture should look like, so it is ignored.

**Fixtures (`probe`, `decode`, `encode`):**
- **`probe`:** over every standard clip, each Python function above.
- **`decode`:**
  - over every clip: the rgb24 frames (sha256 per frame, base64 for clips ≤ 64×48), `load`, `download` and `get_components`' sound (float32 base64, or sha256 over 64 KiB);
  - Python's own `reformat('yuv420p')` planes of three rgb24 inputs.
- **`encode`:**
  - `VideoFromComponents.save_to` of `synth` frames at 24, 29.97 and 30 fps, with and without a mono or stereo sound, recorded as the output's probe, its decoded frames and its decoded sound;
  - the same with PyAV's codec switched to `libopenh264`, at every row of `OPENH264_FOR`;
  - `save_audio` for FLAC, for MP3 at `V0`/`128k`/`320k` and for Opus at `128k`, from mono and stereo float input (decoded samples, the encoder's sample format, and the file's tags);
  - `stitch_clips` of three synthetic clips (one at a different size).

**Tests (each a separate `it`):**
- **Parity:**
  - the probe helpers equal Python on every clip;
  - `decodeFrames` is byte-equal to PyAV on every clip; the edit-list clip drops the negative-pts frames;
  - each `decodeAudio` decoder is bit-equal to Python;
  - the RGB → YUV planes equal Python's;
  - `encodeVideo` equals the OpenH264 Python run after decoding, and meets ruling (c) against the libx264 run;
  - FLAC decodes equal; MP3 and AAC decode equal (or within ruling (c)'s audio rule, named case by case);
  - a stitch of three clips has Σ − 2 frames, the first clip's rate and size, and the frames in order.
- **Safety:**
  - a path that is relative or has a `:` scheme is refused before any process starts;
  - an M3U8 playlist renamed `.mp4` is refused by `mediaFormat`, and ffmpeg is never started for it;
  - `-protocols` of the real build lists only `file` and `pipe`.
- **Process:**
  - Stop kills a 10-second decode within 1 s and leaves no partial file;
  - a timeout does the same with `MEDIA_WORDS.timedOut`;
  - two jobs of one hosted user run one after the other, while two users run side by side;
  - a thumbnail job isn't held up behind a long job;
  - stderr never reaches the error message.
- **Caps:** a 4097×4097 video in hosted, a video over the length cap and a sound over the sample cap are each refused from the probe alone (a spy shows no decode).

**Acceptance:** every parity test passes on this Mac with the real build; `OPENH264_FOR` is filled in and measured; the report lists the scale options used and any fixture case that isn't exact.

---

### Task R5.2: Video, frame batches and sound between runner nodes

No family: engine machinery, proven with stand-in classes (the `vi.mock` pattern of `runner-value-results.unit.spec.ts`).

**Files:**
- Modify `frontend/shared/runner/values.ts`: `ValueKind` gains `'frames' | 'video'`; `VALUE_KINDS_ALL` gains both, so a Gate hands them on (spec ruling 2: a Gate stopped on one shows nothing to pick).
- Modify `frontend/server/runner/types.ts`: `RunnerValue`, `SoundNote`.
- Modify `frontend/server/runner/values.ts`:
  - `filesOf` covers the new kinds;
  - `withWiredValues` leaves `frames` and `video` wires alone, as it leaves `files` and `mask`. Today it would throw `WIRED_VALUE_MISSING` for them.
- Modify `frontend/server/runner/keptBytes.ts`: `KeptExt` gains `'mkv' | 'wav'`, plus `putPath`, `pathOf` and `workDir`.
- Modify `frontend/server/runner/results.ts`: `ResultStore.pathOf`, `ResultStore.saveFromPath`.
- Modify `frontend/server/runner/fileAccess.ts`: `pathOf`.
- Modify `frontend/server/runner/engine.ts`: a run's kept-bytes total is capped at `MEDIA_CAPS.keptBytesPerRun`, and the kept folder is swept as today.
- Create `frontend/server/media/values.ts`.
- Test: `frontend/tests/unit/runner-media-values.unit.spec.ts`.

**Interfaces:**
```ts
// types.ts
export interface SoundNote {
  /** How Python turns this file into its AUDIO: 'load' (nodes_audio.py load()), 'download' (nodes_replicate.py _download_url_to_audio_dict), 'exact' (a float WAV the runner wrote: the samples as they are). */
  decode: 'load' | 'download' | 'exact'
}
export type RunnerValue =
  | { kind: 'files'; files: OutputFile[]; list?: true; tensors?: OutputFile[]; sound?: SoundNote }
  // …the R0–R3 kinds unchanged…
  /** An IMAGE batch from a video: one kept FFV1 file of exact 8-bit RGB frames. */
  | { kind: 'frames'; file: OutputFile; count: number; w: number; h: number }
  /** CreateVideo's VIDEO (Python's VideoFromComponents): encoded only when saved or shown. */
  | { kind: 'video'; frames: { file: OutputFile; count: number; w: number; h: number }; fps: number; sound: { file: OutputFile; note: SoundNote } | null }

// keptBytes.ts
putPath(runId: string, tmpPath: string, ext: KeptExt): Promise<OutputFile>   // sha256 streamed, then renamed into place
pathOf(file: OutputFile): string                                           // for a tool to read; throws KEPT_GONE when missing
workDir(runId: string): Promise<string>                                    // a temp folder inside the run's kept folder
// results.ts
pathOf?(file: OutputFile): string
saveFromPath?(tmpPath: string, o: SaveOptions): Promise<OutputFile>         // moved (or copied across disks), never read into memory

// server/media/values.ts
/** Classes whose sound Python decodes with _download_url_to_audio_dict (nodes_replicate.py:1735, :1834, :5463). */
export const SOUND_DOWNLOAD_CLASSES: ReadonlySet<string>   // GenerateMusicNode, MusicGenRemoteNode, GenerateSpeechNode, MiniMaxSpeechRemoteNode, CloneSingingVoiceNode
/** The note a sound value carries, or the maker's default for a value kept before R5 (no note). */
export function soundNoteOf(v: RunnerValue, makerClass: string): SoundNote
export function readSound(v: RunnerValue, makerClass: string, io: { access: FileAccess; userId: string | null; signal?: AbortSignal; hosted: boolean }): Promise<DecodedSound>
export function keepSound(runId: string, s: DecodedSound, kept: KeptBytes): Promise<RunnerValue>          // floatWav → 'exact'
export function readFrames(v: Extract<RunnerValue, { kind: 'frames' }>, io, onFrame: (rgb: Uint8Array, i: number) => Promise<void>): Promise<void>
export function keepFrames(runId: string, frames: AsyncIterable<Uint8Array>, w: number, h: number, io): Promise<Extract<RunnerValue, { kind: 'frames' }>>
/** An encoded MP4 of a made video, as VideoFromComponents.save_to writes it; a file video is returned as it is. */
export function videoFileFor(v: RunnerValue, io, o: { metadata?: Record<string, string> }): Promise<{ path: string; temporary: boolean }>
```

**Behaviour:**
- `frames` and `video` values are read only by inputs whose rule lists them in `valueInputs`. R5.4 and R5.5 add CreateVideo `images`, SaveVideoFrames `frames`, SaveVideo, GetVideoComponents and the Video card's `video`/`source` (`['files', 'video']`); R6 adds the video effects. Anything else wired from such a slot leaves the workflow to the engine: Save image, Preview image, a Frame, the picture effects, any paid node. See ruling (e).
- A sound slot stays `files`, with its readers kept in check by `linkSources`, as today. So Generate a video, the Frame and the rest can't be handed a sound they don't expect.
- The sound note is set by the node that makes the value: LoadAudio and the cards `'load'`, the paid sound nodes `'download'`, everything the runner writes `'exact'`. A value kept before R5 has no note and reads by its maker (`soundNoteOf`).
- A kept `.mkv` or `.wav` is written by the tools into `workDir`, then `putPath`. Kept bytes are never read whole into memory by media code.
- **Caps before work:** a frame batch or made video over `batchFrames` / `batchPixels`, a sound over `soundSamples`, or a run's kept total over `keptBytesPerRun` fails the node plainly, before the work where it can be told from the probe.

**Tests:**
- A stand-in class making each new kind:
  - a Gate hands each on;
  - `withWiredValues` leaves each alone;
  - a Save image reading a `frames` slot leaves the workflow to the engine (and `nodesNeedingEngine` names it);
  - a restart mid-run reads the kept `.mkv` back by path;
  - a changed kept file gives `KEPT_GONE`.
- Sound notes:
  - `soundNoteOf` of an R3.8-era value (no note) from Generate music is `'download'`, and from an Audio card `'load'`;
  - `readSound` gives each decoder's samples;
  - `keepSound` → `readSound` is bit-identical.
- `videoFileFor` of a made video equals `encodeVideo` of its parts; of a file video it is the file itself.
- The families-off invariant (rule 8) over every saved project graph.

**Acceptance:** the families-off invariant holds; every existing runner spec is green unchanged; the new kinds survive a restart.

---

### Task R5.3: Sound nodes (family `media-sound`)

**Port:**

| Class | Python | Behaviour | Outputs / ui |
|---|---|---|---|
| LoadAudio | `nodes_audio.py:402-440` (`execute` :420-424, `validate_inputs` :435-438) | The file as it is, note `'load'`; a missing file refused before the run (`Invalid audio file: …`, mapped to plain words) | slot 0 sound |
| RecordAudio | `:443-465` | The same, reading the browser's recording (WebM/Opus) from input | slot 0 sound |
| Audio (card) | `:260-363` (`execute` :318-350) | `source` wins, then the `audio` file (`'load'`), else Python's 1 s of silence at 44.1 kHz (kept `'exact'`, ui `{ audio: [] }`). The preview is always a FLAC made from the samples (`UI.PreviewAudio`), into temp with the prefix `ComfyUI_temp_` + 5 letters from `abcdefghijklmnopqrstuvwxyz`. With `export` on, `get_save_audio_ui` in `format`/`quality` into output, and the card's ui points at that copy. | slot 0 the sound as it came in; ui `{ audio: [{ filename, subfolder, type }] }` |
| SaveAudio | `:155-178` → `AudioSaveHelper.get_save_audio_ui` (`comfy_api/latest/_ui.py:373-387`) → `save_audio` (`:265-370`) | FLAC per batch item; `%batch_num%` replaced; counter from `get_save_image_path`, moved on per item; tags `prompt` and the workflow keys as JSON | ui `{ audio: [...] }` |
| SaveAudioMP3 | `:181-207` | MP3; quality `V0` / `128k` / `320k` | same |
| PreviewAudio | `:238-257` → `UI.PreviewAudio` (`_ui.py:413-425`) | FLAC into temp (prefix as above) | ui `{ audio: [...] }` |
| (Opus export) | `_ui.py:286-303` and torchaudio `resample` (`.venv/…/torchaudio/functional/functional.py:1303-1432`: `_get_sinc_resample_kernel`, `_apply_sinc_resample_kernel`; defaults `lowpass_filter_width=6`, `rolloff=0.99`, `sinc_interp_hann`) | A rate above 48 kHz becomes 48 kHz; a rate not in `[8000, 12000, 16000, 24000, 48000]` becomes the next one up; the samples are resampled with a port of torchaudio's kernel (the gcd-reduced rates, the Hann-windowed sinc and a float32 `conv1d`), then encoded | — |

- **Rows:**
  - `local: 'source'` for LoadAudio and RecordAudio; `local: 'render'` for the card, the savers and PreviewAudio (they write files).
  - Widgets with ComfyUI's options (the card's `format`: `flac`/`mp3`/`opus`; `quality`: `V0`/`128k`/`192k`/`320k`).
  - Every AUDIO input's `linkSources` lists the sound makers taken while their family is on: `SOUND_OUTPUTS` = LoadAudio 0, RecordAudio 0, Audio 0, GetVideoComponents 1 (with `media-video`), the four audio-gen classes 0 (with `audio-gen`), CloneSingingVoiceNode 0 (with `sound-in`).
  - Added to `SWITCHED_CLASSES` and `RUNNER_OUTPUT_CLASSES` (the savers, PreviewAudio and the card are output nodes).
- **The Audio card's rows.** `runnerRuleFor('Audio', …)` picks, in this order:
  1. the audio-gen row (`AUDIO_CARD_AUDIO_GEN_RULE`) while `audio-gen` is on and `media-sound` is off, as today;
  2. the new `AUDIO_CARD_MEDIA_RULE` while `media-sound` is on;
  3. the sync-3 row.

  With `media-sound` on, the card does what Python does, including export. R3's ruling (t), "shows the provider's own file until R5", ends here: the preview becomes Python's FLAC of the `'download'` decode.
- **Kept quirks** (spec: kept unless they lose data):
  - MP3 `V0` is `qscale` on, which is LAME's VBR quality 0 (`-q:a 0`); the Audio card's `192k` for MP3 falls through Python's `if` chain with no rate set, and the runner does the same.
  - A 3-to-8-channel sound fails plainly where PyAV raises.
  - A `'download'` sound from a stereo WAV answer is one interleaved row of double length. That loses data: ruling (k).
- **Hosted:**
  - the `audio` widget's file must be the user's own (rule 6);
  - saved files go under the user's subfolder;
  - previews go to temp in the user's subfolder, and are not assets.

**Files:**
- Create `frontend/server/runner/media/soundNodes.ts` (`planLoadAudio`, `planAudioCard`, `planSaveAudio`, `planPreviewAudio`, `saveAudioFiles`) and `frontend/server/media/resample.ts` (`torchResample(s: DecodedSound, to: number): DecodedSound`).
- Modify `executors.ts`, `eligibility.ts` (rows, `SOUND_OUTPUTS`, `AUDIO_CARD_MEDIA_RULE`, `runnerRuleFor`), `values.ts` (`OUTPUT_KINDS` needs no row: sounds are `files`), `families.ts` (`media-sound`, `FAMILY_REQUIRES`), `validate.ts` (`RUNNER_OUTPUT_CLASSES`, `ALSO_SWITCHED`), `inputs.ts` (LoadAudio and RecordAudio `audio`), and the script (group `sound`).
- Test: `runner-media-sound.unit.spec.ts`.

**Fixtures (`sound`):**
- each class's `execute` over the sound clips of rule 4;
- the card with and without `source`, with nothing (silence), and with `export` in each format and quality;
- SaveAudio with `%batch_num%` and a two-item batch;
- `resample` from 44.1, 22.05, 96 and 8 kHz (samples recorded);
- a Generate music answer (WAV mono and stereo) through the card.

Each case records the saved names, subfolders, the decoded samples, the tags and the ui.

**Test:** rule 10 (parity per rule 3), plus:
- with `media-sound` off, the Audio card rows are exactly as before;
- LipSync on sync-3 still reads the card's file as it is;
- a card fed by Generate music shows Python's FLAC preview;
- the resample is within 1e-6 of torch (a *library* kernel, as R2 rule 10: the ε is measured and written in the test);
- hosted: an unowned `audio` file is refused before the hold, and a saved sound is in the user's folder and counted as an output.

**Acceptance:** every fixture case passes; the families-off invariant holds; R3.8's tests stay green unchanged with `media-sound` off.

---

### Task R5.4: Video nodes (family `media-video`)

**Port:**

| Class | Python | Behaviour | Outputs / ui |
|---|---|---|---|
| LoadVideo | `nodes_video.py:167-204` (`execute` :188-190; `validate_inputs` :201-204) | The file as it is (`VideoFromFile`); no work | slot 0 video (`files`) |
| GetVideoComponents | `:142-164` → `get_components_internal` (`video_types.py:247-310`) | Of a file: one job decodes the frames into a kept FFV1 file (`keepFrames`) and the last sound stream into a kept float WAV (`fltp` skip rule); no sound stream gives slot 1 an empty sound. Of a made video: its own parts, no work. | slot 0 `frames`; slot 1 sound (`'exact'`) or none; slot 2 number `float(average_rate or 1)` (`int: false`) |
| CreateVideo | `:117-139` | `VideoFromComponents(images, audio, Fraction(fps))`: a `video` value naming the frame batch and the sound; no work | slot 0 `video` |
| SaveVideo | `:68-114` → `VideoFromFile.save_to` (`video_types.py:319-374`) or `VideoFromComponents.save_to` (`:409-470`) | A file with `format` auto/mp4 and `codec` auto or its own codec: a stream copy (`-map 0:v -map 0:a? -map 0:s? -c copy`, the source's tags kept, `prompt` and workflow added, `movflags use_metadata_tags`) into `<prefix>_<nnnnn>_.mp4`. Otherwise (a different codec was asked for) the file is decoded into parts first, as Python does. A made video: `encodeVideo` at `Fraction(round(fps·1000), 1000)` with `PYAV_H264_DEFAULT`, the sound cut to `ceil(rate / fps · frames)` samples, AAC with layout `{1: mono, 2: stereo, 6: 5.1}` else stereo. | ui `{ images: [{ filename, subfolder, type: 'output' }], animated: [true] }` |
| Video (card) | `:296-395` (`execute` :345-385) | `source` wins, then `file`, else ui `{ images: [] }`. A file video is shown as the file itself, as the runner does today (Python writes a stream-copied temp preview; same pictures, same sound). A made video is encoded to a temp preview `preview_video_<nnnnn>_.mp4`. With `export` on: a copy into output under `filename_prefix` (stream copy of a file, encode of a made video), and the ui points at it. | slot 0 the video as it came in; ui as Python |

- `fps` of CreateVideo is the Python float. `round(Fraction(fps) · 1000)` is computed exactly (BigInt over the double's exact fraction, half to even) before it becomes `-r`.
- An odd width or height of a made video fails with `MEDIA_WORDS.oddSize` at eligibility when known, else at the node's turn before any work. This is a known Python quirk: libx264 refuses it.
- A frame batch of 0 frames (Python's `zeros(0, 3, 0, 0)`) fails plainly at save, as Python does.
- **Rows:**
  - `local: 'source'` for LoadVideo and CreateVideo; `local: 'render'` for GetVideoComponents, SaveVideo and the card;
  - `valueInputs` of `images` `['frames']`, of `video` `['files', 'video']`, of `audio` by `SOUND_OUTPUTS`;
  - `OUTPUT_KINDS` `GetVideoComponents: { 0: 'frames', 2: 'number' }` and `CreateVideo: { 0: 'video' }`, applied only while `media-video` is on;
  - the card's existing row (runner-owned `Video`) is unchanged with `media-video` off; with it on, `export` and `video` sources are taken.
- **Hosted:** the `file` widget is owned (rule 6); caps from the probe before any decode; saved videos are in the user's subfolder.

**Files:**
- Create `frontend/server/runner/media/videoNodes.ts` (`planLoadVideo`, `planGetVideoComponents`, `planCreateVideo`, `planSaveVideo`, `planVideoCard`, `saveVideoFile`).
- Modify `executors.ts` (the `Video` case keeps today's branch with `media-video` off), `eligibility.ts`, `shared/runner/values.ts` (the two rows), `families.ts`, `validate.ts`, `inputs.ts` (LoadVideo `file`), and the script (group `video`).
- Test: `runner-media-video.unit.spec.ts`.

**Fixtures (`video`):**
- LoadVideo → GetVideoComponents over every standard clip (frames, sound, fps);
- CreateVideo → SaveVideo at 24, 29.97 and 30 fps, with none, mono and stereo sound;
- SaveVideo of an MP4, a WebM, a MOV and a file with a subtitle stream, with `format` and `codec` each `auto` and set;
- the card with `source`, `file`, nothing, and `export` on for a file and for a made video.

Each case records names, ui, the output's probe, decoded frames and sound, and tags (also with PyAV on `libopenh264`, rule 3).

**Test:** rule 10, plus:
- LoadVideo → GetVideoComponents → CreateVideo → SaveVideo runs in the runner with ComfyUI off;
- GetVideoComponents of a made video does no work (a spy on `runMedia`);
- a stream-copied save keeps the source's packets (the probe's codecs and the decoded frames equal the source's);
- a 4-channel sound into CreateVideo is encoded as Python does, and 3 channels fail plainly;
- with `media-video` off, the Video card and every existing video family are unchanged.

**Acceptance:** every fixture case passes by rule 3; the families-off invariant holds.

---

### Task R5.5: Frame batches from and to files (family `media-video`)

**Port:**

| Class | Python | Behaviour |
|---|---|---|
| LoadVideoFrames | `nodes_video_effects.py:516-613` (`execute` :554-599) | `scale = min(1, max_size / max(w, h))`; `tw, th = max(1, round(w·scale))`, `max(1, round(h·scale))` (Python's `round`, half to even); `fps = float(average_rate) or 30.0`; `time_cap = int(max_seconds · fps / stride)` when `max_seconds > 0`; `cap = min(time_cap, max_frames)`; skip to `start_frame`, keep every `stride`-th decoded frame; each kept frame, when resized, goes through **PIL's `resize(BILINEAR)`** on 8-bit RGB; nothing kept gives one 64×64 black frame. Outputs: slot 0 `frames`, slot 1 number `fps / stride`. |
| SaveVideoFrames | `:621-740` (`execute` :661-740) | T = 0 returns nothing. The name is `<(prefix or 'video').rstrip('_')>_<YYYYmmdd_HHMMSS>.mp4` in output's top folder, the user's subfolder in hosted; see ruling (h). Frames are `(clamp(0,1)·255).astype(uint8)` (truncation), padded to even sizes with black at the right and bottom. The rate is `Fraction(round(fps·1000), 1000)`. H.264 uses `{ crf, preset }` through `h264Args`. With an `audio_file` (not `(none)`), the file's first sound stream is decoded frame by frame, stopping at the first frame whose `time > T / fps` (so up to one sound frame more than the video), and encoded to AAC stereo at the stream's rate. A sound that won't open is skipped, as Python does (logged, the video saved without it). ui `{ images: [{ filename, subfolder, type: 'output' }], animated: [true] }`; no outputs. |

- **PIL bilinear:** `pixels/core.ts` `pilCoeffs` gains a filter parameter (`'lanczos' | 'bilinear'`; bilinear is PIL's triangle filter, support 1). `pilResize(px, w, h, c, ow, oh, stop, filter)` then serves both. It is proven against Pillow's `resize(BILINEAR)` on the R2 fixture pictures (exact: Pillow's fixed-point path).
- **Streaming:** decoded frames pass one at a time from `decodeFrames`, through the resize on the Frame's worker (`pixelsInWorker`, its watchdog and Stop), into `keepFrames`. Memory holds a few frames at most.
- **Caps:** `max_frames` (≤ 10,000, ComfyUI's max) and the hosted caps of ruling (f), checked from the probe before any decode where the count is known, and as frames arrive otherwise.

**Files:**
- Create `frontend/server/runner/media/frameNodes.ts` (`planLoadVideoFrames`, `planSaveVideoFrames`).
- Modify `pixels/core.ts` (the filter), `executors.ts`, `eligibility.ts`, `shared/runner/values.ts` (`LoadVideoFrames: { 0: 'frames', 1: 'number' }`), `families.ts`, `validate.ts`, `inputs.ts` (`file`, `audio_file`), and the script (group `frames`).
- Test: `runner-media-frames.unit.spec.ts`.

**Fixtures (`frames`):**
- LoadVideoFrames over the standard clips with `max_size` 720 / 64 / 4096, `stride` 1 / 3, `start_frame` 0 / 5 / past the end, and `max_seconds` 0 / 0.5;
- Pillow `resize(BILINEAR)` on the R2 pictures;
- SaveVideoFrames at odd and even sizes, `fps` 24 / 29.97, CRF 10 / 20 / 32, with and without each sound clip (and with a broken one).

**Test:** rule 10, plus:
- the frame count and fps equal Python's in every case;
- the 64×64 black fallback;
- the resize is byte-equal to Pillow;
- the padding is black;
- the sound overruns by at most one sound frame, exactly as Python's;
- two saves in the same second don't overwrite each other (ruling (h));
- Stop mid-decode leaves no kept file.

**Acceptance:** every fixture case passes; LoadVideoFrames → SaveVideoFrames runs with ComfyUI off.

---

### Task R5.6: Thumbnails, waveforms and the asset probe without the engine

No family (ruling (l)). With the tools ready, the four media routes answer from Sailor. Without them, they forward to the engine as today, and answer 503 when it's down. The hosted gate (`server/utils/engineGate.ts:749-940`: ownership of `asset_id` and `filename`) is unchanged and still runs first.

**Port:**

| Route / helper | Python | The runner |
|---|---|---|
| `_probe_media` (for `POST /sailor/asset_import`) | `nodes_timeline.py:2077-2120`: video (`.mp4 .webm .mov .avi .mkv .m4v`), the first stream's `width`/`height` and `duration · time_base` when both are set; audio (`.mp3 .wav .flac .ogg .m4a .aac`), the first sound stream's `duration · time_base`; any error gives nulls; kind by extension, unknown → `'video'` | `probeMediaNative` in `server/native/media.ts` gains video and audio through `probeMedia` |
| `_gen_thumbnails` (video) | `:2184-2245`: `dur_sec` = stream `duration · time_base`, else `container.duration / 1e6`; ≤ 0 → `[]`; for i < count, `t = step · (i + 0.5)`, seek backward to the keyframe before `int(t / tb)`, decode until `pts ≥ target`, `to_ndarray('rgb24')`, PIL `resize((max(1, round(w·48/h)), 48), BILINEAR)`, PNG `optimize=True` as a data URL | `videoThumbnails(path, count)`: one ffmpeg job per thumbnail (`-ss` before `-i` with `-noaccurate_seek` matches "keyframe before"; the implementer proves which frame comes out on the fixture clips), then `pilResize(…, 'bilinear')` and a PNG from sharp |
| `/sailor/input_thumbnail` | `:2247-2279` | `inputThumbnailRoute`: the `engine()` branch for a non-image becomes `videoThumbnails(p, 1)` when the tools are ready. Audio files still give `[]` → 404, as Python does. |
| `/sailor/asset_thumbnails` | `:2281-2311` | `assetThumbnailsRoute`: the same |
| `_gen_waveform_peaks` | `:2319-2352`: every decoded frame's `to_ndarray()`; if 2-D and ≤ 8 rows, the mean over rows (a packed file is one row, so interleaved samples are **not** mixed); `abs` as float32; concatenated; divided by the peak (or 1); `chunk = max(1, len // n)`; each bucket is the max of `[i·chunk, (i+1)·chunk)`, the last to the end, and 0.0 past the end | `waveformPeaks(path, buckets)` over R5.1b's native-format decode (the `load` path before its integer scale, which the peak normalisation makes irrelevant except for float32 rounding), numpy's float32 row mean ported as `(a + b) / 2` in float32 |
| `/sailor/asset_waveform` | `:2354-2388` | `assetWaveformRoute`: native peaks when ready; the JSON written by `pyDumps` (float repr) under the same cache name |

- Cache names, folders and response shapes are unchanged (they are already Python's, in `media.ts`).
- The PNG bytes differ from PIL's `optimize=True`. They are compared decoded, and must be byte-equal in pixels.
- Jobs use the routes' two slots with a 30 s limit (rule 5). A timed-out thumbnail answers what Python answers for a failure (`[]`, so 404 or an empty list), is not cached, and is logged.
- The client (`app/composables/useClipPreview.ts`, `TimelineEditor.vue:1969`) needs no change: the 503 path simply stops being hit. Its retry suppression stays for machines without the tools.

**Files:**
- Modify `frontend/server/native/media.ts` (the header's line numbers corrected; `probeMediaNative`, `inputThumbnailRoute`, `assetThumbnailsRoute`, `assetWaveformRoute`, `runMediaRoute`).
- Create `frontend/server/media/thumbnails.ts` (`videoThumbnails`, `waveformPeaks`).
- Modify the script (group `timeline-media`, which runs the handlers lifted with `ast`, as Phase A's parity tests do).
- Test: `frontend/tests/unit/native-media-video.unit.spec.ts`.

**Fixtures (`timeline-media`):**
- `_probe_media` over every standard clip and an unreadable file;
- `_gen_thumbnails` with count 1, 5 and 20 (decoded PNG pixels);
- `_gen_waveform_peaks` with 16, 256 and 2048 buckets (including the packed stereo WAV and the −32768 WAV).

**Test:**
- the three routes answer Python's shapes and cache names with ComfyUI down (the `forwardToEngine` spy never called);
- decoded thumbnails and the peaks' JSON equal the fixtures;
- with the tools missing, the routes forward (or answer 503) exactly as today;
- a hosted request for another user's asset is refused by the gate before any job;
- a hanging decode answers within 30 s.

**Acceptance:** the fixtures pass; `useClipPreview.ts`'s 503 path isn't hit with ComfyUI off on a machine with the tools.

---

### Task R5.7: Controller check, fixture-level and in the browser (not delegated)

- [ ] The build (R5.1a) on this Mac and in `docker build --target media-tools`, with the user's go for the source downloads. Record the versions, the sha256s, the binaries' sha256 and the size added to the image in the ledger.
- [ ] Real routes and engine, hosted mode, `NUXT_RUNNER_FAMILIES=cards,media-sound,media-video`, ComfyUI stopped:
  - LoadAudio (MP3) → Save audio (MP3, V0);
  - Audio card (WAV) with `export` on (FLAC, then Opus from 44.1 kHz);
  - LoadVideo (MP4 with sound) → Get video components → Create video → Save video;
  - Load video frames (stride 2, max size 256) → Save video frames with a sound file;
  - Video card showing a made video.

  For each: the saved files by rule 3, nothing charged, and Stop mid-job kills the process (no `ffmpeg` left in `ps`).
- [ ] Hosted safety by hand:
  - an HLS playlist uploaded as `clip.mp4` is refused;
  - a 4097-pixel-wide video is refused before decoding;
  - another user's file is refused before the run.
- [ ] With both media families off, the needs-engine list over every saved project is identical to before R5.2; every `runner-*.unit.spec.ts` is green unchanged.
- [ ] The browser check on the shared :3002 server (the controller's), tools built:
  - open the Timeline editor with ComfyUI stopped: video clips show their filmstrips, sounds their waveforms, and an imported clip its length;
  - run a saved project with a LoadVideo → Save video.
- [ ] R3.10 and R3.17 are unblocked: their tasks can be dispatched.

Record the results in `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md` and `docs/STATE.md`. The media families stay off in hosted until the user answers ruling (b).

### Controller rulings needed before R5 is built

- **(a) Which ffmpeg build.** The ledger says "an LGPL build with OpenH264". *Recommend:* build FFmpeg 8.0.3 ourselves, from its signed source, with only LGPL parts: OpenH264 2.5.1 for H.264, LAME for MP3, Opus, dav1d. Use one script for this Mac and for the Fly image, with every version and checksum pinned in the repository. FFmpeg 8.0 is the same branch Python uses, so pictures and sounds come out the same. *Cost:* a one-time 10-minute build on each machine (and in each image build), plus a script to keep up to date. The alternative, ready-made downloads, either includes GPL parts or has no Mac build we can check, and is a different FFmpeg from Python's.
- **(b) H.264 patents on a server.** OpenH264's code is free to use (BSD), but Cisco's promise to cover the H.264 patent fees applies only to Cisco's own program, downloaded by a person onto their own device. It doesn't cover a server encoding video for customers. Whether Sailor needs its own patent licence (from Via LA) is a legal question, and the same question applies to Python's encoder today. *Recommend:* build it, switch the two media families on locally, and keep them off in hosted until you've checked this (most exports already happen in the browser, whose maker holds the licence). *Cost:* hosted users can't save or stitch video on the server until then; Turntable with views (R3.17) waits with it in hosted. The alternative is saving server videos as WebM (VP9, royalty-free), which some players and editors don't open.
- **(c) What "the same video" means across two different H.264 encoders.** The ledger's rule for lossy files ("average within 2/255, nowhere more than 8/255") can't hold between Python's encoder (x264) and ours (OpenH264). Each gets edges slightly differently, and single pixels move by more than 8 levels. *Recommend:*
  - frame count, rate, length and size exactly equal;
  - the average difference from Python's decoded frames within 2/255;
  - our result no further from the original frames than Python's (within 0.5 dB);
  - an exact match with Python's own pipeline switched to OpenH264, which proves we feed the encoder the same frames.

  For MP3 and AAC, same library versions, so exact decoded samples are expected; where not, a signal-to-noise ratio of at least 60 dB against Python's decoded sound. *Cost:* a looser rule for H.264 only. The alternative is a rule no build without x264 can pass.
- **(d) Python's quality numbers on a different encoder.** Save video frames asks for x264's "CRF" and "preset", and Turntable uses CRF 20. OpenH264 has neither. *Recommend:* a measured table, one OpenH264 setting per CRF, chosen so our video is never worse than Python's at that CRF. The preset is ignored (it only changes x264's speed). *Cost:* files may come out somewhat larger than Python's.
- **(e) A video's frames travel as exact 8-bit pictures.** Python holds a video's frames as floats. Frames decoded from a file are exactly 8-bit anyway, so nothing is lost. *Recommend:* keep them as one lossless FFV1 file per batch. Until R6, only the video nodes may read them; a frame batch wired into Save image, a Frame or a picture effect leaves the workflow to the engine. *Cost:* those mixed workflows still need ComfyUI until a later task teaches the picture nodes to read a batch.
- **(f) Hosted limits.** *Recommend:* hosted, a video up to 2 GiB and 10 minutes, frames up to 4096×4096, a frame batch up to 600 frames and 600 × 1920 × 1080 pixels, a sound up to 512 MiB and 30 minutes, 4 GiB of kept files per run; one media job per person at a time. Local: Python's own limits (10,000 frames, 8192²), 60 minutes, two jobs. *Cost:* hosted users can't load a 20-minute 4K clip frame by frame; the numbers can rise once measured on the Fly machine.
- **(g) Audio waveform moves to the video effects (R6.1).** It reads a sound, but its work is drawing bars and circles exactly as Python's drawing library does, plus a numpy FFT. *Recommend:* move it. *Cost:* it keeps needing ComfyUI until R6.1.
- **(h) Save video frames overwrites files.** Python names the file by the second it was saved, with no counter, so two saves in one second overwrite each other, and hosted users would share the top output folder. *Recommend:* keep Python's name, add a counter only on a clash (the runner never overwrites), and in hosted put it in the user's own folder. *Cost:* a rare name differs from Python's.
- **(i) Workflow details written into saved videos and sounds.** Python writes the workflow into each file's tags. *Recommend:* do the same, as Save image does (R1.5). *Cost:* none beyond Python's own behaviour.
- **(j) Opus exports at 44.1 kHz.** Opus needs 48 kHz, so Python converts the sound with torchaudio's resampler, and most sounds are 44.1 kHz. *Recommend:* port torchaudio's resampler (a fixed, well-defined filter), proven within a millionth of Python's samples. *Cost:* a moderate port. The alternative is refusing Opus export for most sounds.
- **(k) Stereo sounds from paid nodes come out scrambled in Python.** When a paid node answers with a stereo WAV (MusicGen's stereo models), Python reads its left and right samples as one long mono track of double length, then scales it to full volume. *Recommend:* keep the full-volume scaling (that's how Python's results sound), and read stereo properly (the scramble loses the sound). *Cost:* those results differ from Python's, on purpose; the report lists it.
- **(l) Thumbnails and waveforms switch themselves on.** *Recommend:* no switch. When the video tools are installed, the Timeline's filmstrips, waveforms and clip lengths come from Sailor; without them, it's as today. *Cost:* installing the tools changes those routes at once (they're read-only and free).
- **(m) Where the tools live on this Mac.** *Recommend:* `frontend/.media-tools/`, ignored by git, built by the script. A Homebrew ffmpeg is never used, even if installed: it contains GPL parts, and it would make different files from the Fly machine. *Cost:* each developer machine runs the build once.
- **(n) The source-code duty of the LGPL.** The licence asks for the source when the program is *given* to someone. Sailor only runs it on its own server. *Recommend:* ship the licence texts, the exact source addresses and checksums, and the build line beside the program. Add the source archives themselves only if the image is ever handed to anyone. *Cost:* none now.
- **(o) The Fly image already contains GPL video code.** Python's video library (PyAV) inside today's image bundles x264 and x265, which are GPL. So "no GPL" holds for what Sailor's new tools use, not for the whole image, until ComfyUI leaves it. *Recommend:* note it, and remove PyAV from the image when the engine goes. *Cost:* none now; worth knowing for the legal check in (b).
- **(p) Two switches, not one.** *Recommend:* `media-sound` and `media-video`, so sound can be switched on in hosted while (b) is open. *Cost:* one more switch.
- **(q) Full-range videos read slightly washed out.** Python's video reader ignores a video's "full range" tag (phone videos often have it), so dark and bright parts are slightly squeezed. *Recommend:* keep Python's reading, so the pictures match what ComfyUI gives today. *Cost:* those videos look slightly flatter than in a video player, as they do in ComfyUI today; fixing it is a one-line change later if you prefer the true colours.

### R5 size

Eight tasks: two for the tools (R5.1a the build and licence, R5.1b the media module), one of machinery (R5.2), three porting tasks (R5.3 sound, R5.4 video, R5.5 frame batches), one for the Timeline's thumbnails, waveforms and asset probe (R5.6), and the controller's check (R5.7).

They cover 11 classes (LoadAudio, RecordAudio, SaveAudio, SaveAudioMP3, PreviewAudio, LoadVideo, GetVideoComponents, CreateVideo, SaveVideo, LoadVideoFrames, SaveVideoFrames), the Audio and Video cards in full, four routes, and two families (`media-sound`, `media-video`). Audio waveform moves to R6.1 and the Timeline node to R9.1.

There are no paid calls and no live checks: R5 costs nothing to run. The one outside step is the build's download of about 25 MB of pinned sources (the controller's, with the user's go). R3.10 and R3.17 are unblocked when R5.1b lands, and their live checks (about $3.20) follow then. The largest tasks are R5.1b (the parity of every probe, decode and encode) and R5.4. Each of those is one reviewable unit, because the module's pieces are proven one at a time before any node uses them.

---

# R6 — Video and sound effects

R6 moves the video effects (nodes that work on a clip's frames) and the sound effects onto Sailor's own server. They are built on R5: its video tools (`frontend/server/media/`), its `frames` and sound values between nodes (R5.2), and its families `media-video` and `media-sound`. The picture maths comes from R2 (`frontend/server/runner/effects/core/`, the Frame's worker, the exact and library parity classes). The outline's two tasks are replaced by the eleven below (expanded 2026-09-30). `.superpowers/sdd/2026-09-26-engine-free-step3/r6-expansion-report.md` lists the corrections to the outline and why. In short:

- **Video: 21 classes, not 20.** The outline's 20 are the inventory's table, which includes Text clip (`nodes_text.py:123-165`, a file the outline didn't name), and Audio waveform joins from R5 (R5 ruling (g)). By file: `nodes_video_effects.py` 8 (its Load video frames and Save video frames were R5.5), `nodes_video_pro.py` 10 with Audio waveform, `nodes_frame_interp.py` 1 (Slow motion (AI) is R7.3), `nodes_audio_effects.py` 1 (Silence cut), `nodes_text.py` 1 (Text clip).
- **Sound: 12 is right**, plus one R5 missed. `nodes_audio_effects.py` 3, `nodes_audio.py` 8, `nodes_audio_denoise.py` 1. Save audio (Opus) (`nodes_audio.py:210-235`) is a codec class that R5 and the inventory both left out; it joins R6.9 under `media-sound`. The other `nodes_audio.py` classes (Empty latent audio, the three VAE audio nodes, Conditioning stable audio) are the local diffusion stack, which stays local-only (decision 4).
- **Python's text looks different on each machine.** Caption track and Text clip load the first font in `_FONT_PATHS` (`nodes_text.py:16-34`). On this Mac that is Helvetica. The Fly image has none of those files, so Pillow falls back to its built-in font at 10 pixels whatever size is asked for (measured with Pillow 12.1.1: `load_default()` is Aileron, size 10). See ruling (b).
- **The glitch transition can be exact.** It uses the unseeded global random generator, as Add noise does. R2.3's port of torch's generator reproduces it under a seed, so it follows Add noise's ruling (R2 ruling (e)) rather than "visually equal only". See ruling (e).
- **Chroma key makes a mask batch**, a kind the runner has no value for. See ruling (l).
- **Noise removal mixes two precisions.** noisereduce 3.0.3 (the installed version) works in double precision, except its noise profile: scipy's STFT of the float32 noise sound stays single precision (measured: complex64). It also cuts sounds longer than 600,000 samples into chunks padded with 30,000 samples each side. The port must follow both.
- **Python holds a whole clip as floats.** 600 frames at 1920 × 1080 is 15 GB. The runner can't, so R6 streams frames through the worker and keeps 8-bit batches (ruling (a)); only effects that need every frame at once hold them, under a cap (ruling (i)).
- **No saved project uses an R6 class** (all 1,059 in `user/sailor/projects/`, checked 2026-09-30). The families-off invariant is therefore also checked on synthetic graphs.
- R5's references to "R6.1" for Audio waveform now mean R6.7.

**Order.** R6.1 (the machinery, with three pilot effects) comes first. After it, R6.2, R6.3, R6.4, R6.6 and R6.8 are independent, but all edit `eligibility.ts`, `families.ts` and the worker's list of cores, so the controller runs them one after the other or merges them. R6.5 builds the shared FFT (a fast way to turn samples into frequencies), so R6.7 and R6.10 come after it. R6.9 (sound) needs R6.1's lease and start pass; R6.10 needs R6.9. R6.11 is the controller's check.

**Families** (each off by default; each needs its media family, which needs `cards`; each answers as off while the tools are missing, as R5's do):

| Family | Task | Classes | Needs |
|---|---|---|---|
| `video-time` | R6.1 (pilots), R6.2 | Frame trail, Reverse / ping-pong, Trim, Motion blur (time), Slit scan, Time displacement, Speed ramp | `media-video` |
| `video-join` | R6.3 | Crossfade, Transition | `media-video` |
| `video-look` | R6.4 | Ken Burns, Aspect convert, Chroma key, LUT, 3-way color | `media-video` |
| `video-stabilize` | R6.5 | Stabilize | `media-video` |
| `video-flow` | R6.6 | Slow motion (the optical-flow one) | `media-video` |
| `video-draw` | R6.7 | Animated noise, Audio waveform | `media-video` |
| `video-text` | R6.8 | Text clip, Caption track | `media-video` |
| `sound-effects` | R6.9 | Trim audio duration, Split and Join audio channels, Audio concat, Audio merge, Audio adjust volume, Empty audio, Audio equalizer (3-band), Audio fade, Audio normalize, Audio duck, Silence cut | `media-sound` |
| `sound-denoise` | R6.10 | Audio denoise | `media-sound` |
| `media-sound` (R5's) | R6.9 | Save audio (Opus) | `cards` |

## Matching rule for R6–R11 (USER, 2026-09-30; overrides "match Python exactly" and any ruling below that conflicts)

1. **Cheap stays exact.** Where matching Python exactly is nearly free (simple maths, pass-through, sums, resizing we already have), keep exact fixture tests. No extra effort beyond that.
2. **Hard ports only need to look the same.** Where exact matching needs a large port or a new engine, "looks the same side by side" plus loose numbers is enough; no last-bit or sub-pixel chasing. Now:
   - R6.6 slow motion: any sound optical-flow method, including ffmpeg's own `minterpolate` if it is in our build. The 0.01-pixel rule is dropped.
   - R6.8 text: captions readable and placed sensibly; the layout need not match Pillow.
   - R6.10 noise removal: judged by ear and a loose signal-to-noise figure.
3. **Fix Python's bugs, don't copy them.** Drop quirks nobody wants (the squeezed stereo waveform; a LUT that silently does nothing when it won't load). Copy a quirk only when an existing saved project would visibly change without it.
4. **Never relaxed:** money rules; hosted safety (ownership, caps, allow-lists); "switching a family on never makes a working graph fail"; "Stop leaves nothing running".
5. **Reviewers** judge by these rules: a difference from Python is a finding only if someone would notice it, or it breaks point 4.
6. **Pace:** small tasks, short reviews; anything else is parked.

## Rules every R6 task follows (binding for R6.1–R6.10)

1. **Rows.**
   - Each class's rule row comes from its real `define_schema()`, generated by `scripts/runner_effect_rows.py --media` into `frontend/shared/runner/mediaEffectSchemas.generated.ts` (R2.1's generator, extended; running it twice gives identical bytes).
   - Every R6 class is `local: 'render'` (each decodes, computes or encodes, so it counts as work; R5 rule 9).
   - The classes Python marks `is_output_node=True` (every video effect except Slow motion, Silence cut and Text clip; and Save audio (Opus)) join `RUNNER_OUTPUT_CLASSES`. All join `SWITCHED_CLASSES` with their family.
   - The video effects are kept out of R2's `EFFECT_FAMILY_OF`, so the live preview route (R2.11) answers "needs a full run" for them (ruling (m)).
2. **Values in and out.**
   - A frame-batch input (`frames`, `clip_a`, `clip_b`, and 3-way color's `image`) reads only a `frames` value: `valueInputs: { <input>: ['frames'] }`, `linkSources: { <input>: FRAMES_OUTPUTS }`. `FRAMES_OUTPUTS` is every (class, slot) that makes a batch: Get video components 0, Load video frames 0, each video effect's 0, and Silence cut 0, each taken only while its own family is on.
   - A sound input reads only from `SOUND_OUTPUTS` (R5.3), which gains every sound effect's sound slots and Silence cut's slot 1.
   - A still picture wired into a video effect, or a video effect's frames wired into a picture node, leaves the whole workflow to the engine (ruling (k)). So does a wire from Chroma key's mask (ruling (l)).
   - A frames output is a new kept FFV1 file (R5.2's `frames` value). An effect whose result is its input unchanged (Frame trail on one frame, LUT with `(none)`, Adjust volume at 0, Denoise at strength 0, a fade of 0 and 0) hands its input value on with no work, and still writes its preview where Python does.
   - A sound output is kept as a float WAV and read back exactly (`keepSound`, note `'exact'`).
3. **Anything the runner can't do leaves the whole workflow to the engine, before the run.** Switching a family on must never make a working graph fail. A start pass (`mediaEffectStartProblems`, R6.1 and R6.9, beside R5's `frameStartProblems`) works out, from the source files' probes and the widgets, each frame batch's count and size and each sound's rate, channels and length, through the whole chain. Where a node would pass one of its limits (ruling (i): frames held at once, work, sound held at once; R5's batch and sound caps; a kept total over the run's room), or a source is one the build can't read, the answer is `engine: true` (`RUNNER_NOT_ELIGIBLE`), never a refusal. Where only an upper bound is known (Silence cut's output count), the bound is used.
4. **Frames between nodes are 8-bit** (ruling (a)). An effect computes in float32 exactly as Python does, from frames that are `k / 255`. Its output is kept as:
   - `trunc(f32(255·x))` when every reader of the slot only encodes it (Create video, Save video frames): Python's savers truncate the same float, so the saved video equals Python's;
   - otherwise `round(f32(clamp(x)·255))`, half to even, R2 rule 3's hand-off rounding. The next effect reads `k / 255`; that is the per-node parity rule ("8-bit output for the same 8-bit input, per node").
5. **Parity classes.** R2 rule 10's *exact* (bit for bit in float32) and *library* (within a measured ε, at most 2⁻⁸ in 255-scale, written in the test) apply to every kernel. R6 adds two more:
   - *Band.* Where Python cuts a float into a decision (a threshold, an `int()`, an `argmax`), the runner's decision must equal Python's in every fixture case, except where the fixture records that Python's own value lay within ε of the edge. Those cases are listed in the fixture, named in the task's report, and may differ by one step only.
   - *Visual.* Only where a ruling says so (text pixels, ruling (c)). The measure is written in the test.

   Sound samples are float32. An exact class is bit-identical; a library class is within its measured ε, at most 1e-6 (the outline's bound).
6. **Streaming and memory.**
   - Frames pass one at a time: R5.2's decode of the kept batch, the worker, then R5.2's FFV1 writer. Each frame is its own worker call (`pixelsInWorker`, its queue, 2-minute watchdog and Stop), so other people's Frame work interleaves. State an effect carries between frames (Frame trail's trail, Stabilize's last FFT) is handed in and out with each call.
   - An effect that needs many frames at once holds them as 8-bit, never as floats, and only up to its held-bytes limit (ruling (i)), which the start pass checks.
   - Kept bytes are never read whole into memory by media code: batches are read through the tools, frame by frame.
   - Sounds are held in memory as float32, as Python holds them, up to the sound limit of ruling (i). Heavy sound work runs on the worker in pieces (a denoise chunk, one channel's filter).
7. **Processes, slots and Stop.**
   - A node's tool processes (its inputs' decodes and its output's encode, at most three) run under one lease (`mediaLease`, R6.1), which takes one of the person's media slots (hosted: one running at a time). R5's route slots (one running and four waiting per person) stay separate. The lease is taken all at once, so a node never waits on itself.
   - Stop, a timeout or a failure ends the lease: every process it started is killed (SIGKILL) within one second, and partial files are removed. No `ffmpeg` is left running (the controller checks with `ps`, R6.11).
8. **Hosted safety.**
   - Every widget that names a file (LUT's `lut_file`, Audio waveform's `audio_file`) is listed by `collectInputFiles` and read by `pythonInputRef`: a name that is absolute or climbs out of its folder is refused by its name alone, before any disk check, and the file must be the person's own before the run.
   - Previews go to temp under the person's subfolder; kept files are the run's own.
   - The caps come from the probes and the widgets, before any decode (rule 3).
9. **The live preview.** A video effect Python marks as an output node writes `live_preview_<node id>.png` of frame `T // 2` (Python's `_preview` / `_save_preview`, `nodes_video_effects.py:30-35`, `nodes_video_pro.py:47-52`, then `_live_preview.py:23-63`): `np.clip(255·x, 0, 255).astype(uint8)` of that frame's float, compress level 1. Its ui is `{ images: [{ filename, subfolder: '', type: 'temp' }], animated: [false] }`. An empty batch writes no preview and has no ui, as Python. The preview tensor is the output unless a task says otherwise (Chroma key: the keyed picture).
10. **A kept value reads back under the caps it was kept under** (R5.2: `readFrames` and `readSound` with `kept`). A batch or sound whose readers have all finished is let go at once (ruling (j)).
11. **Free.** No price, no hold, no charge, and no calls to any provider. Slow motion never quietly becomes the paid Slow motion (AI). With no calls, the rule that a pipeline charges 0 for calls that delivered nothing doesn't arise.
12. **Families off, and cards off.** With every R6 family off, and also with them on but the tools missing, `runnerTakesNode`, `nodesNeedingEngine`, `outputKindsFor`, `PICTURE_OUTPUTS` and `valueWiresAllowed` answer exactly as before R6.1, over every saved project graph and over the fixture script's synthetic graphs (one per class, wired from Load video → Get video components and Load audio). Every existing `runner-*.unit.spec.ts` stays green, unchanged. `parseFamilies` drops an R6 family whose media family (or `cards`) is off.
13. **Fixtures.** `scripts/runner_media_fixtures.py --group <g>` writes `frontend/tests/unit/fixtures/runner-media-<g>.json` (R5's script and helpers; the other groups' files are untouched; running twice gives identical bytes).
    - Groups: `vfx-time`, `vfx-join`, `vfx-look`, `vfx-stabilize`, `vfx-flow`, `vfx-draw`, `vfx-text`, `sfx`, `sfx-denoise`.
    - Each case calls the **real** node's `execute` with `cls.hidden.unique_id` set, reads the preview Python wrote, and records the outputs. torch runs at its default thread count, as R2 rule 11 (the count is recorded); OpenCV's thread count is recorded too.
    - Where Python draws from the unseeded global generator, the case seeds it first (`torch.manual_seed(s)`), as R2.9 does.
    - **Standard frame inputs,** made by R5's `synth_frame` and handed over as Get video components hands them (`u8 / 255`): `clip8` (8 frames, 24 × 16), `clip8-odd` (8 frames, 23 × 15), `clip2`, `clip1`, and `clip8-big` (8 frames, 160 × 90, hashed). The two-clip effects add `clip6-small` (6 frames, 16 × 12). Tasks add their own (a shaking pattern for Stabilize, a moving pattern for Slow motion).
    - **Standard sounds,** from a fixed formula: tones at 8, 44.1 and 48 kHz, mono and stereo; silence; bursts with gaps; a tone that clips past ±1; a noisy tone (a sine plus `numpy.random.default_rng(0)` noise) shorter and longer than 600,000 samples.
    - **The case set,** per class: every widget at its default; each numeric widget at its min, its max and one value between, one at a time; every option; both booleans; each standard input; every case where Python raises.
    - Small cases record float32 output as base64. Large ones record sha256 of the float32, of its round-8 and of its trunc-8 bytes, plus the band list (rule 5).
14. **Tests** go in `frontend/tests/unit/runner-media-<g>.unit.spec.ts`, with shared helpers in `tests/unit/__runner__/mediaEffectsParity.ts` (R6.1). For every fixture case:
    - the core, called on this thread, gives Python's float32 by its parity class;
    - through the node's plan with the kit (its family on), the kept batch decodes to Python's round-8 (or trunc-8, rule 4) frames, and the preview to Python's;
    - the ui equals Python's, and a Python raise is the runner's plain words.

    Plus, per task: with the family off, a workflow with the class is left to the engine and `nodesNeedingEngine` names it; the rule 12 invariant; the effect → Create video → Save video saves Python's frames (judged as R5 rule 3); Stop mid-effect leaves no process and no kept file. A spec that needs the real tools calls `requireMediaTools()` (R5 rule 10: it fails, never skips).
15. **Every task's run line:**
    - `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_media_fixtures.py --group <g>`, twice; the second time `git diff --stat` shows the group's file unchanged.
    - `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-media-<g>.unit.spec.ts tests/unit/runner-`.
    - The typecheck from the Global Constraints, with `server/media` added to its grep.
    - Report (no commit).

---

### Task R6.1: The frame-effect machinery, with three pilots (family `video-time`)

Builds everything R6.2–R6.8 share, and proves it on three effects that stress its three ways of reading frames: Trim (one at a time), Reverse (every frame held) and Frame trail (a state carried between frames).

**Port (pilots):**

| Class | Python | Behaviour | Reads |
|---|---|---|---|
| VideoTrim | `nodes_video_effects.py:323-348` | `s = max(0, min(T, int(start)))`; `e = T` if `end < 0` else `max(s, min(T, int(end)))`; frames `[s, e)`, or `frames[:1]` when that is empty (quirk kept) | stream (a frame outside the range is decoded and dropped) |
| VideoReverse | `:287-315` | `reverse`: `flip`. `ping_pong`: the frames, then the reversed frames without the two end frames (`T ≤ 2`: all of them reversed). Selection only: exact | held (all) |
| FrameTrail | `:61-117` | `T ≤ 1`: unchanged. Else frame 0 as it is; per frame `acc = acc · d`; with `threshold > 0`, `lum = 0.2126·r + 0.7152·g + 0.0722·b` (each product rounded, then `(p0 + p1) + p2`, as R2.1's `luma709`), `acc = max(acc, frame · (lum > t))`; else `max(acc, frame)`; `trail = acc · intensity`; screen `1 − (1 − cur)(1 − trail)`, add `cur + trail`, or max; clamp. Exact | stream, `acc` carried |

**Files:**
- Modify `scripts/runner_effect_rows.py` (`--media`: the R6 classes and their families) and create `frontend/shared/runner/mediaEffectSchemas.generated.ts` (generated, not hand-edited).
- Create `frontend/shared/runner/mediaEffects.ts`: `MEDIA_EFFECT_FAMILY_OF`, `mediaEffectRows()`, `FRAMES_OUTPUTS`, `FRAME_ENCODERS`, `MEDIA_EFFECT_OUTPUT_KINDS`.
- Modify `frontend/shared/runner/families.ts`:
  - the nine families of the table above, added to `MEDIA_TOOL_FAMILIES` (so they are off while the tools are missing, and every "every family on" set written before R6 stays as it was, as R5 rule 8 did);
  - `FAMILY_REQUIRES`: the `video-*` families need `media-video`, the `sound-*` families `media-sound`;
  - `parseFamilies` drops families until nothing changes, and `familyOn` follows the chain. Today one pass can keep a family whose requirement is dropped later in the same pass.
- Modify `frontend/shared/runner/eligibility.ts`: spread `mediaEffectRows()` into `RUNNER_NODE_RULES` and `SWITCHED_CLASSES`; `outputKindsFor` applies `MEDIA_EFFECT_OUTPUT_KINDS` only while each class's family is on; Create video's `images` and Save video frames' `frames` gain `linkSources: FRAMES_OUTPUTS`.
- Modify `frontend/shared/runner/validate.ts` (`RUNNER_OUTPUT_CLASSES`).
- Modify `frontend/shared/runner/media.ts`: `MediaCaps` gains `heldFrameBytes`, `effectSoundSamples` and `effectWork` (ruling (i)), and `MEDIA_LEASE_PROCESSES = 3`.
- Modify `frontend/server/media/run.ts`: `mediaLease`, and `MediaJob.lease`.
- Modify `frontend/server/media/values.ts`: `framesOf`, `framesSink`, `heldFrames`.
- Modify `frontend/server/runner/keptBytes.ts` and `engine.ts`: `release` (ruling (j)).
- Create `frontend/server/runner/video/table.ts`, `shapes.ts`, `start.ts`, `plan.ts`, `cores.ts`, and `frontend/server/runner/video/core/time.ts` (the pilots; it grows in R6.2).
- Modify `frontend/server/runner/compositor/worker.ts`: `workerScript` composes the video cores from their source text (the esbuild guard in `runner-compositor-engine.unit.spec.ts` covers them); a new op `vfx.frame`, and `PixelsWorker.videoFrame`.
- Modify `frontend/server/runner/executors.ts` (dispatch to `planVideoEffect`) and the start-of-take hook beside `frameStartProblems`.
- Modify `scripts/runner_media_fixtures.py` (the shared R6 helpers of rule 13, the synthetic graphs of rule 12, group `vfx-time` with the pilots).
- Create `frontend/tests/unit/__runner__/mediaEffectsParity.ts`.
- Tests: `runner-media-vfx-machinery.unit.spec.ts` (stand-in classes, no tools needed) and `runner-media-vfx-time.unit.spec.ts`.

**Interfaces:**
```ts
// shared/runner/mediaEffects.ts
export type MediaEffectFamily =
  | 'video-time' | 'video-join' | 'video-look' | 'video-stabilize' | 'video-flow' | 'video-draw' | 'video-text'
  | 'sound-effects' | 'sound-denoise'
export const MEDIA_EFFECT_FAMILY_OF: Readonly<Record<string, MediaEffectFamily>>
/** Rule 1's rows, from the generated schemas. */
export function mediaEffectRows(): Record<string, RunnerNodeRule>
/** Every (class, slot) that makes a frame batch; each is taken only while its own family is on. */
export const FRAMES_OUTPUTS: readonly (readonly [string, number])[]
/** The classes that only encode a batch they read (rule 4: their batches are kept as trunc-8). */
export const FRAME_ENCODERS: readonly string[]   // CreateVideo, SaveVideoFrames
export const MEDIA_EFFECT_OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>>

// server/media/run.ts
export interface MediaLease { readonly userId: string | null; readonly signal?: AbortSignal; readonly live: boolean }
/** One of the person's media slots for a node, taken once; up to MEDIA_LEASE_PROCESSES tool processes run under it. Ending it kills every one. */
export function mediaLease<T>(o: { userId: string | null; signal?: AbortSignal }, job: (lease: MediaLease) => Promise<T>): Promise<T>
// MediaJob gains: lease?: MediaLease   (the job runs in the lease's slot instead of taking its own)

// server/media/values.ts
type FramesValue = Extract<RunnerValue, { kind: 'frames' }>
/** A kept batch's frames in order, rgb24, one decode job under the lease (R5.2 readFrames as an iterator). */
export function framesOf(v: FramesValue, io: MediaValueIO, lease: MediaLease): AsyncIterable<Uint8Array>
/** A new batch written frame by frame (one FFV1 job under the lease), kept on `done`, removed on `abort`. */
export function framesSink(w: number, h: number, io: MediaValueIO, lease: MediaLease): {
  put(rgb: Uint8Array): Promise<void>; done(): Promise<FramesValue>; abort(): Promise<void>
}
/** Every frame of a batch in memory (8-bit), refused past `maxBytes` before any decode. */
export function heldFrames(v: FramesValue, io: MediaValueIO, lease: MediaLease, maxBytes: number): Promise<Uint8Array[]>

// server/runner/video/table.ts
export interface FrameShape { count: number; w: number; h: number; exact: boolean }   // exact: false = an upper bound
export interface SoundShape { rate: number; channels: number; samples: number; exact: boolean }   // R6.9's sound start pass
export interface VideoEffectSpec {
  family: MediaEffectFamily
  /** The worker op run once per output frame: '<core>.<fn>'. */
  op: string
  /** The frame-batch inputs, in order ([] for a generator). */
  inputs: readonly string[]
  reads: 'stream' | 'window' | 'held' | 'two-pass' | 'generator'
  shape(widgets: Record<string, unknown>, ins: readonly FrameShape[]): FrameShape
  /** 8-bit frames held at once (rule 6), for the start pass. */
  heldBytes(widgets: Record<string, unknown>, ins: readonly FrameShape[]): number
  /** Pixel·steps, against MEDIA_CAPS.effectWork. */
  work(widgets: Record<string, unknown>, ins: readonly FrameShape[], out: FrameShape): number
  /** Writes live_preview_<id>.png of frame T // 2 (rule 9). */
  preview: boolean
}
export const VIDEO_EFFECTS: Readonly<Record<string, VideoEffectSpec>>

// server/runner/video/shapes.ts
/** Every frame batch's shape through the workflow, keyed `${nodeId}:${slot}`, from the sources' probes and the widgets. */
export function frameShapes(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  sourceShape: (nodeId: string, classType: string) => Promise<FrameShape | null>): Promise<Map<string, FrameShape>>

// server/runner/video/start.ts
/** Rule 3: the first node the runner can't take here, as { engine: true }; null when all can run. */
export function mediaEffectStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: {
  hosted: boolean; shapes: Map<string, FrameShape>; sounds?: Map<string, SoundShape>
}): Promise<{ message: string; nodeId: string; classType: string; engine: true } | null>

// server/runner/video/plan.ts
export function planVideoEffect(ctx: PlanContext): NodePlan
/** Rule 4: 'trunc' when every reader of this slot is in FRAME_ENCODERS, else 'round'. */
export function framesQuantOf(prompt: ApiPrompt, nodeId: string, slot: number, families: ReadonlySet<RunnerFamily>): 'trunc' | 'round'

// compositor/worker.ts
videoFrame(job: {
  op: string; params: Record<string, unknown>
  index: number; count: number                   // the output frame's index and the batch's count
  inputs: { rgb: Uint8Array; w: number; h: number }[]  // the frames this output frame reads (transferred)
  state?: ArrayBuffer                             // carried between frames (transferred both ways)
  quant: 'round' | 'trunc'; preview: boolean
}): Promise<{ rgb: Uint8Array; w: number; h: number; state?: ArrayBuffer; preview?: Uint8Array }>
```

**Behaviour:**
- `planVideoEffect` reads the spec, takes one lease, and runs the frames through the worker by the spec's `reads`:
  - `stream`: frames in as they decode, one output each;
  - `window`: a sliding window of 8-bit frames;
  - `held`: `heldFrames`, under its limit;
  - `two-pass`: the batch decoded twice (Stabilize);
  - `generator`: no input.
- The output goes into `framesSink`; the preview is written from frame `T // 2`'s float, before it is quantised.
- `frameShapes` knows each source: Get video components (`pyFrameCount` and the probe's size), Load video frames (`loadFramesPick`, an upper bound), and each effect's `shape`. The Video card and made videos (`video` values) go through Get video components as today.
- **Letting go (ruling (j)).** When a node finishes, each `frames` or sound value it read whose readers have all finished is let go: `KeptBytes.release(runId, file)` removes the file, and its record is marked `released`. A restart that needs a released value runs its maker again (free, and the same bytes: every R6 result is a function of its inputs and widgets, seeds included).

**Fixtures (`vfx-time`, pilots):** rule 13's set for the three classes, including Trim with `end ≤ start` and past the end, and ping-pong with 1, 2 and 8 frames.

**Tests:**
- Machinery, with stand-in classes (the `vi.mock` pattern of `runner-value-results.unit.spec.ts`):
  - a two-input stand-in runs its decodes and its encode under one lease, while a second node of the same hosted person waits;
  - Stop mid-batch kills all three processes within 1 s and leaves no kept file (a spy on the process table);
  - a held effect over `heldFrameBytes`, and a chain whose kept total would pass the run's room, each leave the workflow to the engine before the run (no process started);
  - `framesQuantOf` is `trunc` only when every reader is an encoder;
  - `parseFamilies('video-time,media-video')` without `cards` gives nothing, and with `cards` both;
  - a picture wired into a video effect, and a video effect wired into Save image, leave the workflow to the engine;
  - a released value is made again after a restart, bit for bit;
  - rule 12's invariant.
- Pilots: rule 14.

**Acceptance:** the pilots pass every fixture case; Load video → Get video components → Reverse → Create video → Save video runs with ComfyUI off and saves Python's frames; the invariant holds.

---

### Task R6.2: Time effects (family `video-time`)

**Consumes:** R6.1; R2.2's `linspace`, `resizeBilinear` and sums (`rowSum`, `meanAll`); R2.3's generator.

**Port:**

| Class | Python | Behaviour | Reads | Class |
|---|---|---|---|---|
| TemporalMotionBlur | `nodes_video_effects.py:125-174` | `T ≤ 1`: unchanged. Weights over `2r + 1`: uniform ones; linear `1 − |i − r| / r` clamped; gaussian `exp(−x² / (2σ²))`, `σ = max(1, r / 2)`; divided by their sum. Time padded by repeating the end frames; each output the weighted sum over its window, in window order (torch's `sum(-1)` over `unfold`); clamp | window (`2r + 1` ≤ 25 frames) | library (`exp`, the sum's order). The weights are checked bit for bit against the fixture's first. |
| SlitScan | `:182-229` | `delay_per_step = delay · T / W` (horizontal) or `/ H`; `src = t + step · delay_per_step` in float32; `long()` then `% T` (wrap) or clamp; each pixel read from frame `src` | held (all) | exact |
| TimeDisplacement | `:237-279`, `_value_noise_2d` `:38-54` | `T ≤ 1` or `strength ≤ 0`: unchanged. Noise: `torch.Generator().manual_seed(seed & 0x7FFFFFFF)`, `rand(1, 1, max(2, int(h / max(1, scale))), max(2, int(w / …)))`, bilinear up (`align_corners=False`); `offset = (n·2 − 1) · strength`; `src = t + offset`, `round()` (half to even), then `% T` or clamp | held (all) | exact |
| SpeedRamp | `nodes_video_pro.py:59-130`, `_ease` `:38-44` | `constant`: `N = max(1, int(round(T / r)))`, `src = linspace(0, T − 1, N)`. Ramps: `K = 4096`, `u = linspace(0, 1, K)`, the ease, `rate = r0 + (r1 − r0)·ease`, `N` from `rate.mean().item()` in Python doubles, `cumsum` (torch adds in double and rounds each step to float32, measured 2026-09-30), scaled to end at `T − 1`, sampled at `linspace(0, K − 1, N)` by lerp, clamped. `nearest`: `round()` half to even; `blend`: `frames[lo]·(1 − f) + frames[hi]·f`; clamp | window (the source index only grows: two frames) | exact (`constant`); library (ramps: `cos`, the mean). `N` and every source index must equal Python's (the fixture records them). |

- Held effects check `T·w·h·3 ≤ heldFrameBytes` in the start pass.
- Slit scan's source can lie anywhere in time, so each output frame reads from up to `W` (or `H`) different frames: it is computed with every frame held, not streamed.

**Files:** modify `video/core/time.ts`, `video/table.ts`, `scripts/runner_media_fixtures.py` (group `vfx-time` grows). Test: `runner-media-vfx-time.unit.spec.ts`.

**Fixtures (`vfx-time`):** rule 13, plus Speed ramp at every mode with `speed` 0.05 / 1 / 10 and `start_speed` 0.05 / 10; Slit scan with `delay` 0 and 4, both axes, wrap on and off; Time displacement at `noise_scale` 8 and 400 and seeds 0 and 2³¹ − 1.

**Test:** rule 14, plus: Speed ramp's `N` and source indices equal Python's in every case; Slit scan's memory stays under `heldFrameBytes` (a spy on `heldFrames`).

**Acceptance:** every fixture case passes by its class.

---

### Task R6.3: Joining two clips (family `video-join`)

**Consumes:** R6.1; R2.2's `resizeBilinear`, `affineGrid`, `gridSample`, `conv2dSame`; R2.3's generator.

**Port:**

| Class | Python | Behaviour | Class |
|---|---|---|---|
| VideoCrossfade | `nodes_video_effects.py:356-421` | Trims first: `ia = max(0, min(trim_in_a, Ta − 1))`, `oa = Ta` if `trim_out_a < 0` else `max(ia + 1, min(trim_out_a, Ta))`, the same for B. B resized to A's size (bilinear, `align_corners=False`) when they differ. `d = max(1, min(duration, Ta, Tb))`; `alpha = linspace(0, 1, d)` then the curve (`ease_in_out` `0.5 − 0.5·cos(α·π)`, `ease_in` `α²`, `ease_out` `1 − (1 − α)²`); A's head, the blend `a·(1 − α) + b·α`, B's tail; clamp | exact (`linear`, `ease_in`, `ease_out`); library (`ease_in_out`: `cos`) |
| Transition | `nodes_video_pro.py:810-948` | B resized to A's size as above (no trims). `d = max(1, min(duration, Ta, Tb))`, `alpha` by the curve (`_ease`). Styles: **dissolve** as Crossfade. **whip pan**: A shifted by `±2α`, B by `±2(α − 1)` (`affine_grid` + `grid_sample`, zeros), added, clamped, then a `1 × kw` box blur (`kw = max(1, int(15·float(α(1 − α))·4 + 1))`, made odd; `conv2d`, zero padding `kw // 2`). **zoom in / out**: A at `za`, B at `zb` (border), blended. **glitch**: from A while `t < 0.5`, else B; `intensity = 1 − |2t − 1|`; red rolled by `int(intensity·30)` and blue by minus that; `n = max(1, int(intensity·12))` bands of `H // n` rows, each rolled by `int((rand − 0.5)·intensity·80)` from the global generator (ruling (e)). **light leak**: dissolve plus a warm glow `exp(−(x² + y²)·2)` × `(1, 0.65, 0.25)` × `4α(1 − α)·0.6`. Then A's head, the transition, B's tail; clamp | exact (dissolve with exact curves, glitch under a seed); library (whip pan: `affine_grid`, `conv2d`; zoom; light leak: `exp`) |

- **Reading two clips.** A's first `Ta − d` frames stream straight out; A's last `d` frames are held (8-bit; `d ≤ 2400` for Crossfade, `≤ 240` for Transition, counted in `heldBytes`); then B streams, its first `d` frames blended with the held ones. Both decodes and the encode are one lease.
- **The glitch seed** is `glitchSeed(node)`: the first 8 bytes of the sha256 of the node's widget values and its two input batches' kept sha256, in order, fed to R2.3's generator. Python's `torch.rand(1)` calls come one per band, per frame, in order; the port draws the same sequence.

**Files:** create `video/core/join.ts`; modify `video/table.ts`, `cores.ts`, the script (group `vfx-join`). Test: `runner-media-vfx-join.unit.spec.ts`.

**Fixtures (`vfx-join`):** rule 13 with `clip8` and `clip6-small` in both orders (so B is resized both ways); every curve and style; `duration` 1, 3 and past both lengths; Crossfade's trims at their edges; glitch under three seeds.

**Test:** rule 14, plus: glitch under the fixture's seeds equals Python exactly; with `glitchSeed` the output is the same on a rerun and changes when a widget changes; memory stays under `heldBytes`.

**Acceptance:** every fixture case passes by its class; ruling (e) is honoured.

---

### Task R6.4: Frame looks (family `video-look`)

**Consumes:** R6.1; R2.2's `affineGrid`, `gridSample`, `linspace`, `powScalar`, the sums; a new `gridSample3d`.

**Port:**

| Class | Python | Behaviour | Class |
|---|---|---|---|
| KenBurns | `nodes_video_pro.py:138-185` | `t = ease(linspace(0, 1, T))`; per frame `z`, `x`, `y` lerped; `theta = [[1/z, 0, 2x], [0, 1/z, 2y]]` (Python doubles into a float32 tensor); `affine_grid`, `grid_sample` bilinear, border; clamp | library (`affine_grid`; `cos` in `ease_in_out`) |
| AspectConvert | `:193-271` | `pad`: the enclosing size at the target ratio (`int(round(W / ar))` or `int(round(H·ar))`, Python's round), the colour by `_hex_rgb` (`:26-35`), the frame centred. `crop_center`: the centred crop. `auto_pan`: luma, each column's (or row's) variance over the other axis (`var`, unbiased), a box average of the crop's width (`conv1d`), the first highest (`argmax`) as the crop's left (or top) edge | exact (`pad`, `crop_center`); band (`auto_pan`: the chosen edge must equal Python's except flagged cases) |
| ChromaKey | `:279-368` | `_rgb_to_hsv` (`:311-330`); hue distance with wrap, `dist = dh·0.7 + ds·0.3`; `keep` a clamped ramp between `tolerance ± smoothness`; spill: where `(1 − keep)·spill > 0.01`, `frames − frames·spill·key`, clamped; the picture `frames·keep + bg·(1 − keep)`. The mask output isn't kept (ruling (l)); the preview is the picture | exact |
| LUT | `:474-579` | `(none)` or empty: unchanged. `_load_cube_lut` (`:474-509`): lines stripped, `#` comments skipped, `LUT_3D_SIZE`, `DOMAIN_MIN`/`DOMAIN_MAX` read but unused, `TITLE` and `LUT_1D_SIZE` skipped, rows of three floats (Python's `float()`), count must be `size³`. A file that won't load leaves the frames unchanged, with the preview (quirk kept, logged). The grade: `grid_sample` over the `[b][g][r]` volume, trilinear, `align_corners=True`, border, at `(r, g, b)·2 − 1`; `strength < 0.999` lerps; clamp | exact if torch's 3D formula order is reproduced (the implementer checks for fused multiply-adds, as R2.2 did), else library |
| ThreeWayCC | `:587-624` | `(image·gain + lift).clamp(min=0)`, `.pow(1 / gamma.clamp(min=0.05))` per channel, clamp | library (`pow` with a tensor exponent) |

- LUT's file: `lut_file` is a named input file (rule 8). In hosted, a LUT whose `LUT_3D_SIZE` is over 65 or whose file is over 16 MiB leaves the workflow to the engine (ruling (p)); locally there is no limit, as in Python.
- 3-way color's input is named `image`. It reads a `frames` value only; a still picture wired into it leaves the workflow to the engine (ruling (k)).
- Aspect convert can make an odd width or height; a later Save video then fails as Python does (R5.4).

**Files:** create `video/core/look.ts`; add `gridSample3d` to `effects/core/kernels.ts`; modify `video/table.ts`, `cores.ts`, `inputs.ts` (`collectInputFiles`: LUT's `lut_file`), the script (group `vfx-look`, with three small `.cube` files it writes: identity 2³, a warm grade 17³ with `DOMAIN_*` lines and comments, and a broken one). Test: `runner-media-vfx-look.unit.spec.ts`.

**Fixtures (`vfx-look`):** rule 13, plus every target and method of Aspect convert on `clip8` and on a tall `clip8` rotated; Chroma key with a green-screen `synth` frame at the tolerance and smoothness edges; each LUT file at strength 0, 0.5 and 1.

**Test:** rule 14, plus: a `../grade.cube` name is refused by its name in hosted (no disk access, a spy); another person's LUT is refused before the run; a broken LUT hands the frames on unchanged with Python's preview; Chroma key with its mask wired leaves the workflow to the engine.

**Acceptance:** every fixture case passes by its class.

---

### Task R6.5: Stabilize, and the shared FFT (family `video-stabilize`)

The FFT built here is reused by R6.7 (Audio waveform) and R6.10 (Audio denoise).

**Port:**

| Piece | Python | The runner |
|---|---|---|
| Stabilize | `nodes_video_pro.py:956-1057` | `T ≤ 1`: unchanged. **Pass 1:** `scale = max(1, max(H, W) // 256)`; luma; `avg_pool2d(kernel=scale)`; a Hann window (`periodic=False`) on both axes; per frame `fft2`, `R = f_cur · conj(f_prev)`, `R / (|R| + 1e-8)`, `ifft2(R).real`, the first highest (`argmax`) as `(dy, dx)`, wrapped past half, times `scale`. **Between:** the path is the running sum of the shifts in doubles; smoothed `s[i] = α·s[i − 1] + (1 − α)·p[i]`; `correction = s − p`. **Pass 2:** each frame shifted by `−correction` (`affine_grid`, `grid_sample`, border or zeros); `crop`: the centred `max(8, int(H·(1 − 2·pad)))` × `max(8, int(W·(1 − 2·pad)))`, bilinear back up to `H × W`; clamp |
| `torch.fft.fft2` / `ifft2` (complex64), `numpy.fft.rfft` (float32, numpy 2.4.3), `scipy.fft` (float64 and float32, scipy 1.17.1) | pocketfft, inside each library | `video/core/fft.ts`, self-contained so the worker can compose it: complex and real transforms of any length (passes of 2, 3, 4 and 5 and a general one, as pocketfft), in float64, and in float32 with each step rounded (`Math.fround`) in pocketfft's order |

- **Parity.**
  - Stabilize's shifts are integers: they must equal Python's in every fixture case. The fixture flags a case whose two highest correlation values lie within ε; that case is band (rule 5).
  - The warps are R2's kernels (library for `affine_grid`).
  - The FFT: float64 within 1e-12 relative of numpy and scipy; float32 within its measured ε. For the power-of-two real transforms R6.7 needs, the target is bit for bit; the report says whether it is.
- Stabilize reads its batch twice (`two-pass`), holding only the previous frame's transform between frames.

**Files:** create `video/core/fft.ts`, `video/core/stabilize.ts`; modify `video/table.ts`, `cores.ts`, the script (group `vfx-stabilize`: Stabilize cases, and direct FFT cases of lengths 1–64, 256, 1000, 1024, 4096 and 2-D 9 × 16, 144 × 256). Test: `runner-media-vfx-stabilize.unit.spec.ts`.

**Fixtures (`vfx-stabilize`):** rule 13, plus a shaking pattern: a textured `synth` frame shifted by a known, seeded path of whole pixels (12 frames at 96 × 64, and 12 at 600 × 338 so that `scale` is 2), both edge modes, `smoothing` 0, 0.85, 0.99, `crop_pad` 0 and 0.3.

**Test:** rule 14, plus: the recorded shifts equal Python's; the FFT cases meet their bounds.

**Acceptance:** every fixture case passes; the FFT report states its measured ε and whether the float32 power-of-two case is exact.

---

### Task R6.6: Slow motion by optical flow (family `video-flow`)

*Optical flow* is how far each pixel moved between two frames. Python's Slow motion measures it with OpenCV's Farneback method, then warps both frames halfway along it and blends them. R6.6 ports that method (ruling (d)). Its own family lets the controller keep this node with the engine if the port can't meet its bound, without holding back any other effect.

**Port:** `nodes_frame_interp.py:46-114` with OpenCV 4.13.0 (the installed `cv2`; its source read from github.com/opencv/opencv at tag 4.13.0, not installed):

| Step | Python / OpenCV | Notes |
|---|---|---|
| Frames to BGR | `_to_bgr` `:46-48`: `(x·255).clip(0, 255).astype(uint8)`, channels reversed | trunc; an 8-bit batch gives its frames back exactly |
| Grey | `cv2.cvtColor(BGR2GRAY)` | OpenCV's fixed-point weights (`imgproc/src/color_rgb.simd.hpp`): an integer formula, exact |
| Flow | `calcOpticalFlowFarneback(prev, next, None, 0.5, 3, 21, 3, 5, 1.2, 0)` (`video/src/optflowgf.cpp`) | Per level, coarsest first: Gaussian blur and bilinear resize of both frames to the level, the flow of the level above resized up, `FarnebackPolyExp` (each pixel's neighbourhood fitted with a quadratic, `poly_n = 5`, `σ = 1.2`), `FarnebackUpdateMatrices`, three rounds of `FarnebackUpdateFlow_Blur` (a 21 × 21 box average, since `flags = 0`). float32 throughout |
| Warp | `_warp` `:56-62`: maps `x + flow·α`, `remap(INTER_LINEAR, BORDER_REFLECT)` | OpenCV turns float maps into 1/32-pixel steps (`INTER_REMAP_COEF_BITS = 5`) and blends in integers: exact given the maps |
| Blend | `:103-107`: `warp_a·(1 − α) + warp_b·α` in float32, `astype(uint8)` | trunc; `flow_bwd = −flow_fwd` (Python's cheap reverse, kept) |
| Output | `:99-111`: `(T − 1)·m + 1` frames; `T < 2` or `m < 2`: unchanged | not an output node: no preview |

- **Parity (ruling (d)):**
  - the flow, per pixel, within 0.01 pixel of OpenCV's (measured; the report states the largest difference);
  - the output frames equal to Python's, except at pixels whose map coordinate ×32 lies within ε of a rounding edge (band, flagged by the fixture, which records the float maps' fractional parts).
  - If the flow can't be brought within 0.01 pixel, the report says so, and the family stays off: the node goes on using the engine.
- Two frames are held at a time (`window`); the output is `(T − 1)·m + 1` frames, which the start pass checks against the batch caps (a 600-frame clip at ×8 is 4,793 frames).

**Files:** create `video/core/flow.ts` (the Gaussian blur, the resize, the polynomial expansion, the update steps, the remap tables), modify `video/table.ts`, `cores.ts`, the script (group `vfx-flow`). Test: `runner-media-vfx-flow.unit.spec.ts`.

**Fixtures (`vfx-flow`):** a textured pattern moved by a whole-pixel shift, a half-pixel shift, a small turn and a zoom (pairs at 64 × 48 and 160 × 120), plus `clip8`; `multiplier` 2, 3 and 8. Each case records the flow (float32, base64 for the small ones), the maps' band list and the frames.

**Test:** rule 14, plus the flow bound on every pair.

**Acceptance:** the flow bound holds and the frames pass by band; or the report explains why not, and the family is left off.

---

### Task R6.7: Made clips — animated noise and the audio waveform (family `video-draw`)

**Consumes:** R6.1, R6.5 (the float32 FFT), R2.2, R2.3; R5.6's native-format sound decode (`thumbnails.ts` `flatLayout`).

**Port:**

| Class | Python | Behaviour | Class |
|---|---|---|---|
| AnimatedNoise | `nodes_video_effects.py:429-509` | `max_pan = max(1, int(T·speed) + 1)`; one noise texture of `(H + max_pan) × (W + max_pan)` by `_value_noise_2d` (as R6.2); colours by its own `parse_hex` (`:475-484`: no `or ""`, fallback on any length but 3 or 6); per frame the window's offset by `motion` (`int()` of Python doubles, `sin`/`cos` for `breathe` and `swirl`), clamped; `dark·(1 − n) + light·n`; clamp | exact; band on the `breathe`/`swirl` offsets (an `int()` of a `sin` or `cos`) |
| AudioWaveform | `nodes_video_pro.py:632-802` | See below | band (bar heights); exact (drawing) |

- **Animated noise's texture** can be large (`T = 600`, `speed = 20`, 2048 wide: about 14,000² floats). It counts in `heldBytes` as float32, and the start pass sends a case over the limit to the engine.
- **Audio waveform, step by step:**
  1. **The file.** `audio_file` is a named input file (rule 8). `(no audio found)`, a missing file, or one that won't decode gives a silent track of `int(T / fps · 48000)` samples. A decode error after the rate was read keeps that rate (quirk kept).
  2. **The samples.** The first sound stream, frame by frame, in its own format. A planar frame (one row per channel) is averaged over its rows. A packed frame is one row of interleaved samples, used as it is (quirk kept: stereo is drawn interleaved, ruling (g)). Everything is cast to float32. When the largest magnitude is over 2 (integer formats), all are divided by it.
  3. **Bands.** `samples_per_frame = max(1, int(rate / fps))`. For each frame's window of at least 8 samples:
     - `n = 1 << max(8, (len − 1).bit_length())`;
     - `rfft` in float32 (numpy 2.4.3 keeps float32), and its magnitudes;
     - band edges `geomspace(1, bins, K + 1).astype(int)`;
     - each band's mean in float32, summed in numpy's pairwise order;
     - divided by the frame's peak, times `sensitivity`, smoothed `cur·(1 − s) + prev·s`.

     A window under 8 samples decays the previous bands.
  4. **Drawing** on an 8-bit RGB frame, with Pillow 12.1.1's integer drawing (source read from github.com/python-pillow/Pillow at tag 12.1.1, `src/libImaging/Draw.c`):
     - `bars` and `mirrored_bars`: `rectangle`;
     - `wave`: a `line` of width 3 through integer points every 2 pixels;
     - `dots`: two `ellipse`s per band;
     - `radial`: width-3 `line`s whose float ends Pillow truncates to integers (measured 2026-09-30).

     Heights are `int(energy · H·0.85)` (or `·0.4`), float32 × a Python float.
- **Parity (ruling (g)):**
  - the band energies within their measured float32 ε of Python's;
  - every bar height, dot position and line end equal to Python's, except flagged cases where Python's float lay within ε of a whole number (band);
  - the drawn pixels exact, given those numbers.

  The frames are exactly 8-bit (`/ 255` of drawn bytes), so they are kept as they are.
- Audio waveform is a generator of `frame_count` frames at `width × height`: the start pass checks the batch caps from the widgets alone.

**Files:** create `video/core/draw.ts` (Pillow's rectangle, wide line, polygon fill and ellipse), `video/core/waveform.ts`, `video/core/noiseClip.ts`; modify `video/table.ts`, `cores.ts`, `inputs.ts` (Audio waveform's `audio_file`), the script (group `vfx-draw`). Test: `runner-media-vfx-draw.unit.spec.ts`.

**Fixtures (`vfx-draw`):**
- Animated noise at each motion, `speed` 0 / 2 / 20, at 64 × 64 with 8 frames (and one 256 × 144 case hashed).
- Audio waveform at each style over R5's standard sounds (mono MP3, stereo s16 and s32 WAV, FLAC 24-bit, the 75-second 8 kHz WAV, the −32768 WAV), `bar_count` 4 / 64 / 512, `fps` 1 / 30 / 120, and a missing file.
- Pillow's drawing primitives on their own: rectangles, width-3 lines at every octant, ellipses from 2 × 2 to 64 × 40.

Each case records the energies (float32), the heights, the edges and the frames.

**Test:** rule 14, plus: the drawing primitives equal Pillow's byte for byte; the packed stereo WAV is drawn interleaved, as Python; another person's `audio_file` is refused before the run.

**Acceptance:** every fixture case passes by its class.

---

### Task R6.8: Text on video — Text clip and Caption track (family `video-text`)

Both draw text with Pillow's `ImageDraw.text`, which uses FreeType (a font engine) to turn letter outlines into pixels. Node has no FreeType, and no new dependency may be added. R6.8 therefore reads fonts with `fontkit` (already a dependency), places every letter exactly where Pillow places it, and fills each letter's outline with a small coverage rasteriser (it turns an outline into pixels by the share of each pixel it covers, the method FreeType's own renderer uses). Layout is exact; letter edges are "visually equal" (ruling (c)).

**The font (ruling (b)).** The runner follows `_FONT_PATHS` (`nodes_text.py:16-34`) in order and uses the first file that exists and loads, as Python does: Helvetica (`/System/Library/Fonts/Helvetica.ttc`, face 0) on this Mac, DejaVu Sans Bold on a Linux machine that has it. Where none exists (the Fly image), it uses a bundled copy of DejaVu Sans Bold, not Pillow's 10-pixel fallback. The copy comes from matplotlib's inside `.venv` (`mpl-data/fonts/ttf/DejaVuSans-Bold.ttf`, 704,128 bytes, with `LICENSE_DEJAVU` beside it): nothing is downloaded. Hosted runs never read system font paths; they use the bundled file.

**Port:**

| Piece | Python | Behaviour |
|---|---|---|
| Layout | Pillow 12.1.1, basic layout (no raqm, measured 2026-09-30), `ImageFont.FreeTypeFont.getbbox` / `getlength`, `ImageDraw.textbbox` / `text` (`ImageDraw.py:538-660`) | Each letter at the pen position FreeType's hinted advances give (whole pixels), with kerning; `textbbox((0, 0), s)` as Pillow's anchor `la`; `draw.text((x, y))` with a fractional `(x, y)`: the whole part places the mask, and the fractional part is the start offset Pillow hands FreeType (`ImageDraw.py:603`) |
| Letters | FreeType's hinted outline rendered to an 8-bit coverage mask | fontkit's outline at the same size and start offset, filled by coverage (visual, ruling (c)) |
| Ink | `draw_bitmap(coord, mask, ink)` | Pillow's integer blend of the ink over the frame by the mask (`libImaging/Paste.c`'s `fill_mask_L`): exact given the mask |
| TextClip | `nodes_text.py:67-165` (`render_text_to_pil` `:67-120`, `_wrap` `:49-64`) | Background colour; inset `int(W·padding)`, `int(H·padding)`; words wrapped by `textbbox` width `≤ max_w` (or when the line is empty); line height `(bbox("Ag")[3] − bbox("Ag")[1]) · line_spacing`; block placed by `v_align`, each line by `align`; one frame, repeated `frame_count` times (the FFV1 writer is handed the same frame; it compresses to almost nothing). Not an output node: no preview |
| CaptionTrack | `nodes_video_pro.py:375-466` | Lines `start end Text…` (`split(None, 2)`, `int()`; others skipped); no captions: unchanged. Frames to 8-bit (trunc); for each frame the **last** caption with `s ≤ i < e`; `x = (W − tw)/2 − bbox[0]`; `y` by position and `y_inset`; with `outline_width > 0`, the text drawn at every `(dx, dy)` with `dx² + dy² ≤ ow²`, in Python's loop order, in the outline colour; then the text; colours `int(c·255)` of `_hex_rgb`. Frames without a caption pass through (8-bit, so unchanged). Preview as rule 9 |

- **What must be exact:** the font chosen, every advance, kerning pair and box Pillow reports (the fixture records `getbbox`, `getlength` and `textbbox` for every printable ASCII letter, common accented letters, a missing letter, and each fixture line, at sizes 8, 12, 44, 72, 256), line breaks, each line's `(x, y)`, the outline offsets and the drawing order.
- **What is visual (ruling (c)):** the coverage of each letter's pixels.
- The fixture script also runs both classes with `_FONT_PATHS` pointed at the bundled DejaVu file (a fixture-only patch; Python product code is untouched). That is the case for Linux and hosted, where the runner's font differs from Pillow's fallback on purpose.
- Caps: Text clip's `frame_count` (up to 10,000) at up to 4096² meets R5's batch caps in the start pass; Caption track reads and writes one frame at a time.

**Files:**
- Create `frontend/server/runner/video/fonts/DejaVuSans-Bold.ttf` and `LICENSE_DEJAVU` (copied from `.venv`; the report gives the file's sha256).
- Create `video/core/glyphs.ts` (the coverage rasteriser), `video/text.ts` (font choice and layout with fontkit, on the main thread; the worker receives the letters' outlines and positions) and `video/core/textDraw.ts` (Pillow's ink blend).
- Modify `video/table.ts`, `cores.ts`, and the script (group `vfx-text`).
- Test: `runner-media-vfx-text.unit.spec.ts`.

**Fixtures (`vfx-text`):**
- Text clip: short and long text (wrapped), each `align` and `v_align`, `font_size` 8 / 72 / 512, `padding` 0 and 0.4, `line_spacing` 0.8 and 2.5, accented letters, an emoji (a missing letter), empty text.
- Caption track: the default captions over `clip8`, overlapping captions, malformed lines, each position, `outline_width` 0 / 2 / 12, `font_size` 8 / 44 / 256.
- Each with this Mac's font and with the bundled one.

**Test:**
- The metrics above equal Pillow's for both fonts.
- Layout equals Python's: line breaks, positions, and the set of pixels any letter touches, to within one pixel of its box.
- Pixels meet ruling (c)'s measure.
- In hosted, the bundled font is used even where a system font exists (a spy on the file reads).

**Acceptance:** every case meets the exact parts and ruling (c)'s measure; the controller's look at a side-by-side (R6.11).

---

### Task R6.9: Sound effects and Silence cut (family `sound-effects`), and Save audio (Opus) (`media-sound`)

Builds the sound side of the machinery and ports the twelve deterministic sound classes.

**Machinery:**
- `SOUND_OUTPUTS` (R5.3) gains each class's sound slots (Split audio channels 0 and 1, Silence cut 1), each taken only while its family is on.
- A sound start pass (`soundShapes`, beside `frameShapes`): each sound's rate, channels and length (an upper bound where only the header's duration is known), from the probes and the widgets, through the chain. A node whose sounds together pass `effectSoundSamples` (ruling (i)), or whose output would pass R5's `soundSamples`, leaves the workflow to the engine (rule 3).
- Sounds are read with `readSound` (R5.2: by their note) and kept with `keepSound` (`'exact'`). Heavy work (a filter over one channel, the envelope of a long sound) runs on the worker (`sfx.*` ops, composed into `workerScript`), a channel or a block per call, the arrays transferred.
- A rate change uses R5.3's `resampleLikeTorchaudio` (library, within 1e-6 of torchaudio).

**Port:**

| Class | Python | Behaviour | Class |
|---|---|---|---|
| TrimAudioDuration | `nodes_audio.py:468-519` | `start < 0` counts from the end; `int(round(x·rate))` (half to even); start clamped to `[0, N − 1]`, end to `[0, N]`; start ≥ end raises → "The trim’s start must be before its end, inside the sound" | exact |
| SplitAudioChannels | `:521-551` | exactly 2 channels, else raises → "This needs a stereo sound to split" | exact |
| JoinAudioChannels | `:554-603`, `match_audio_sample_rates` `:607-619` | both mono, else raises → "Both sounds must be mono to join them"; the lower rate resampled up; the longer trimmed | exact (same rate); library (resampled) |
| AudioConcat | `:622-667` | mono made stereo by repeating; rates matched; `after` or `before` | exact / library as above |
| AudioMerge | `:670-728` | rates matched; the second trimmed or padded with zeros to the first's length; add, subtract, multiply, or mean `(a + b) / 2`; divided by the largest magnitude when it is over 1 | exact / library as above |
| AudioAdjustVolume | `:731-764` | 0: the input handed on; else `× f32(10 ** (v / 20))` | exact |
| EmptyAudio | `:767-810` | zeros, `channels × int(round(duration·rate))` | exact |
| AudioEqualizer3Band | `:813-871` → torchaudio 2.10.0 `bass_biquad`, `equalizer_biquad`, `treble_biquad`, `lfilter` (`.venv/…/torchaudio/functional/filtering.py:244-335, 630-671, 1010-1084, 1346-1396`) | Each band only when its gain isn't 0. A *biquad* is a small two-step filter; its coefficients are computed in float32 torch operations; `lfilter` runs the forward part as a 3-tap `conv1d`, then the feedback loop (torchaudio's compiled `_lfilter_core_loop`, available here), then clamps to [−1, 1] (quirk kept: the EQ clips) | library |
| AudioFade | `nodes_audio_effects.py:22-77` | `n_in = min(int(round(fade_in·rate)), N)`, the same for out; ramps `linspace(0, 1, n)` (reversed for out), `linear` as is, `equal_power` `sin(t·π/2)`, `exponential` `t²`; both multiply one envelope; both 0 or an empty sound: handed on | exact (`linear`, `exponential`); library (`equal_power`) |
| AudioNormalize | `:80-119` | peak `abs().max()`, or RMS `pow(2).mean().sqrt()`; ≤ 1e-9: handed on; `× f32(10 ** (db / 20) / current)` | exact (peak); library (RMS: torch's summation order, R2.2's `sumAll`) |
| AudioDuck | `:122-210` | sidechain matched to the rate by nearest sample (`linspace(…).round()`); its envelope `abs().mean` over batch and channels, padded or cut to the sound's length; a one-pole follower in Python doubles with `a_attack`, `a_release` from float32 `exp`; `20·log10`, the ramp to `depth_db`, `10 ** (gain / 20)`; multiplied | library |
| VideoSilenceCut | `:213-326` | frames and sound; the per-sample mean of `|x|` over channels; a 20 ms moving average (`conv1d`, zero padding `win // 2`); `20·log10 > threshold` marks loud samples; silent runs shorter than `min_silence_ms` are absorbed; each loud run padded by `keep_padding_ms`; overlapping ranges merged; the sound sliced by samples, the frames by `round(s / rate · fps)` (half to even). Nothing loud: the first frame and the first sample. The `fps` widget is trusted (quirk kept). Outputs: a batch and a sound | band (the loud mask: flagged samples where Python's level lay within ε of the threshold); exact given the ranges |
| SaveAudioOpus | `nodes_audio.py:210-235` → `get_save_audio_ui(format='opus')` | R5.3's `saveAudioFiles` in Opus at `quality` (`64k`–`320k`), with R5.3's resample to an Opus rate; family `media-sound` (ruling (o)) | as R5.3 |

- Silence cut streams its frames: the ranges come from the sound first, then the batch is read once, and the frames outside the ranges are dropped. Its output count is at most its input's (an upper bound in the start pass).
- Every class hands on a sound of batch 1, as the runner's sounds are. A Python raise is mapped to the plain words above.

**Files:** create `frontend/server/runner/media/soundEffects.ts` (plans), `frontend/server/runner/video/core/sound.ts` (the worker's sound ops) and `frontend/server/runner/video/soundShapes.ts`; modify `eligibility.ts` (`SOUND_OUTPUTS`, rows), `soundNodes.ts` (Save audio (Opus) plan), `shared/runner/mediaEffects.ts`, `cores.ts`, `executors.ts`, `validate.ts`, the script (group `sfx`). Test: `runner-media-sfx.unit.spec.ts`.

**Fixtures (`sfx`):** rule 13's sounds through every class; every combo; the gains, frequencies and `Q` of the EQ at their edges; rates 8 kHz against 48 kHz for the matching classes; Silence cut on bursts with gaps at `threshold_db` −80 / −40 / 0, `min_silence_ms` 20 / 300 / 5000 and `keep_padding_ms` 0 / 80 / 2000, and on silence; Save audio (Opus) at each quality from 44.1 kHz and 48 kHz.

**Test:** rule 14 (samples by class; Silence cut's ranges by band; the Opus file as R5 rule 3), plus: a chain Load audio → Fade → Normalize → Save audio runs with ComfyUI off; a sound over `effectSoundSamples` leaves the workflow to the engine before the run; each Python raise gives its words.

**Acceptance:** every fixture case passes by its class.

---

### Task R6.10: Noise removal (family `sound-denoise`)

*Spectral gating* turns down the parts of a sound's spectrum that a noise profile marks as noise. Python's Audio denoise calls noisereduce 3.0.3 for it. R6.10 ports that library's two methods (ruling (f)).

**Port:** `nodes_audio_denoise.py:18-63`, then noisereduce (`.venv/lib/python3.12/site-packages/noisereduce/`):

| Piece | Source | Behaviour |
|---|---|---|
| Entry | `noisereduce.py:13-163` | `reduce_noise(y = waveform[0] as float32, sr, stationary, prop_decrease = strength)`, with the defaults: `n_fft 1024`, window = `n_fft`, hop 256, `chunk_size 600000`, `padding 30000`, `freq_mask_smooth_hz 500`, `time_mask_smooth_ms 50`, `n_std_thresh_stationary 1.5`, `thresh_n_mult_nonstationary 2`, `sigmoid_slope_nonstationary 10`, `time_constant_s 2.0`, `clip_noise_stationary True`. `strength ≤ 0` or an empty sound: handed on |
| Chunks | `spectralgate/base.py:131-226` | Up to 600,000 samples: one chunk. Longer: chunks of 600,000, each read with 30,000 samples either side (zeros past the ends), filtered on its own, and its middle kept. Output cast to float32 |
| Smoothing filter | `base.py:7-29, 99-128` | `n_grad_freq = int(500 / (sr / 512))`, `n_grad_time = int(50 / (256 / sr · 1000))`; the outer product of two triangles, divided by its sum; a rate where either is under 1 raises (a plain message, "This sound’s sample rate is too low to remove noise from") |
| STFT and inverse | `scipy.signal.stft` / `istft` (scipy 1.17.1) with `nperseg 1024`, `noverlap 768`, `padded=False` | A *STFT* cuts the sound into overlapping windows and turns each into frequencies. Here: a periodic Hann window, `boundary='zeros'`, scaled by the window's sum, and the matching overlap-add inverse. Double precision for the signal |
| Stationary | `stationary.py:1-133`, `utils.py:10-16` | The noise profile: the mean of the channels over the first 600,000 samples, its STFT **in single precision** (scipy keeps float32 input as complex64, measured), `20·log10(|x| + eps)` floored at 80 dB below each frequency's loudest; the mean and standard deviation per frequency; threshold `mean + 1.5·std`. Per channel: the signal's dB against the threshold (`>`), mixed `mask·p + (1 − p)`, smoothed (`fftconvolve`, `'same'`), applied, inverted |
| Non-stationary | `nonstationary.py:1-115` | `|STFT|`; smoothed along time by `filtfilt([b], [1, b − 1], padtype=None)` with `b` from `time_constant_s`; `(|S| − smooth) / smooth`; `sigmoid`; smoothed; mixed; applied; inverted |

- `fftconvolve` of the mask is ported as a direct 2-D convolution in doubles. It agrees with the FFT to about 1e-15, far below float32's step.
- `filtfilt` is ported with scipy's `lfilter_zi` start states and its forward-then-backward order.
- Each chunk is one worker call: about 21 MB of complex doubles for a full chunk.
- **Parity (ruling (f)):**
  - non-stationary: every sample within the measured ε (at most 1e-6) of Python's;
  - stationary: the same, except at bins the fixture flags, where Python's dB lay within 1e-6 dB of its threshold (band); and over every case, the signal-to-noise ratio against Python's output is at least 100 dB.

**Files:** create `video/core/denoise.ts` (uses R6.5's FFT), modify `soundEffects.ts`, `shared/runner/mediaEffects.ts`, `cores.ts`, the script (group `sfx-denoise`). Test: `runner-media-sfx-denoise.unit.spec.ts`.

**Fixtures (`sfx-denoise`):** the noisy tone, mono and stereo, at 8 kHz (both shorter and longer than 600,000 samples, so the chunks are crossed), 44.1 kHz and 48 kHz; both methods; `strength` 0, 0.5 and 1; a sound of pure silence; a rate too low for the smoothing filter (raises). Cases record the samples (base64 for the short ones, sha256 and the flagged bins for the long ones).

**Test:** rule 14 by the parity above; a 70-second sound is worked on chunk by chunk (a spy on the worker calls); Stop between chunks stops within one chunk.

**Acceptance:** every fixture case meets the parity above.

---

### Task R6.11: Controller check, fixture-level and in the browser (not delegated)

- [ ] Every R6 fixture group, run twice, unchanged; every `runner-*.unit.spec.ts` green.
- [ ] Real routes and engine, hosted mode, all R6 families with `cards,media-sound,media-video`, ComfyUI stopped:
  - Load video (two clips) → Get video components → Transition (glitch) → Caption track → Create video, with the sound through Audio fade → Audio normalize → Save video;
  - Load video frames → Stabilize → Slit scan → Save video frames;
  - Load audio → Audio denoise → Audio equalizer (3-band) → Save audio (Opus);
  - Audio waveform → Save video frames;
  - Text clip → Create video → the Video card;
  - Slow motion ×2 on a short clip, if `video-flow` passed.

  For each: the saved files by R5 rule 3 against the fixtures' Python runs, the previews, nothing charged, and Stop mid-job leaves no `ffmpeg` in `ps`.
- [ ] Hosted safety by hand: another person's LUT and audio file are refused before the run; `../grade.cube` is refused by its name; a Slit scan over the held limit leaves the workflow to the engine instead of failing.
- [ ] The looks (ruling (c), (e), (d)): side by side against Python — captions and a text clip (this Mac's Helvetica, and the bundled font against Python pointed at it); a glitch transition; a slow-motion clip. Record the verdicts.
- [ ] With every R6 family off, the needs-engine list over every saved project and the synthetic graphs is identical to before R6.1.
- [ ] R8.3 (Auto subtitle) is unblocked for its Caption track.

Record the results in `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md` and `docs/STATE.md`. R6's families stay off in hosted until the user answers R5 ruling (b) (they make video only through `media-video`).

### Controller rulings needed before R6 is built

- **(a) Frames between video effects are 8-bit, not floats.** Python passes a float batch from effect to effect. R2 kept picture effects' floats (R2.1 fix round 1), but a video batch as floats is 12 bytes a pixel: 15 GB for 600 frames of 1080p. *Recommend:* keep 8-bit batches. Round to the nearest level when another effect reads the batch; truncate, as Python's savers do, when only an encoder reads it, so one effect → save equals Python exactly. *Cost:* a chain of video effects can differ from Python by one level per effect at some pixels.
- **(b) Which font captions and text clips use.** Python takes the first of its listed fonts: Helvetica on this Mac, and on the Fly image (which has none) Pillow's built-in font at 10 pixels, whatever size is asked. *Recommend:* follow Python's list, so this Mac matches ComfyUI today. Where no listed font exists, use a bundled DejaVu Sans Bold (free to share; copied from the Python install, nothing downloaded), and use only that one in hosted. *Cost:* a 700 KB font file in the repository; hosted captions look different from ComfyUI's on Fly today, on purpose, because those are broken.
- **(c) What "the same text" means.** Sailor can't run FreeType, the font engine Pillow uses, without a new dependency. *Recommend:* the layout exact (the font, every letter's position, the line breaks, the boxes); the letters' edge pixels judged by eye with numbers: within each caption's box, the average difference at most 3/255, at most 1% of pixels more than 32/255 apart, and the controller's look. *Cost:* text is not byte-for-byte Python's; edges can differ slightly. The alternative, leaving both nodes to the engine, keeps Auto subtitle (R8.3) on ComfyUI.
- **(d) Slow motion's optical flow.** *Recommend:* port OpenCV's Farneback method (about 700 lines), on its own switch. The flow must be within 0.01 pixel of OpenCV's, and the frames equal except where a pixel sits on a rounding edge. If the port can't meet that, leave this one node with the engine. Don't swap it for Slow motion (AI), which is paid. *Cost:* a medium-to-large port whose result isn't guaranteed exact. The alternatives: refuse it in hosted and point people to Slow motion (AI) (a charge where there was none), or leave it with the engine for good.
- **(e) The glitch transition's randomness.** Python draws fresh random numbers each run, so no two runs match. *Recommend:* as Add noise (R2 ruling (e)): seed it from the node's settings and its input clips, so it is stable until something changes. The fixtures seed Python the same way, which makes the port provably exact. *Cost:* the glitch looks the same on every rerun of the same inputs, where Python's changes.
- **(f) Noise removal's measure.** *Recommend:* port both methods. Samples within 1e-6 of Python's. For the stationary method, allow flips only where Python's own level sat within a millionth of a decibel of its threshold, with the whole sound at least 100 dB clean against Python's. *Cost:* a medium port (STFT, its inverse, the smoothing and the two-way filter), and a rule that allows those rare flips.
- **(g) Audio waveform's drawing and its stereo quirk.** *Recommend:* port Pillow's integer drawing exactly, and the FFT to within float32's step; bar heights equal except where Python's height sat on a whole-number edge. Keep Python's quirk of drawing a packed stereo file as one interleaved track. It changes only the picture, not any sound. *Cost:* stereo WAV waveforms keep Python's slightly squeezed look.
- **(h) Nine switches.** *Recommend:* one per task (`video-time`, `video-join`, `video-look`, `video-stabilize`, `video-flow`, `video-draw`, `video-text`, `sound-effects`, `sound-denoise`), so each hard port can stay off without holding back the others. *Cost:* nine more switches to list and test.
- **(i) Hosted limits for effects.** *Recommend:* hosted, at most 512 MiB of 8-bit frames held at once by one node (about 86 frames of 1080p); a work budget that finishes within the 10-minute media job limit, measured on this Mac; at most 10 minutes of stereo 48 kHz sound (57.6 million samples) held by one node, inputs and output together. Locally, R5's own caps only. Anything over a limit leaves the workflow to the engine before the run; it never fails. *Cost:* a long clip through Slit scan, Reverse or Time displacement still needs ComfyUI in hosted. Python itself would need about 4 × that memory for the same clip.
- **(j) Letting go of kept batches.** A run keeps every frame batch and sound until it ends, which fills the 4 GiB hosted room after a few effects on a long clip. *Recommend:* let go of a batch or sound as soon as every node that reads it has finished. A restart that needs it again remakes it (free, and the same bytes). *Cost:* a restart can repeat some free work.
- **(k) Pictures and frame batches stay apart** (R5 ruling (e) continued). *Recommend:* a still picture wired into a video effect, or a video effect's frames into a picture node, leaves the workflow to the engine. That includes 3-way color, which Python files under picture grading but which the toolbox offers as a video effect. *Cost:* mixed still-and-video workflows keep needing ComfyUI until a later task.
- **(l) Chroma key's mask.** Python also makes a mask for every frame, a kind the runner can't carry. *Recommend:* take Chroma key only when nothing is wired from its mask. *Cost:* using the mask needs ComfyUI.
- **(m) Live previews of video effects.** A slider change on a video effect would have to rework the whole clip. *Recommend:* leave them out of the preview route. It answers "needs a full run", as for any class it doesn't know. *Cost:* dragging a slider on a video effect reruns the workflow, as it does today.
- **(n) One media slot per node.** A node that reads two clips and writes one needs three tool processes at once, but a hosted person has one slot. *Recommend:* a node takes one slot for all its processes (at most three). *Cost:* one person can have up to three processes running, each held to two threads in hosted.
- **(o) Save audio (Opus).** R5 and the inventory missed it. *Recommend:* add it to `media-sound`, reusing R5.3's Opus export. *Cost:* none.
- **(p) LUT files in hosted.** Python loads any `.cube` file; a 256-point one is 200 MB in memory. *Recommend:* hosted, a LUT over 65 points or 16 MiB leaves the workflow to the engine. No limit locally. *Cost:* very large LUTs need ComfyUI in hosted.
- **(q) Python quirks kept.** *Recommend:* keep them all, since none loses data:
  - a LUT that won't load passes the frames through;
  - Audio waveform with no readable file draws silence;
  - the equalizer clips at ±1;
  - Normalize and Adjust volume may go past ±1;
  - Silence cut trusts its frame-rate setting;
  - Trim with an end before its start gives the first frame;
  - Crossfade and Transition resize the second clip to the first;
  - Slow motion's reverse flow is the forward one negated.

  *Cost:* none beyond Python's own behaviour.

### R6 size

Eleven tasks:
- one of machinery with three pilots (R6.1);
- seven video tasks (R6.2 time, R6.3 joins, R6.4 looks, R6.5 Stabilize and the FFT, R6.6 optical flow, R6.7 made clips, R6.8 text);
- two sound tasks (R6.9 effects and Silence cut, R6.10 noise removal);
- the controller's check (R6.11).

They cover 34 classes: 21 video (with Audio waveform and Text clip), 12 sound, and Save audio (Opus). There are nine new families. Slow motion (AI) stays in R7.3; the local diffusion audio nodes stay local-only.

There are no paid calls and no live checks: R6 costs nothing to run, and nothing is downloaded (the bundled font comes from the Python install). The largest tasks are R6.1 (the lease, the start pass, streaming, and letting go), R6.6 (Farneback), R6.8 (text) and R6.10 (noise removal). Each is one reviewable unit: the ports are proven piece by piece against fixtures before any node uses them. R6.6 and R6.8 carry the most risk that their parity can't be met; their own switches let the rest go ahead without them.

---

# R7 — Paid and model nodes

R7 moves the nodes that run an AI model on this computer (spec decision 1) into the runner. Nine become one provider call each. Lens · Depth of field stays free: its depth model already runs inside Sailor's server, and only its blur is ported. Two class names that were already deleted get a retirement message. The outline's four tasks are replaced by the eleven below (expanded 2026-09-30). `.superpowers/sdd/2026-09-26-engine-free-step3/r7-expansion-report.md` lists the corrections to the outline and why. In short:

- **Face restoration and Wav2Lip are already gone.** Commit `6b682b578` (2026-09-27) deleted `nodes_face_restore.py` and `nodes_lip_sync.py` (non-commercial licences). Fix faces now runs on fal's Topaz (family `fix-faces`), and lip-sync on sync-3. No saved project uses either class. R7.10 only gives the two old class names a retirement message.
- **Today's models are not the ones the outline names.** Mask by text runs CLIPSeg, not SAM. Mask extractor runs SAM ViT-base and picks the best of three masks. Subject mask runs MobileSAM on every frame. Slow motion (AI) runs RIFE 4.6. Whisper is faster-whisper `base`. The vocal separator is Demucs `htdemucs`. Upscale is Real-ESRGAN x2plus. Object removal is LaMa at 512 × 512, composited back over the original. All are free and local today.
- **Object removal can stay LaMa.** Replicate's `zylim0702/remove-object` is LaMa. It is already carded, and Separate background and foreground calls it (R3.7). See ruling (c).
- **Transcription is mostly built.** R3.10 built the Wizper call for Transcribe audio, its card and its WAV hand-off. Whisper transcribe adds the captions and the SRT text, made from Wizper's timed chunks.
- **Python works on every frame of a batch** for Background remove, Upscale and Object removal. Per-frame calls on a clip multiply the price. See ruling (f).
- **No saved project uses an R7 class except Background remove** (27 of the 1,059 projects in `user/sailor/projects/`, checked 2026-09-30, mostly through the Product shot app). The families-off check also runs on synthetic graphs.
- R6's references to "R7.3" for Slow motion (AI) now mean R7.6. The R8 outlines now name R7.1, R7.7 and R7.8.

**Order.** R7.1 (the shared pieces, with Background remove) comes first. After it, R7.2–R7.5 and R7.9 are independent. R7.6 needs R5's video tools; R7.7 and R7.8 need R5's sound values. They all edit `families.ts`, `eligibility.ts` and the price module, so the controller runs at most two at once. R7.10 can go any time. R7.11 is the controller's check.

**Families** (each off by default; kept apart from `RUNNER_FAMILIES`, as R6's are, so every pinned "every family on" set stays as it was):

| Family | Task | Classes | Service | Needs |
|---|---|---|---|---|
| `bg-remove` | R7.1 | Background remove | Replicate `851-labs/background-remover` | `cards` |
| `upscale-2x` | R7.2 | Upscale (2×) | Replicate `nightmareai/real-esrgan` | `cards` |
| `object-remove` | R7.3 | Object removal | Replicate `zylim0702/remove-object` (ruling (c)) | `cards` |
| `sam-3-masks` | R7.4 | Mask by text, Mask extractor | fal `sam-3/image` | `cards` |
| `subject-mask` | R7.5 | Subject mask (still pictures, ruling (e)) | fal `sam-3/image` | `cards` |
| `slow-motion-ai` | R7.6 | Slow motion (AI) | fal `rife/video` | `media-video` |
| `whisper-captions` | R7.7 | Whisper transcribe | fal `wizper` | `media-sound` |
| `vocal-split` | R7.8 | Vocal separator | Replicate `ryan5453/demucs` | `media-sound` |
| `lens-blur` | R7.9 | Lens · Depth of field | none (free, in the server) | `cards` |

## Rules every R7 task follows (binding for R7.1–R7.9)

1. **The node moves whole.** Each class keeps its name, inputs and outputs. While its family is on, the runner takes it; while off, ComfyUI runs the local model, free, as today. The families that need the video tools are dropped while the tools are missing, as R6's are.
2. **What must match** (the user's matching rule).
   - The provider runs a different model, so its answer can't match Python's. The look is judged by eye on the live check.
   - Everything Sailor does around the call is cheap, and stays exact against Python *given the same answer*: reading the settings, the steps before the call (points, mask grow) and after it (alpha, premultiply, composite, threshold, captions, the preview).
   - The fixture script proves it. It runs the real `execute` with the model swapped for a stand-in that returns a recorded answer (rule 9).
   - Python's bugs are fixed where a task says so.
3. **Requests against the saved schema.** Before a task is dispatched, the controller saves each endpoint's schema into `frontend/tests/unit/fixtures/provider-schemas/` (`snapshot_provider_schemas.mjs`, free GETs). Python sends no request here, so the task's port table is the contract, and every payload must pass `checkPayload`. A setting the schema can't take leaves the whole workflow to the engine before the run. It is never silently changed, and never fails the run.
4. **Money** (R3 rules 7–9 and 12–14 bind).
   - Each endpoint has a rate card in `frontend/shared/pricing/` (`paidRates.ts`, or an existing card).
   - These classes have no flat price row (they were free). `priceNode` prices a class only while its family is on.
   - The hold is the ceiling, from media measured before the hold (picture size, sound length, frame count). The charge comes from the same calculation and is never above the hold. A call is charged only when it finished and delivered.
   - A card whose confidence is `estimate` blocks switch-on until the live check measures it.
   - No backups: no task found the same model on a second service with the same settings.
   - A branch where Python does nothing (an empty mask, one frame, a silent sound) is a `pass`: no call, nothing held, free (`paidNoCall`).
5. **Pictures, not clips** (ruling (f)). The picture classes take one picture. A frame batch, or a picture list of more than one, leaves the workflow to the engine (R6 ruling (k)).
6. **Pre-run checks are true upper bounds.** Sizes come from file headers, sound lengths from the probe, frame counts from R6's `frameShapes`. A case over a cap, or a setting the provider can't take, leaves the workflow to the engine. Only money and ownership are refused (R3 rule 9).
7. **Hosted safety.** No R7 widget names a file. Every picture and sound handed off must be the person's own (R3 rule 11). Hand-offs go through the run's hand-off (`createHandoff`, fal storage). Saved files go under the person's subfolder.
8. **Stop leaves nothing running.**
   - A call in flight follows the runner's cancel policy: the hold is released at once, and a cancel counts only when the provider confirms it.
   - Encodes and decodes run under R6's `mediaLease`, and are killed within one second.
   - No partial file is kept.
9. **Fixtures and tests.**
   - `scripts/runner_paid_fixtures.py --group local-<g>` (R3.2's script) imports each class with the network blocked. It patches the model loader (and `os.path.isfile` for the model file) with a stand-in, runs `execute`, and records the outputs.
   - Tests go in `frontend/tests/unit/runner-local-<g>.unit.spec.ts`. Each test checks:
     - the payload passes the saved schema;
     - through `planNode` and the kit (`cards`, the media family and the family on), the fake provider gets that payload;
     - the outputs equal Python's given the same answer;
     - the hold is the ceiling and the charge is the same calculation;
     - a refusal comes before `ledger.hold`;
     - with the family off, the class is left to the engine;
     - the families-off invariant (R3 rule 15) holds over the saved projects and one synthetic graph per class.
10. **Run line.**
    - `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group local-<g>`, run twice; the second time the file is unchanged.
    - `cd frontend && env -u FAL_KEY -u FAL_API_KEY -u NUXT_REPLICATE_TOKEN -u REPLICATE_API_TOKEN npx vitest run tests/unit/runner-local-<g>.unit.spec.ts tests/unit/runner- tests/unit/price-graph.unit.spec.ts`.
    - The typecheck from the Global Constraints.
    - Report (no commit).

---

### Task R7.1: The shared pieces, and Background remove (family `bg-remove`)

**Shared pieces:**
- `LOCAL_MODEL_FAMILIES` in `shared/runner/families.ts`: the nine families, with their `FAMILY_REQUIRES` (table above). `parseFamilies` knows them; the "every family on" sets don't change.
- `frontend/shared/runner/localModels.ts`:
  - `LOCAL_MODEL_FAMILY_OF` (class → family);
  - `SERVICE_OF` (class → `'replicate' | 'fal' | null`);
  - the rule rows: picture-only `linkSources` (rule 5) and `OUTPUT_KINDS`, applied only while the family is on.
- The price tooltip names the service while the family is on: "Runs on Replicate" or "Runs on fal" (ruling (b)). There is no new copy on the node.
- `frontend/server/runner/generators/localModels.ts`: the plans, one function per class, dispatched from `planNode`.

**Port:**

| Piece | Python | The runner |
|---|---|---|
| Call | `nodes_bg_remove.py:84-149`: rembg ISNet on each frame, `post_process_mask=True` | One call to `851-labs/background-remover` with `{ image, background_type: 'rgba', format: 'png' }` (R3.7's call); `take: 'first'` |
| Alpha | `cut.split()[3]`; `edge_softness > 0`: PIL `GaussianBlur(radius)` | The answer's alpha. The blur is R2's torchvision `gaussianBlur` with `σ = radius`, judged by eye (Pillow's box-blur version isn't ported) |
| `transparent` | RGBA, straight colour | The answer's RGB with the alpha: exact |
| `premultiplied` | `rgb·a`, 3 channels | Exact (float32, hand-off rounding) |
| `matte_only` | the alpha as grey RGB | Exact |
| Mask output | `alpha / 255` | A `mask` value (R0.7): exact |
| Preview | `save_live_preview(…, unique=True)`: RGBA (matte: grey plus opaque alpha) | A new name per run, Python's unique mode; the pixels are exact |

**Price:** `851-labs/background-remover` is carded as an estimate ($0.0004, `paidRates.ts`). It is the same call as R3.5's Remove background, so one measurement serves both.

**Files:** `families.ts`, `eligibility.ts`, `validate.ts` (`RUNNER_OUTPUT_CLASSES`), `executors.ts`, the new `shared/runner/localModels.ts` and `server/runner/generators/localModels.ts`, `app/lib/nodeCreditEstimate.ts` (the tooltip), and `scripts/runner_paid_fixtures.py` (group `local-cutout`: stand-in `rembg.remove` answers with soft, hard and empty alpha, each `output`, `edge_softness` 0 / 2 / 10). Test: `runner-local-cutout.unit.spec.ts`.

**Acceptance:**
- Every fixture case passes: exact, except the blur, which is judged by eye.
- Product shot's chain (Load image → Background remove → Image to mask → Save image) runs with ComfyUI off, and the cut-out keeps its alpha.
- A video batch wired in leaves the workflow to the engine.
- With every R7 family off, nothing changes.

**Live check:** one picture, about $0.0004.

---

### Task R7.2: Upscale (2×) (family `upscale-2x`)

| Piece | Python | The runner |
|---|---|---|
| Call | `nodes_upscale.py:113-136`: Real-ESRGAN x2plus, tiled by `tile_size` | `nightmareai/real-esrgan` with `{ image, scale: 2, face_enhance: false }`: Upscale's Real-ESRGAN builder (`upscaleInput`, R3.5) at scale 2. `tile_size` is not sent: it only splits Python's own work |
| Output | 2W × 2H, the preview (`unique=True`) | Kept as downloaded. An answer that isn't 2W × 2H is resized to it with R0's bilinear, so later nodes see Python's size |

**Price:** the existing card, `editRates.ts` (`per_image`, $0.002, verified). The task checks the page for a largest input size. A larger picture leaves the workflow to the engine (rule 6).

**Files:** `localModels.ts` (both), `eligibility.ts`, `executors.ts`. Test: `runner-local-upscale.unit.spec.ts`. No Python fixture: nothing around the call computes anything.

**Acceptance:**
- The payload passes the schema.
- A 1000 × 750 fake answer to a 500 × 375 picture is kept as it is; a 900 × 700 one is resized.
- The preview's ui equals Python's shape.

**Live check:** one 1-megapixel picture, about $0.002.

---

### Task R7.3: Object removal (family `object-remove`)

| Piece | Python | The runner |
|---|---|---|
| Mask | `nodes_object_remove.py:54-65` → `_inpaint.py:67-133`: one mask for every frame (or `mask[0]`), `uint8(trunc(255·m))`, `cv2.dilate(3 × 3, iterations = mask_grow)` | Exact. The dilate is R3.7's `maxFilterCore` at size `2·grow + 1`, since a repeated 3 × 3 dilate is one square, clipped at the edges |
| Nothing to remove | the grown mask is all zero: the frame unchanged | A `pass`: no call, free |
| Call | LaMa at 512 × 512, back to full size (`INTER_CUBIC`) | `zylim0702/remove-object` with `{ image: RGB picture, mask: grown mask PNG }` (R3.7's builder), full size (ruling (c)) |
| Composite | `fill·m + original·(1 − m)`, with `m` the grown mask `/ 255` | Exact, given the fill |
| Preview | `unique=True` | As R7.1 |

- A mask whose size differs from the picture's is refused before the hold: "The mask must be the same size as the picture." (Python fails inside OpenCV.)

**Price:** `zylim0702/remove-object`, an estimate ($0.0007, `paidRates.ts`), shared with R3.7's measurement.

**Files:** `localModels.ts` (both), `eligibility.ts` (the mask input reads R0.7 masks), `executors.ts`, the fixture script (group `local-erase`: masks touching each edge, `mask_grow` 0 / 4 / 64, an all-black mask, a recorded full-size fill; the fixture records `cv2.dilate` and the composite directly, since Python's 512 × 512 resize isn't the provider's). Test: `runner-local-erase.unit.spec.ts`.

**Acceptance:**
- The grow and the composite are exact.
- An empty mask makes no call and charges nothing.
- Subject mask → Object removal runs with ComfyUI off.

**Live check:** one picture, about $0.001.

---

### Task R7.4: Mask by text and Mask extractor (family `sam-3-masks`)

| Piece | Python | The runner |
|---|---|---|
| Picture | the first frame only (`_image_to_pil`) | The same |
| Mask by text | `nodes_matte_ml.py:105-132`: CLIPSeg on `prompt or "object"`, soft | `fal-ai/sam-3/image` with `{ image_url, prompt, apply_mask: false, output_format: 'png', return_multiple_masks: true }`. The union of every mask returned, since CLIPSeg covers every match (ruling (k)) |
| Mask extractor | `:167-217`: `points` read by `json.loads` (bad text, a non-list or an empty list: one point at the centre); `[clamp(int(float(x)·w)), clamp(int(float(y)·h))]`; `int(label)`; SAM's best of three | The same parsing, exact. `{ image_url, prompt: '', point_prompts, apply_mask: false, output_format: 'png', return_multiple_masks: false, max_masks: 1 }` (`samInput.ts`'s call, moved to a shared builder used by `/api/inpaint/segment` and the runner); `masks[0]` |
| After | `threshold > 0`: `(m > t)` (text only); `feather > 0`: torchvision `gaussian_blur(2⌈3σ⌉ + 1, σ)`; `invert`; clamp; `[1, H, W]` | Exact, given the mask: R2's `gaussianBlur`. The mask is resized to the picture with R0's bilinear if the answer's size differs |
| Preview | `_mask_preview` `:54-61`: `image·(1 − m·0.5) + red·m·0.5`, fixed name | Exact |

- Mask by text's `prompt` is moderated (R3 rule 10: added to `PAID_TEXT_INPUTS`).
- An answer with no mask is an all-black mask, charged (ruling (k)).
- A wired `points` text is read at the node's turn (R0); the hold doesn't depend on it.

**Price:** a new card, `fal-ai/sam-3/image`, per call. The task reads the figure from fal's page; `priceBook.ts`'s route row says $0.005, verified.

**Files:** `localModels.ts` (both), `server/utils/samInput.ts` (to `shared/runner/samInput.ts`, with the segment route updated), `paidRates.ts`, `paidSettings.ts`, `eligibility.ts`, `executors.ts`, the fixture script (group `local-masks`: the stand-in models return a recorded mask; for CLIPSeg the logits are given at the picture's own size, so Python's resize is the identity; every `threshold`, `feather` and `invert` edge, and bad `points` texts). Test: `runner-local-masks.unit.spec.ts`.

**Acceptance:**
- Every fixture case is exact given the mask.
- `/api/inpaint/segment` sends the same payload as before (its test stays green).
- Mask extractor → Object removal runs with ComfyUI off.

**Live check:** one text call and one click call, about $0.01.

---

### Task R7.5: Subject mask on a still picture (family `subject-mask`)

| Piece | Python | The runner |
|---|---|---|
| Point | `nodes_subject_track.py:160-248`: `(point_x·W, point_y·H)`, one positive point | One point prompt, rounded to whole pixels as `samInput.ts` does, `return_multiple_masks: true` |
| Pick | `best`: SAM's score; `largest` / `smallest`: by pixel count | `best`: the first mask; `largest` / `smallest`: by count over the masks returned. A single mask is taken for every mode |
| Mask | `(m > 0)`; `mask_grow > 0`: `cv2.dilate(3 × 3, round(grow))`; `< 0`: `cv2.erode` | Exact, given the mask: `maxFilterCore`, and the same over the inverted mask for the erode |
| Cutout | `rgb / 255 · mask` (3 channels) | Exact |
| Outputs | a mask batch and a cutout batch, no ui | A `mask` value and a picture |

- A frame batch leaves the workflow to the engine (ruling (e)).

**Price:** R7.4's card.

**Files:** `localModels.ts` (both), `eligibility.ts`, `executors.ts`, the fixture script (group `local-masks` grows: the stand-in decoder returns three recorded masks with scores, `mask_grow` −32 / −1 / 0 / 3 / 32). Test: `runner-local-masks.unit.spec.ts`.

**Acceptance:** exact given the masks; a clip leaves the workflow to the engine.

**Live check:** one picture, about $0.005.

---

### Task R7.6: Slow motion (AI) (family `slow-motion-ai`)

**Consumes:** R5.1b (encode, decode), R5.2 and R6.1 (`frames` values, `frameShapes`, `mediaLease`).

| Piece | Python | The runner |
|---|---|---|
| No work | `nodes_frame_interp.py:219-228`: `T < 2` or `multiplier < 2`: the input handed on | A `pass`, free |
| Call | RIFE 4.6 between each pair at `k / m` | The batch encoded once as H.264 at high quality (ruling (g)), handed off, and one call to `fal-ai/rife/video` asking for `m − 1` frames between each pair (the field names come from the saved schema) |
| Output | `(T − 1)·m + 1` frames, the originals at `i·m` | The answer decoded to a batch. Its count is forced to `(T − 1)·m + 1` by nearest frame, and the original 8-bit frames are put back at `i·m` (exact). Kept as a `frames` value, with no ui |

- A multiplier the schema can't express, or a batch over the hosted cap (ruling (g)), leaves the workflow to the engine.
- Stop kills the encode and the decode under the lease (rule 8).

**Price:** a new card, `fal-ai/rife/video`, billed by compute time ($0.0013 a compute-second on the page, read by the task). It is an estimate, a ceiling per output frame and megapixel (ruling (j)). It blocks switch-on until the live check measures it.

**Files:** `localModels.ts` (both), `paidRates.ts`, `paidSettings.ts`, `eligibility.ts` (`FRAMES_OUTPUTS` gains slot 0 while on), `executors.ts`. Test: `runner-local-slowmo.unit.spec.ts`, with the fake fal answering a recorded clip, and one with too few frames.

**Acceptance:**
- The output count and the original frames are exact.
- Load video → Get video components → Slow motion (AI) → Create video → Save video runs with ComfyUI off.
- Stop leaves no `ffmpeg` running.

**Live check:** a 2-second 480p clip at ×2, about $0.05 (up to $0.10: compute time is unknown until measured).

---

### Task R7.7: Whisper transcribe (family `whisper-captions`)

**Consumes:** R3.10 (the Wizper call and card), R5.3 (`resampleLikeTorchaudio`, WAV writing).

| Piece | Python | The runner |
|---|---|---|
| Sound | `nodes_audio_ml.py:104-117`: batch 0, mean of the channels, resampled to 16 kHz, the whole sound | The same, as a 16-bit WAV, the whole sound up to the cap (ruling (h)); R3.10's hand-off |
| Call | faster-whisper `model_size`, `vad_filter=True` | `fal-ai/wizper` with `{ audio_url, task: 'transcribe', chunk_level: 'segment', version: '3' }`, plus `language` unless it is `auto` or blank after `strip()`. `model_size` is not sent: Wizper runs large-v3 only (ruling (h)) |
| Language | any code faster-whisper knows | A code outside Wizper's saved list leaves the workflow to the engine |
| Captions | `:178-207`: each segment's `text.strip()`, empty ones skipped; `s = int(round(start·fps))`, `e = max(int(round(end·fps)), s + 1)` (half to even); `"{s} {e} {text}"` joined by `\n` | Exact, given the chunks (`timestamp: [start, end]`). A chunk with no end ends at the sound's length (fix) |
| SRT | `_format_srt_time` `:120-125`; blocks numbered by `enumerate`, so a skipped segment leaves a gap | Exact, except the numbers run 1, 2, 3 with no gaps (fix; no saved project uses the class) |
| Text | the texts joined by one space | Exact |
| Outputs | three strings, no ui | Three `text` values |

**Price:** R3.10's `fal-ai/wizper` card (an estimate, $0.0001 a second sent), charged by the seconds sent. One live measurement serves both families.

**Files:** `localModels.ts` (both; the request reuses `soundIn.ts`'s `wizperInput`), `eligibility.ts` (`valueInputs` for the sound; `OUTPUT_KINDS` text), `executors.ts`, the fixture script (group `local-whisper`: the stand-in `WhisperModel.transcribe` returns recorded segments, including empty and whitespace texts, `.5` frame edges, and fps 1 / 23.976 / 120). Test: `runner-local-whisper.unit.spec.ts`.

**Acceptance:**
- The three texts equal Python's, apart from the SRT numbering fix.
- Auto subtitle's chain up to Caption track runs with ComfyUI off.

**Live check:** a 60-second clip, about $0.006.

---

### Task R7.8: Vocal separator (family `vocal-split`)

| Piece | Python | The runner |
|---|---|---|
| Sound | `nodes_audio_ml.py:249-295`: batch 0; mono repeated to stereo; more than two channels cut to two; resampled to the model's rate | The same channel steps, at the sound's own rate, sent as 16-bit FLAC (R5.3) through the hand-off. The provider resamples |
| Call | Demucs `model`, `shifts`, `split=True` | `ryan5453/demucs` with `{ audio, model, shifts, stem: 'vocals', output_format: 'wav' }` (names from the saved schema; ruling (i)) |
| Outputs | `vocals`; `instrumental = sum of stems − vocals` | The answer's vocals and no-vocals, each read as a sound value (R5.2). Two stems sum to the same instrumental |

- A `model` or `shifts` value the schema refuses (for example `shifts` 0) leaves the workflow to the engine.
- A sound over the hosted cap does the same (ruling (i)).

**Price:** a new card, `ryan5453/demucs`. It is billed by GPU time; the page says about $0.026 a run. It is an estimate per second of sound sent, with the page's figure as the floor. It blocks switch-on until the live check measures it (spec Open question 6).

**Files:** `localModels.ts` (both), `paidRates.ts`, `paidSettings.ts`, `eligibility.ts` (`SOUND_OUTPUTS` gains slots 0 and 1 while on), `executors.ts`. Test: `runner-local-vocals.unit.spec.ts`: mono, stereo and 6-channel sounds, and a fake answer of two WAVs.

**Acceptance:** Karaoke's chain (Load audio → Vocal separator → Save audio (MP3)) runs with ComfyUI off.

**Live check:** a 30-second song, about $0.03.

---

### Task R7.9: Lens · Depth of field in the server (family `lens-blur`, free)

**Consumes:** R2.2's kernels (`gridSample`, `resizeBilinear`, `gaussianBlur`), R2.1's worker and derive plan, R2.11's preview route.

| Piece | Python | The runner |
|---|---|---|
| No picture | `nodes_lens.py:64-70`: a 16 × 16 black picture and its preview | Exact |
| Wired depth | `:75-85`: the first picture, channels averaged, bilinear to the picture (`align_corners=False`), clamped | Exact |
| Depth model | `_depth.py:79-123`: Depth Anything V2 Small, bicubic to the picture, min–max normalised, cached | The same model through transformers.js, in-process. The loader is moved out of `server/api/depth/estimate.post.ts` into `server/utils/depthModel.ts` and shared with the route. The raw depth is resized to the picture and normalised, and cached by the picture's sha256. It looks the same, not exact (ruling (l)) |
| Focus | `:88-97`: `json.loads(focus_point)`, else the centre; `clamp(int(fx·w))`; `depth[py, px] + offset`, clamped | Exact |
| Lens | `_lens.py`: `resolve_params`; `focal_compression` (`grid_sample`, border, `align_corners=True`); `circle_of_confusion`; `render_dof` (five levels, disk / hexagon / anamorphic kernels, reflect padding, the highlight boost, tent weights); `chromatic_aberration`; `vignette` | Ported, library parity (R2 rule 10) given the same depth. Each kernel is a set of row spans, summed from float64 prefix sums: one pass costs `(2r + 1)` per pixel, not `(2r + 1)²` |
| Preview | fixed name | As R2's effects |

- **Live preview.** While `lens-blur` and `live-previews` are both on, the class joins R2.11's preview route, so slider drags don't wait for a full run. The depth is cached, so a drag only redoes the blur.
- **Work cap.** Hosted, a picture whose `W·H·(2r + 1)·5` is over R2's per-node work cap leaves the workflow to the engine.
- **The model.** In hosted, the model files ship in the image and are never downloaded at run time (ruling (l)).

**Files:**
- Create `server/utils/depthModel.ts`, `server/runner/effects/core/lens.ts` and `server/runner/cards/lensBlur.ts`.
- Modify `server/api/depth/estimate.post.ts` (it uses the shared loader; same answers), `effects/table.ts`, `cores.ts`, `preview.ts`, `eligibility.ts`, `executors.ts`.
- Modify `scripts/runner_effects_fixtures.py` (group `lens`: Python's depth fed through the `depth` input; every preset and shape; `aperture` 0 / 0.4 / 1; `focus_offset` ±1; CA, vignette and focal length at 0 and their ends; bad `focus_point` text).
- Test: `runner-effects-lens.unit.spec.ts`.

**Acceptance:**
- Every fixture case passes, library-equal given the depth.
- An unwired depth runs the model once per picture (a spy).
- The depth route's own test stays green.
- Charges nothing.

**Live check:** none (free).

---

### Task R7.10: The two deleted local nodes say they were retired (no family)

`FaceRestore` and `LipSync` (Wav2Lip) were deleted on 2026-09-27. A saved workflow that still holds one would show an unknown node.

- Add both to `RETIRED_CLASSES` (`shared/runner/retired.ts`) with their own advice:
  - "This node was retired. Use Fix faces instead."
  - "This node was retired. Use Lip-sync a character instead."
- Each class gets its own advice line (`RETIRED_ADVICE_OF`); R4.1's message stays the default.
- R4.1's guard test counts "182 partner classes plus these two".

**Files:** `retired.ts`, `ComfyNode.vue`'s retired line (it reads the advice per class), `runner-retired-nodes.unit.spec.ts`, `comfy-node-retired.unit.spec.ts`.

**Acceptance:**
- A synthetic saved graph with each class opens, and shows its line.
- The graph is refused before the hold on both paths.
- The R4.1 guard is green.

**Live check:** none.

---

### Task R7.11: Controller check, fixture-level and in the browser (not delegated)

- [ ] Every `local-*` fixture group and the `lens` group, run twice, unchanged; every `runner-*.unit.spec.ts` green.
- [ ] Each endpoint's schema saved before its task, and every payload passing it.
- [ ] Hosted mode, ComfyUI stopped, each family on in turn, with the fake providers:
  - Product shot's chain;
  - Mask extractor → Object removal → Save image;
  - Slow motion (AI) on a short clip;
  - Auto subtitle up to Caption track;
  - Karaoke;
  - Lens with a slider drag.

  For each: the price shown before the run equals the hold; the charge equals the same calculation; Stop mid-call releases the hold and leaves no `ffmpeg` in `ps`.
- [ ] With every R7 family off, the needs-engine list over every saved project and the synthetic graphs is identical to before R7.1.
- [ ] **Live checks, only with the user's go**, one per family, backups off: Background remove ($0.0004), Upscale ($0.002), Object removal ($0.001), the two mask calls ($0.01), Subject mask ($0.005), Slow motion (AI) (about $0.05, up to $0.10), Whisper (about $0.006), Vocal separator (about $0.03). About $0.10 in all, $0.16 at most. Record each measured price with its source and date. Lay the looks side by side against the local models, and record the verdicts.
- [ ] R8.1 (Product shot), R8.2 (Karaoke) and R8.3 (Auto subtitle) are unblocked.

Record the results in `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md` and `docs/STATE.md`.

### Controller rulings needed before R7 is built

- **(a) Free here, paid once moved.** Today these nodes run free on this Mac. Once a family is on, each run is charged, locally too. *Recommend:* families are switched per place: keep them off on this Mac, so the local models stay free here, and switch them on in hosted after each live check. *Cost:* the same node is free locally and paid in hosted. Someone running locally without ComfyUI pays.
- **(b) Saying which service runs it** (decision 1: "the label says which service runs it"). *Recommend:* the price's tooltip says "Runs on Replicate" or "Runs on fal". No new text on the node (the user's rule: hints are tooltips). *Cost:* less visible than a label.
- **(c) Object removal's service.** Decision 1 named fal's `object-removal`. That is a different model, not yet carded, at $0.006–0.024 a call. *Recommend:* Replicate's `zylim0702/remove-object`. It is LaMa, the model this node runs today, and is already carded ($0.0007, estimate) and called by Separate background and foreground. *Cost:* it changes the service the user picked; LaMa's price is an estimate until measured.
- **(d) Face restoration.** It is already replaced: Fix faces on fal's Topaz (`fix-faces`, 2026-09-27). *Recommend:* nothing to move; only R7.10's retirement message. *Cost:* none.
- **(e) Subject mask** (spec Open question 2). *Recommend:* still pictures only, one SAM 3 call ($0.005). Clips stay with the engine until fal publishes a price for `sam2/video`. *Cost:* tracked masks on video keep needing ComfyUI.
- **(f) Clips into picture models.** Python runs Background remove, Upscale and Object removal on every frame. *Recommend:* one picture only; a clip leaves the workflow to the engine. *Cost:* cutting out a whole clip needs ComfyUI. The alternative is one call per frame, with a frame cap and the hold at frames × price.
- **(g) Slow motion (AI)'s hand-off and caps.** *Recommend:*
  - send the clip as high-quality H.264;
  - put the original frames back exactly;
  - force the frame count to Python's `(T − 1)·m + 1`;
  - leave a multiplier the provider can't make to the engine;
  - in hosted, at most 10 seconds (240 frames) in.

  *Cost:* the in-between frames go through one lossy encode, and longer clips need ComfyUI in hosted.
- **(h) Whisper's settings and length.** Wizper runs only large-v3. *Recommend:*
  - keep the model size setting, unused while on;
  - leave languages Wizper doesn't list to the engine;
  - send the whole sound, up to 30 minutes in hosted;
  - number the SRT blocks without gaps (a Python bug).

  *Cost:* the model size does nothing while on.
- **(i) Vocal separator's model and price.** *Recommend:*
  - Replicate's `ryan5453/demucs` (the inventory's choice) in two-stem mode;
  - lossless WAV back;
  - at most 10 minutes in hosted;
  - priced from the live check's measurement (Open question 6).

  *Cost:* it can't be switched on before the measurement.
- **(j) Holds for time-billed calls.** RIFE, Demucs, Wizper and LaMa bill by compute time, so no hold is a proven ceiling. *Recommend:*
  - each card is a generous ceiling from its page, marked as an estimate;
  - each blocks switch-on until measured;
  - the charge is never above the hold, so Sailor absorbs any overrun, logged as `runner.charge.above-hold`.

  *Cost:* Sailor may absorb overruns.
- **(k) SAM 3's answers.** *Recommend:*
  - text prompts take the union of every mask, as CLIPSeg covers every match; clicks take one mask;
  - an answer with no mask gives an all-black mask and is charged, since the call ran and answered;
  - Mask by text's threshold stays: it changes nothing on SAM 3's hard masks, but still applies to a feathered one.

  *Cost:* a "nothing found" answer costs $0.005.
- **(l) The depth model in hosted.** *Recommend:*
  - ship Depth Anything V2 Small's files in the Fly image, never downloaded at run time;
  - one depth per picture, cached by its sha256;
  - the blur by row spans (fast, library parity), not a full 2-D kernel.

  *Cost:* the image grows by the model's size (the task records it). The depth differs a little from Python's torch run, so focus can land slightly differently on the same tap.

### R7 size

Eleven tasks:
- one task for the shared pieces, with Background remove (R7.1);
- seven tasks, one per paid family (R7.2–R7.8);
- one free port (R7.9);
- one retirement (R7.10);
- the controller's check (R7.11).

They cover ten classes moved and two retired names. All are small except R7.6 (encode, call, decode, frame count) and R7.9 (the lens port and its live preview).

The live checks cost about $0.10 in all ($0.16 at most), each needing the user's go. Five families can't be switched on until a check measures them, because their cards are estimates: Background remove, Object removal, Slow motion (AI), Whisper transcribe and Vocal separator.

---

# R8–R11 — outline tasks (to be expanded before they are built)

(R4.1 stays below for the record: it was built on 2026-09-28. R5, R6 and R7 are expanded above.)

Each outline task becomes a full task (tests and code) when its slice starts. Every paid family: its own switch, off by default; priced in `frontend/shared/pricing/` before switch-on; the backup rule; a live paid check with the user's go.

### Task R4.1: Retire the 182 partner nodes (decision 3)

Add every class billed through api.comfy.org (the inventory's list; mechanically, every `comfy_api_nodes/nodes_*.py` class except `nodes_replicate.py`) to a shared `RETIRED_CLASSES` (`frontend/shared/runner/retired.ts`). They leave the Actions panel and the Legacy toggle (`app/data/action-catalog.ts`, `GeneratorsPanel.vue:41-46`), node search (`useNodeSearch.ts:87-140`), the agent and start-modal catalogues, and are refused on both paths before any charge (`blockedModels.ts`' shape: a 400 like ComfyUI's `node_errors`, "This node was retired. Pick another way to make this."). The Python files stay (not edited by this programme). Acceptance: a guard test that every `api.comfy.org`-billed class in `objectInfo.baseline.json.gz` is retired; a saved workflow with one opens, shows the node as retired, and is refused before the hold.

### Task R8.1–R8.4: The mini apps (decision 10)

Each app (`app/components/apps/*`, prompts built in `layouts/default.vue:4004-4007`) sends its workflow to `/api/runs` instead of `/prompt`: R8.1 Product shot (LoadImage → Background remove → Image to mask → Blend scene / Generate image → Save image; after R1, R7.1); R8.2 Karaoke (LoadAudio → Vocal separator → Save audio MP3; after R5, R7.8); R8.3 Auto subtitle (LoadVideo → Get video components → Whisper → Caption track → Create video → Save video; after R5, R6.1, R6.8, R7.7); R8.4 Face swap (after Open question 1 — or its retirement). Acceptance per app: the app's workflow is runner-eligible with its families on; the result lands where the app shows it; its price shows before the run.

### Task R9.1: Timeline, browser export only (decision 5)

The in-graph Timeline node becomes a browser export: in a workflow it is refused with "Export this timeline from the Timeline editor", and the Timeline editor's Export is the one path (`TimelineEditor.vue:1161-1279` loses its server branches; the `Sailor.VideoExport=server` switch goes). Delete `renderOnServer` (`TimelineEditor.vue:1291-1400`), `TimelineModal.vue` (mounted nowhere), `lib/serverFrameRenderer.ts` and `pages/timeline-harness.vue`'s server comparison, and the native/proxy handling of `/sailor/render_timeline_stream`, `/sailor/render_timeline` and `/sailor/timeline/render_frame`. Acceptance: no frontend reference to the deleted routes; the 19 saved projects with a Timeline node open and say how to export; `nodes_timeline.py` stays (Python is not edited).

### Task R10.1: Engine plumbing out of the app

Delete the worker pool (`/api/pool/ensure`, `server/utils/comfyWorkerPool.ts`, `useDirectExecution.ts:544,627`), the engine-only `/gate/resume` path in `ComfyGateNode.vue:92` (runner gates already use `sailor:runnerGateAction`), and the Space Type server encode fallback (`lib/engine/encodeVideo.ts:55` and its `serverFallback` callers in ArtifactFrameNode.vue, Scene3DStudioSurface.vue, GradientStudioSurface.vue, ShaderStudioSurface.vue, CompositorModal.vue, SpaceTypeSurface; spec ruling 7). Acceptance: builds clean; no reference left; exports work through mediabunny as today.

### Task R10.2: Local-only classes and blueprints hidden in hosted (decision 4)

In hosted: node search (`useNodeSearch.ts`) offers no class outside the runner's known set plus the cards; `/global_subgraphs` returns an empty list; `NodesSidebar.vue:23-73` hides the blueprint section. Locally with ComfyUI off: blueprints list natively from `blueprints/*.json` (a native `/global_subgraphs`, read-only) and say "needs the local engine" when run. Acceptance: hosted route-guard tests green; a local blueprint still loads with ComfyUI up.

### Task R10.3: LoRA trainer cloud only (decision 6)

Remove the local mode of `LoraTrainerSurface.vue` (:1026-1137) and its base-checkpoint downloads (`/sailor/models/download` callers in `useModelDownloads.ts` for the trainer); keep `/api/cloud-train`. `models/download` remains only if R7 keeps a local model (none planned: then remove it and `models/status`' local bundles). Acceptance: the trainer offers cloud only; no call to `/prompt` from it.

### Task R11.1: Relight and Generate a video leftovers

Relight's wired `light` (JSON from the gimbal) and `instructions` (text) as value inputs (R0), with `parseLight`'s tolerant read of a wired value; Generate a video's wired `model_options` (priced at its most expensive, as the price module already does for a link) and `fabric-1.0` with a linked sound (the sound hand-off already exists). Acceptance: request fixtures for each; the hold at the ceiling, the charge from the same calculation.

### Task R11.2: Lip-sync engines and unpriced image models

Lip-sync a character's Fabric and auto engines, and `sync` below sync-3 (measured-length pricing as sync-3); the three Recraft SVG models (the runner saves the SVG; a reader that needs a picture refuses it plainly), `seedream-5-pro` and `reve-create` once priced (each needs its price and a live check; otherwise they stay hidden). Acceptance: request fixtures; no model switched on without a verified price.

---

## Self-review (done while writing)

- **Spec coverage.** Decision 1 → R7.1–R7.10; 2 → Open question 1, R8.4; 3 → R4.1; 4 → R10.2; 5 → R9.1; 6 → R10.3; 7 → R5.1; 8 → Global Constraints, every porting task; 9 → R2.10; 10 → R8.1–R8.4. Money rules → Global Constraints, R0.4 (price reads wires), R0.5 (refusal before hold), R0.6 (charged once), R1.2 (charge unchanged by wires). Slice map R0–R11 → the task list. "Persisted, resumable, sha-keyed" → R0.1 (record), R0.2 (kept by sha, swept), R0.6 (restart test). Masks and picture lists → R0.1, R0.7, R1.3, R1.4, R1.6.
- **Types used across tasks.** `RunnerValue` (R0.1) with `mask.files` everywhere; `slotValue`, `filesOf`, `filesOfValues`, `literalOf`, `checkValue`, `withWiredValues` (values.ts); `KeptBytes.put(runId, bytes, ext)`; `DeriveIO` / `Derived` / `staticDerive` (R0.4) — `saveAsset` gains `subfolder?`/`folder?` in R1.5 by name; `ResultEntry` (R0.6); `outputKind`, `valueInputsOf`, `valueWiresAllowed`, `STATIC_VALUES`, `staticValueOf`, `staticWiredTexts` (R0.3).
- **R2 (expanded 2026-09-26).** Decision 8 → R2 rule 10 (exact / library classes) and R2.9 (Add noise); decision 9 → R2.10; the ledger's rulings → R2 rules 7–9 (worker, one file at a time, per-node cap, start-of-take refusals), 11 (fixtures from real Python, byte-identical, multi-threaded torch) and 12 (families-off invariant); the 78 inventory classes → R2.1 (3) + R2.4 (26) + R2.5 (13) + R2.6 (4) + R2.7 (15) + R2.8 (6) + R2.9 (11); Painter (spec ruling 4) → R2.8; the ~45 live-preview classes' engine runs → R2.11. Rulings the controller still owes: R2 (a)–(f).
- **R3 (expanded 2026-09-27).** Spec money rules 1–5 → R3 rules 7, 9, 13, 14; parity ("paid nodes: the request is identical") → rules 4–5; spec ruling 1 (3D address) → R3.9; the 38 classes → R3.3 (7) + R3.4 (4) + R3.5 (5) + R3.6 (3) + R3.7 (1) + R3.8 (2) + R3.9 (2) + R3.10 (4) + R3.11 (1, the preset path) + R3.12 (3) + R3.13 (2) + R3.14 (1) + R3.15 (2) + R3.16/R3.17 (1), with nine hidden twins. Rulings the controller still owes: R3 (a)–(t).
- **R5 (expanded 2026-09-28).** Decision 7 and the ledger's LGPL ruling → R5.1a (build, licence, finder) and R5.1b (the module); the lossy-tolerance ruling → R5 rule 3, with the H.264 exception put to the controller (ruling (c)); the 11 codec classes → R5.3 (5) + R5.4 (4) + R5.5 (2), plus the Audio and Video cards; AudioWaveform → R6.7 (the old outline's R6.1); Timeline → R9.1; thumbnails, waveforms and the asset probe → R5.6; R3.10 / R3.17's needs → the table at the top of R5. Rulings the controller still owes: R5 (a)–(q).
- **R6 (expanded 2026-09-30).** The outline's 20 + 12 classes → 34: R6.1 (3) + R6.2 (4) + R6.3 (2) + R6.4 (5) + R6.5 (1) + R6.6 (1) + R6.7 (2) + R6.8 (2) + R6.9 (12, with Save audio (Opus), which R5 missed) + R6.10 (1); Text clip (from `nodes_text.py`) and Audio waveform (from R5) counted in; Slow motion (AI) → R7.3. The parity rules → R6 rule 5 (exact, library, band, visual) and rule 4 (8-bit batches, ruling (a)); "switching on never breaks a working graph" → rule 3 (the start pass sends anything the runner can't do to the engine); hosted file names judged by name → rule 8; kept values read back under their caps → rule 10; per-person media slots → rule 7 (one lease per node); kept bytes never read whole → rule 6; Stop leaves no ffmpeg → rule 7 and R6.11. The hard ports named → R6.6 (Farneback), R6.8 (text), R6.3 (glitch), R6.10 (noisereduce), R6.7 (Pillow's drawing). Rulings the controller still owes: R6 (a)–(q).
- **R7 (expanded 2026-09-30).** Decision 1 → R7.1 (Background remove), R7.2 (Upscale), R7.3 (Object removal), R7.4 (Mask by text, Mask extractor), R7.6 (Slow motion (AI)), R7.7 (Whisper), R7.8 (Vocal separator), R7.9 (Lens, free); Face restoration and Wav2Lip, already deleted on 2026-09-27 → R7.10 (retirement message only); Open question 2 (Subject mask) → R7.5, still pictures; Open question 6 (Demucs price) → R7.8's live check. The user's matching rule → R7 rule 2 (the provider's look judged by eye; the steps around each call exact against Python, given the same answer). Money rules → R7 rule 4; "never fails a working graph" → rules 3, 5 and 6; hosted safety → rule 7; Stop → rule 8. Rulings the controller still owes: R7 (a)–(l).
- **Known gaps, deliberate:** JPEG/WebP EXIF metadata not written (R1.5); Get image size's progress text not shown (R1.4); Gate choices on a text value (spec ruling 2).
