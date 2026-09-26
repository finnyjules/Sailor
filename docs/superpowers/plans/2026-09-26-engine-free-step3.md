# Sailor without ComfyUI, step 3 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** everything Sailor offers runs without ComfyUI (except the stock local-diffusion nodes and blueprints, which stay local-only); this plan builds the first two slices in full — R0, results that aren't files passed between runner nodes, and R1, the text and data cards — and outlines R2–R11.

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

Modified: `server/runner/types.ts`, `engine.ts`, `executors.ts`, `metering.ts`, `store.ts`, `results.ts`, `inputs.ts`, `index.ts`, `compositor/plan.ts`; `shared/runner/eligibility.ts`, `families.ts`, `validate.ts`; `app/lib/taste/styleBlock.ts`; `server/api/render-template.post.ts`.

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

# R2–R11 — outline tasks (to be expanded before they are built)

Each outline task becomes a full task (tests and code) when its slice starts. Every paid family: its own switch, off by default; priced in `frontend/shared/pricing/` before switch-on; the backup rule; a live paid check with the user's go.

### Task R2.1: Picture kernels, and tone, colour, geometry, mask and blend effects (R2a, part 1)

Build `frontend/server/runner/pixels/` into a kernel set proven against torch fixtures one by one (`scripts/runner_pixels_fixtures.py`): torchvision-exact separable gaussian (kernel size and sigma rule of `torchvision.transforms.functional.gaussian_blur`, reflect padding), `F.interpolate` area and bilinear (R1.4's bilinear reused), `grid_sample` bilinear with border and zeros padding, colour matrices, HSL/HSV round trips as torchvision does them, Sobel. Then port the ~24 toolbox effects of `comfy_extras/nodes_adjust_*.py`, `nodes_color_filters.py`, `nodes_geometry.py`, `nodes_composite.py`, `nodes_matte.py`, `nodes_sharpen_noise.py` (except AddNoise) as `derive` plans in `frontend/server/runner/effects/`, run on the Frame's worker thread (`compositor/worker.ts` pattern) so a big picture doesn't block the server. Family `effects`. Acceptance: every kernel bit-exact in float32 against torch; every effect's 8-bit output equal to Python's saved 8-bit output for the fixture pictures; with `effects` off nothing changes.

### Task R2.2: Stylize effects, Painter and Add noise (R2a, part 2)

Port `nodes_stylize.py`, `nodes_blur.py`, `nodes_distortion.py` (coordinate warps on `grid_sample`), `nodes_glsl_stylize.py`'s Kuwahara, cross-hatch, dither and ASCII (the PIL glyph atlas rasterised the same way: ship the atlas PNG Python builds as a fixture and use it), Painter (`nodes_painter.py`, PIL Lanczos resize ported as a kernel with its own fixtures), and AddNoise (visually equal: the spec's measurable definition). Files `frontend/server/runner/effects/stylize.ts`, `painter.ts`, `noise.ts`. Acceptance: pixel-exact per the parity rules; AddNoise within the "visually equal" bounds on the fixed test picture, and the controller's side-by-side look.

### Task R2.3: The torch "GLSL" looks (R2b)

Port `nodes_glsl_atmosphere.py`, `nodes_glsl_lens.py`, `nodes_glsl_distortion.py`, `nodes_glsl_generative.py`, `nodes_glsl_lab.py` (k-means palette quantize with its exact init), `nodes_glsl_unicorn.py` (including Stipple and Flow field, which draw from a seeded `torch.Generator` on CPU: port torch's CPU random stream — mt19937 plus torch's float conversion — with fixtures of the raw draws first), `nodes_glsl_fractal.py`, `nodes_glsl_grading.py`. Files under `frontend/server/runner/effects/looks/`. Acceptance: each look pixel-exact against its fixtures; the torch-random port equal on 10,000 draws for three seeds.

### Task R2.4: Shader effect through the browser's bake (R2c, decision 9)

The canvas bakes the Shader effect at submit, as `injectCompositorOverlays` bakes Frame layers: the browser renders the node's `.frag` (the ShaderStudio renderer) at the node's resolution, aspect, time and seed, uploads the PNG, and writes its name into a new hidden `baked` input; the runner replays it as a bake (R1.3's machinery). A Shader effect whose `image` comes from a node in the same run can't be baked beforehand: until Open question 5 is answered, such a node is refused with "This shader needs its picture before the run; run the picture first". Files: `frontend/app/lib/runner/shaderBake.ts`, the submit hook in `app/layouts/default.vue` (a separate, minimal hunk), `frontend/server/runner/cards/shaderEffect.ts`. Acceptance: the replayed PNG is the browser's bytes; a saved project with a Shader effect runs engine-free; the refusal case is plain.

### Task R2.5: Live previews through the runner

The ~45 `LIVE_PREVIEW_NODE_TYPES` (`app/lib/livePreviewNodes.ts:21-74`) queue an engine run on every widget change. Route each class R2 ports through the runner (a small preview endpoint that runs one derive plan on a cached input, no hold, no record), keeping the engine path for classes not yet ported. Files: `frontend/server/api/runs/preview.post.ts`, `app/lib/livePreviewNodes.ts`. Acceptance: a slider drag on a ported effect never touches `/prompt`; hosted refuses a preview whose input isn't the user's.

### Task R3.1: The eight LLM text nodes

BrainstormIdeasNode, ChatLLMNode, ImprovePromptNode, ReasonStepByStepNode, RewriteToneNode, SummarizeTextNode, TranslateTextNode (Replicate LLM tables in `comfy_api_nodes/nodes_replicate.py:5584-6060`), and the Describe nodes' text outputs where they share the call. Provider plans with `media: 'value'` (R0.6), builders proven by `capture_first_call` fixtures, token-priced in `shared/pricing/` (`anthropicTokens.ts` pattern) with the hold at the maximum output tokens. Family `llm-text`. Acceptance: request fixtures equal; a text result feeds a Text card and Generate an image's idea socket (moderated at the turn, R0.5); reuse returns the text; the charge never exceeds the hold.

### Task R3.2: Describe, read, find and diarize

DescribeImageNode, DescribeVideoNode, ExtractTextNode, FindObjectsNode (JSON boxes), IdentifySpeakersNode (JSON segments), TranscribeAudioNode (fal wizper, shared with R7.3). `media: 'value'`, the exact Python string in `json` values. Family `describe`. Acceptance: request fixtures equal; the JSON text byte-equal to Python's on recorded provider answers (fixtures of the answer → the node's output).

### Task R3.3: Upscale, enhance, fix faces, restore

UpscaleImageNode (each engine), EnhanceDetailNode, FixFacesNode, RestorePhotoNode. Upscale's price by measured input size (model line-up open question 2: the runner measures). Family `image-repair`. Acceptance: request fixtures; size-priced hold from the measured picture; refusal above the input cap before the hold.

### Task R3.4: Layers and outpaint

SplitPhotoLayersNode, LayerizeGraphicNode, SeedreamLayerizeNode, OutpaintImageNode — several calls per node, pictures on several output slots (R0 values). Family `layers`. Acceptance: every call's request equals the fixture in order; a failure midway charges only the calls that finished (as `1d4c2c04c` does on the ComfyUI path).

### Task R3.5: Music, speech and voice

GenerateMusicNode, GenerateSpeechNode, CloneSingingVoiceNode — sound outputs as files; the sound hand-off (`handoff.ts` already sends sounds). Family `audio-gen`. Acceptance: request fixtures; the sound saved with the right extension; length-priced nodes priced from the settings sent.

### Task R3.6: 3D

Generate3DNode and Hunyuan3DMultiViewNode: the GLB downloaded and saved as an output asset, the value `{ kind: 'glb', url: <Sailor /view address>, file }` (spec ruling 1); Model3D (R1.1) and 3D Studio's `glb_url` read it. Family `gen-3d`. Acceptance: request fixtures; the address survives the provider link's expiry; hosted ownership of the saved GLB.

### Task R3.7: Film a shot, text effects, sketch, faces and LoRAs

FilmShotNode (the video table plus shot presets), TextEffectNode (the `text_effects.py` table), SketchToImageNode, ConsistentFaceNode, FluxLoRARemoteNode, FluxMultiLoRARemoteNode, RestyleWithLoRANode (several calls and its retry loop). LoRA files are read from `models/loras/` by name and handed off (hosted: the user's own). Family per group. Acceptance: request fixtures; RestyleWithLoRA's retry charges only the calls made.

### Task R3.8: Pose Mannequin, Lens reframe, Turntable

PoseMannequin and LensReframe (Nano Banana 2 on Replicate with the editor's bake replayed, R1.3's machinery); TurntableNode after R5 (segments plus an ffmpeg concat). Families `nano-extras`, `turntable`. Acceptance: request fixtures; Turntable's concat output equals Python's frame count and duration.

### Task R4.1: Retire the 182 partner nodes (decision 3)

Add every class billed through api.comfy.org (the inventory's list; mechanically, every `comfy_api_nodes/nodes_*.py` class except `nodes_replicate.py`) to a shared `RETIRED_CLASSES` (`frontend/shared/runner/retired.ts`). They leave the Actions panel and the Legacy toggle (`app/data/action-catalog.ts`, `GeneratorsPanel.vue:41-46`), node search (`useNodeSearch.ts:87-140`), the agent and start-modal catalogues, and are refused on both paths before any charge (`blockedModels.ts`' shape: a 400 like ComfyUI's `node_errors`, "This node was retired. Pick another way to make this."). The Python files stay (not edited by this programme). Acceptance: a guard test that every `api.comfy.org`-billed class in `objectInfo.baseline.json.gz` is retired; a saved workflow with one opens, shows the node as retired, and is refused before the hold.

### Task R5.1: ffmpeg in the server (decision 7)

Bundle an ffmpeg binary (build per Open question 4), found by `server/media/ffmpeg.ts` (`ffmpegPath()`, a clear error when missing), with `probe(file)`, `decodeFrames(file, { fps?, max })`, `encodeVideo(frames, { fps, codec, alpha })`, `decodeAudio(file) → Float32Array per channel + rate`, `encodeAudio(samples, { format })`, run as child processes with timeouts and a per-user limit. The Fly image and `docs/` deploy notes updated. Acceptance: round trips on fixture clips (frame count, fps, duration; decoded pixels within Open question 3's tolerance for H.264); no ffmpeg → the media nodes say "This needs the video tools" instead of crashing.

### Task R5.2: Frame batches and sound between runner nodes

A video between runner nodes is a file (mp4 or lossless intermediate) plus its measured frame count, size and rate; a frame batch is decoded lazily through R5.1. A sound is a file plus its rate and channels. Values: `files` with a `media` note. Port the 13 codec classes (LoadVideo, LoadVideoFrames, GetVideoComponents, CreateVideo, SaveVideo, SaveVideoFrames, LoadAudio, RecordAudio, SaveAudio, SaveAudioMP3, PreviewAudio, AudioWaveform) as derive plans. Family `media`. Acceptance: fixtures from the Python nodes on short clips — frame counts, rates, durations equal; decoded pixels and samples within tolerance.

### Task R5.3: Video thumbnails and waveforms natively

`GET /sailor/input_thumbnail` (video), `/sailor/asset_thumbnails` (video), `/sailor/asset_waveform` served by `server/native/media.ts` through R5.1, with the same cache names as the Python (`nodes_timeline.py:2247`, :2281, the waveform route). Acceptance: parity of response shapes and cache names; the 503 fallbacks in `useClipPreview.ts` and `TimelineEditor.vue` no longer hit with ComfyUI off.

### Task R6.1: Video frame-batch effects

The 20 classes of `nodes_video_effects.py` / `nodes_video_pro.py` / `nodes_frame_interp.py` (Farneback optical flow for FrameInterpolate: port OpenCV's Farneback with fixtures, or refuse with a plain message and point to Slow motion (AI), R7.3) / `nodes_audio_effects.py` VideoSilenceCut. CaptionTrack and TextClip rasterise text as PIL does: ship Python's glyph rasterisation as fixtures and match with a Node text renderer, or render in the browser at submit when the text is static. Transition's glitch style is "visually equal". Family `video-effects`. Acceptance: per-class fixtures on 8-frame clips, per the parity rules.

### Task R6.2: Sound effects

The 12 classes of `nodes_audio.py` / `nodes_audio_effects.py` / `nodes_audio_denoise.py` (noisereduce's spectral gating: port its STFT and gate with fixtures on a noisy tone). Family `audio-effects`. Acceptance: samples equal to Python within 1e-6 (float32) for the deterministic ones; denoise within a stated SNR of Python's.

### Task R7.1: Background, upscale, object removal, face restoration (decision 1)

BackgroundRemove → Replicate `851-labs/background-remover` (images; video frames per frame after R5); UpscaleImage (2×) → Replicate `nightmareai/real-esrgan` at scale 2; ObjectRemove → fal `object-removal` (quality tiers priced from its page); FaceRestore → the FixFacesNode call (R3.3). Each class keeps its node and moves whole (the model line-up's Ruling 10 pattern: `upgrade` in its rule row), with a label saying which service runs it. Family per model. Acceptance: request built against the saved provider schema; priced before switch-on; a live paid check per family.

### Task R7.2: Masks from text and clicks

MaskExtractor (clicks) and MaskByText (a phrase) → fal `sam-3/image` (`priceBook.ts:580`, already used by `/api/inpaint/segment`); the answer decoded into a `mask` value (R0.7). SubjectMask waits for Open question 2. Family `sam-3-masks`. Acceptance: the click and text payloads equal the saved schema; the mask value equals the provider's mask decoded; live check.

### Task R7.3: Slow motion (AI), transcription, vocal separation

FrameInterpolateAI → fal `rife/video` (per compute-second: priced at the ceiling for the clip's measured length, R5); WhisperTranscribe → fal `wizper` (its `caption_track` output built as Python builds it from segments); VocalSeparator → Replicate `demucs` (price measured by the live check, Open question 6). Families per model. Acceptance: schema-checked requests; outputs shaped like the Python node's outputs (two stems; text + caption track).

### Task R7.4: Lens · depth of field in the server

LensBlur on the in-process depth model (`server/api/depth/estimate.post.ts`, transformers.js Depth Anything V2 Small) plus a port of the depth-of-field blur (`comfy_extras/nodes_lens.py`, `_depth.py`) with R2.1's kernels. The depth model's output differs from Python's torch run; parity is on the blur given the same depth map (fixtures feed Python's depth). Free, family `lens-blur`. Wav2Lip's LipSync class retires (hidden, refused with a pointer to Lip-sync a character on sync-3). Acceptance: blur parity given the depth; a saved LipSync node says it was retired.

### Task R8.1–R8.4: The mini apps (decision 10)

Each app (`app/components/apps/*`, prompts built in `layouts/default.vue:4004-4007`) sends its workflow to `/api/runs` instead of `/prompt`: R8.1 Product shot (LoadImage → Background remove → Image to mask → Blend scene / Generate image → Save image; after R1, R7.1); R8.2 Karaoke (LoadAudio → Vocal separator → Save audio MP3; after R5, R7.3); R8.3 Auto subtitle (LoadVideo → Get video components → Whisper → Caption track → Create video → Save video; after R5, R6.1, R7.3); R8.4 Face swap (after Open question 1 — or its retirement). Acceptance per app: the app's workflow is runner-eligible with its families on; the result lands where the app shows it; its price shows before the run.

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

- **Spec coverage.** Decisions 1 → R7.1–R7.4; 2 → Open question 1, R8.4; 3 → R4.1; 4 → R10.2; 5 → R9.1; 6 → R10.3; 7 → R5.1; 8 → Global Constraints, every porting task; 9 → R2.4; 10 → R8.1–R8.4. Money rules → Global Constraints, R0.4 (price reads wires), R0.5 (refusal before hold), R0.6 (charged once), R1.2 (charge unchanged by wires). Slice map R0–R11 → the task list. "Persisted, resumable, sha-keyed" → R0.1 (record), R0.2 (kept by sha, swept), R0.6 (restart test). Masks and picture lists → R0.1, R0.7, R1.3, R1.4, R1.6.
- **Types used across tasks.** `RunnerValue` (R0.1) with `mask.files` everywhere; `slotValue`, `filesOf`, `filesOfValues`, `literalOf`, `checkValue`, `withWiredValues` (values.ts); `KeptBytes.put(runId, bytes, ext)`; `DeriveIO` / `Derived` / `staticDerive` (R0.4) — `saveAsset` gains `subfolder?`/`folder?` in R1.5 by name; `ResultEntry` (R0.6); `outputKind`, `valueInputsOf`, `valueWiresAllowed`, `STATIC_VALUES`, `staticValueOf`, `staticWiredTexts` (R0.3).
- **Known gaps, deliberate:** JPEG/WebP EXIF metadata not written (R1.5); Get image size's progress text not shown (R1.4); Gate choices on a text value (spec ruling 2).
