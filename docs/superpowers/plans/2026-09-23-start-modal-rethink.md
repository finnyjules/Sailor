# Start Modal Rethink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blank-project modal with layout A (AI and studios as two equal halves, a real picture on every tile) and make every pick land wired into a Frame.

**Architecture:** A data list (`app/data/start-modal.ts`) defines the 13 tiles. A pure planner (`app/lib/startModal/plan.ts`) turns a pick into nodes and edges; the canvas executes it with its existing `createNodeData`. Tile stills come from each studio's own renderer via `app/lib/startModal/stills.ts`; AI tiles use shipped pictures. Pattern and Shader gain live Frame sources so their wires paint.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>`, TypeScript, Tailwind, Vue Flow, Vitest (+ happy-dom, @vue/test-utils), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-start-modal-rethink-design.md` (visual reference: https://claude.ai/artifact/XRHvdXrY4GmQ1DzyCHP5r9, layout A)

## Global Constraints

- Work in the main checkout (`/Users/julien/Documents/GitHub/Sailor`). No worktree, no branch, never `git stash`.
- **Subagents do NOT commit.** Implement, test, and report the exact file paths you changed plus test output. The controller commits with a private index.
- **Never run `npm run dev`** or start/stop any server. The dev server on `:3002` is shared.
- Leave files you did not write alone, even if they look broken. `VueNodeCanvas.vue`, `default.vue`, `CompositorModal.vue` have other sessions' uncommitted edits in them: edit only your own hunks.
- UI copy: sentence case, no node or model identifiers on tiles.
- Run unit tests from `frontend/`: `npx vitest run <path>`. Typecheck is noisy repo-wide; judge only errors in files you touched (`npx vue-tsc --noEmit 2>&1 | grep -E "<your files>"`).
- Frame = node type `Compositor`, first image input named `layer1`.
- In `VueNodeCanvas.vue`, push each node into `nodes.value` BEFORE minting the next one with `createNodeData` (mintNodeId only dedupes against pushed nodes).

---

### Task 1: The modal's lineup as data

**Files:**
- Create: `frontend/app/data/start-modal.ts`
- Modify: `frontend/app/data/action-catalog.ts:161-172` (delete `MODAL_HERO_CAPS` and `modalHero`)
- Modify: `frontend/tests/unit/action-catalog.unit.spec.ts` (delete the two `modalHero` tests and its import)
- Test: `frontend/tests/unit/start-modal-lineup.unit.spec.ts`

**Interfaces:**
- Produces: `type StartPickId`, `interface StartTile { id: StartPickId; name: string; line: string; kind: 'ai' | 'hand'; credits: boolean }`, `START_AI: StartTile[]`, `startHandTiles(spaceTypeEnabled?: boolean): StartTile[]`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/start-modal-lineup.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { START_AI, startHandTiles } from '../../app/data/start-modal'
import { STUDIO_OPTIONS } from '../../app/data/studio-options'

describe('start modal lineup', () => {
  it('has five AI ways, in order, all using credits', () => {
    expect(START_AI.map(t => t.name)).toEqual([
      'Generate an image', 'An image in a style', 'Edit an image', 'Upscale an image', 'Generate a video',
    ])
    expect(START_AI.every(t => t.kind === 'ai' && t.credits)).toBe(true)
  })

  it('has eight studios with Expressive on, seven with it off', () => {
    expect(startHandTiles(true).map(t => t.name)).toEqual([
      'Expressive', 'Gradient', 'Shader', 'Pattern', 'Shape', 'Vector type', '3D', 'Moodboard',
    ])
    expect(startHandTiles(false).map(t => t.name)).not.toContain('Expressive')
    expect(startHandTiles(false)).toHaveLength(7)
    expect(startHandTiles(true).every(t => t.kind === 'hand' && !t.credits)).toBe(true)
  })

  it('leaves the toolbar Studios door alone', () => {
    const door = STUDIO_OPTIONS.map(o => o.label)
    expect(door).toContain('Shot Director')
    expect(door).toContain('Lip-Sync')
    const modal = [...START_AI, ...startHandTiles(true)].map(t => t.name)
    expect(modal).not.toContain('Shot Director')
    expect(modal).not.toContain('Lip-Sync')
  })

  it('every caption line fits one line (≤ 30 chars)', () => {
    for (const t of [...START_AI, ...startHandTiles(true)]) expect(t.line.length, t.name).toBeLessThanOrEqual(30)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../../app/data/start-modal'`)

Run: `cd frontend && npx vitest run tests/unit/start-modal-lineup.unit.spec.ts`

- [ ] **Step 3: Implement**

```ts
// frontend/app/data/start-modal.ts
// The blank-project modal's own lineup (spec 2026-09-23). Deliberately separate
// from STUDIO_OPTIONS (the toolbar Studios door), which keeps studios that are
// not ready to be a first impression (Shot Director, Lip-Sync).
import { SPACE_TYPE_ENABLED } from '~/lib/spaceTypeEnabled'

export type StartPickId =
  | 'gen' | 'style' | 'edit' | 'upscale' | 'video'
  | 'expressive' | 'gradient' | 'shader' | 'pattern' | 'shape' | 'vectortype' | 'scene3d' | 'moodboard'

export interface StartTile {
  id: StartPickId
  name: string
  /** One short line under the name; must fit one line on the tile. */
  line: string
  kind: 'ai' | 'hand'
  /** Picking it spends credits when run — the tile carries the pastel dot. */
  credits: boolean
}

export const START_AI: StartTile[] = [
  { id: 'gen', name: 'Generate an image', line: 'Describe it, pick a model', kind: 'ai', credits: true },
  { id: 'style', name: 'An image in a style', line: 'Your prompt, a chosen look', kind: 'ai', credits: true },
  { id: 'edit', name: 'Edit an image', line: 'Change it in words', kind: 'ai', credits: true },
  { id: 'upscale', name: 'Upscale an image', line: 'Sharper, up to 4×', kind: 'ai', credits: true },
  { id: 'video', name: 'Generate a video', line: 'From words or a picture', kind: 'ai', credits: true },
]

const HAND: StartTile[] = [
  { id: 'expressive', name: 'Expressive', line: 'Type that moves', kind: 'hand', credits: false },
  { id: 'gradient', name: 'Gradient', line: 'Soft colour fields', kind: 'hand', credits: false },
  { id: 'shader', name: 'Shader', line: 'Live, animated surfaces', kind: 'hand', credits: false },
  { id: 'pattern', name: 'Pattern', line: 'Repeats and terrazzo', kind: 'hand', credits: false },
  { id: 'shape', name: 'Shape', line: 'Marks built from copies', kind: 'hand', credits: false },
  { id: 'vectortype', name: 'Vector type', line: 'Letters you can stretch', kind: 'hand', credits: false },
  { id: 'scene3d', name: '3D', line: 'A lit scene with objects', kind: 'hand', credits: false },
  { id: 'moodboard', name: 'Moodboard', line: 'Collect your references', kind: 'hand', credits: false },
]

export function startHandTiles(spaceTypeEnabled: boolean = SPACE_TYPE_ENABLED): StartTile[] {
  return spaceTypeEnabled ? HAND : HAND.filter(t => t.id !== 'expressive')
}
```

In `action-catalog.ts` delete lines 161–172 (the `// Start-modal hero tier` comment, `MODAL_HERO_CAPS`, `modalHero`). Keep `HERO_BY_DOMAIN` and `ARTIFACT_NODE_FOR_SOURCE`. In `action-catalog.unit.spec.ts` delete the tests `'modalHero returns 8 catalog-backed entries with per-domain caps'` and `'every non-create modalHero entry declares a source, and sources map to artifacts'`, and remove `modalHero` from the import list. (`StartProjectModal.vue` still imports `modalHero` until Task 6 — that file will not compile between Task 1 and Task 6; Task 6 replaces it. Do not touch it here.)

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run tests/unit/start-modal-lineup.unit.spec.ts tests/unit/action-catalog.unit.spec.ts`

- [ ] **Step 5: Report** the 4 file paths and test output to the controller (controller commits: `feat(start): the start modal's lineup as its own list`).

---

### Task 2: The pick planner

**Files:**
- Create: `frontend/app/lib/startModal/plan.ts`
- Test: `frontend/tests/unit/start-modal-plan.unit.spec.ts`

**Interfaces:**
- Consumes: `StartPickId` from Task 1.
- Produces:
```ts
export type PlanKey = string
export interface PlanNode { key: PlanKey; nodeType: string; col: number; widgets?: Record<string, unknown>; starter?: 'shaderPicture' | 'scene3dObject' }
export interface PlanEdge { from: PlanKey; out: number; to: PlanKey; input: string /* input NAME, or '@IMAGE' = first IMAGE input */ }
export interface StartPlan { nodes: PlanNode[]; edges: PlanEdge[] }
export function planStart(pick: StartPickId | null): StartPlan
```
`col` is a left-to-right column index; the canvas turns it into x. The Frame always has key `'frame'`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/start-modal-plan.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { planStart } from '../../app/lib/startModal/plan'

const types = (p: ReturnType<typeof planStart>) => p.nodes.map(n => n.nodeType)
const wires = (p: ReturnType<typeof planStart>) => p.edges.map(e => `${e.from}:${e.out}->${e.to}.${e.input}`)

describe('planStart', () => {
  it('skip is a lone Frame', () => {
    const p = planStart(null)
    expect(types(p)).toEqual(['Compositor'])
    expect(p.edges).toEqual([])
  })

  it.each([
    ['gen', 'GenerateImageNode'], ['style', 'FluxLoRARemoteNode'], ['upscale', 'UpscaleImageNode'],
    ['gradient', 'GradientStudio'], ['pattern', 'TextureStudio'], ['shape', 'ShapeStudio'],
    ['vectortype', 'VectorType'], ['expressive', 'SpaceType'], ['scene3d', 'Scene3DStudio'],
  ] as const)('%s → %s wired into the Frame', (pick, nodeType) => {
    const p = planStart(pick)
    expect(types(p)).toEqual([nodeType, 'Compositor'])
    expect(wires(p)).toEqual(['a:0->frame.layer1'])
    expect(p.nodes.map(n => n.col)).toEqual([0, 1])
  })

  it('edit is Image → Edit → Frame', () => {
    const p = planStart('edit')
    expect(types(p)).toEqual(['Image', 'EditImageNode', 'Compositor'])
    expect(wires(p)).toEqual(['src:0->a.@IMAGE', 'a:0->frame.layer1'])
  })

  it('shader starts from a bundled picture', () => {
    const p = planStart('shader')
    expect(types(p)).toEqual(['Image', 'ShaderStudio', 'Compositor'])
    expect(p.nodes[0]!.starter).toBe('shaderPicture')
    expect(wires(p)).toEqual(['src:0->a.image', 'a:0->frame.layer1'])
  })

  it('moodboard feeds an image generator as its style', () => {
    const p = planStart('moodboard')
    expect(types(p)).toEqual(['Moodboard', 'GenerateImageNode', 'Compositor'])
    expect(wires(p)).toEqual(['src:0->a.style_in', 'a:0->frame.layer1'])
  })

  it('video sits beside the Frame, unwired', () => {
    const p = planStart('video')
    expect(types(p)).toEqual(['GenerateVideoNode', 'Compositor'])
    expect(p.edges).toEqual([])
  })

  it('3D starts with an object so it is never an empty scene', () => {
    expect(planStart('scene3d').nodes[0]!.starter).toBe('scene3dObject')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `cd frontend && npx vitest run tests/unit/start-modal-plan.unit.spec.ts`

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/startModal/plan.ts
// Pure: what a start-modal pick puts on the canvas (spec 2026-09-23, "What each
// pick puts on the canvas"). Every project gets a Frame (key 'frame'); the pick
// sits to its left and, where it makes a picture, is wired into layer1.
// VueNodeCanvas.materializeStart executes the plan with createNodeData.
import type { StartPickId } from '~/data/start-modal'

export type PlanKey = string
export interface PlanNode { key: PlanKey; nodeType: string; col: number; widgets?: Record<string, unknown>; starter?: 'shaderPicture' | 'scene3dObject' }
/** `input` is an input NAME on the target, or '@IMAGE' for its first IMAGE input. */
export interface PlanEdge { from: PlanKey; out: number; to: PlanKey; input: string }
export interface StartPlan { nodes: PlanNode[]; edges: PlanEdge[] }

const SINGLE: Partial<Record<StartPickId, string>> = {
  gen: 'GenerateImageNode',
  style: 'FluxLoRARemoteNode',
  upscale: 'UpscaleImageNode',
  gradient: 'GradientStudio',
  pattern: 'TextureStudio',
  shape: 'ShapeStudio',
  vectortype: 'VectorType',
  expressive: 'SpaceType',
  scene3d: 'Scene3DStudio',
}

const intoFrame = (from: PlanKey): PlanEdge => ({ from, out: 0, to: 'frame', input: 'layer1' })

export function planStart(pick: StartPickId | null): StartPlan {
  if (pick === null) return { nodes: [{ key: 'frame', nodeType: 'Compositor', col: 0 }], edges: [] }

  const single = SINGLE[pick]
  if (single) {
    const a: PlanNode = { key: 'a', nodeType: single, col: 0 }
    if (pick === 'scene3d') a.starter = 'scene3dObject'
    return { nodes: [a, { key: 'frame', nodeType: 'Compositor', col: 1 }], edges: [intoFrame('a')] }
  }

  switch (pick) {
    case 'edit':
      return {
        nodes: [
          { key: 'src', nodeType: 'Image', col: 0 },
          { key: 'a', nodeType: 'EditImageNode', col: 1 },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: '@IMAGE' }, intoFrame('a')],
      }
    case 'shader':
      return {
        nodes: [
          { key: 'src', nodeType: 'Image', col: 0, starter: 'shaderPicture' },
          { key: 'a', nodeType: 'ShaderStudio', col: 1 },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: 'image' }, intoFrame('a')],
      }
    case 'moodboard':
      return {
        nodes: [
          { key: 'src', nodeType: 'Moodboard', col: 0 },
          { key: 'a', nodeType: 'GenerateImageNode', col: 1 },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: 'style_in' }, intoFrame('a')],
      }
    case 'video':
      // The Frame has no video input — the video plays on its own node.
      return {
        nodes: [
          { key: 'a', nodeType: 'GenerateVideoNode', col: 0 },
          { key: 'frame', nodeType: 'Compositor', col: 1 },
        ],
        edges: [],
      }
  }
  return { nodes: [{ key: 'frame', nodeType: 'Compositor', col: 0 }], edges: [] }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run tests/unit/start-modal-plan.unit.spec.ts`

- [ ] **Step 5: Report** paths + output (controller commits: `feat(start): a pure planner for what each start pick puts on the canvas`).

---

### Task 3: Live Frame sources for Pattern and Shader

Without these, a Pattern → Frame or Shader → Frame wire paints nothing until a run (`frameResolve.ts` prefers a registered live source; these two register only a baker).

**Files:**
- Create: `frontend/app/lib/texturefx/frameSource.ts`
- Create: `frontend/app/lib/shaderstudio/frameSource.ts`
- Modify: `frontend/app/components/vue-canvas/TextureStudioNode.vue` (register/unregister in `onMounted`/`onBeforeUnmount`, lines ~106-117)
- Modify: `frontend/app/components/vue-canvas/ShaderStudioNode.vue` (register/unregister next to `registerStudioBaker`, lines ~188-192)
- Test: `frontend/tests/unit/texture-shader-frame-source.unit.spec.ts`

**Interfaces:**
- Consumes: `StudioFrameSource`, `registerStudioFrameSource`, `unregisterStudioFrameSource` from `~/lib/studio/frameSource`; `renderSheetCanvas(p)` from `~/lib/texturefx/bake`; `sheetFromParams(p)` from `~/lib/texturefx/sheet`.
- Produces: `makeTextureFrameSource(deps: { getParams: () => Params; render: (p: Params) => HTMLCanvasElement; size: (p: Params) => { w: number; h: number } }): StudioFrameSource`; `makeShaderFrameSource(deps: { getSize: () => { w: number; h: number }; getDuration: () => number; render: (t01: number, w: number, h: number) => Promise<TexImageSource | null> }): StudioFrameSource`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/texture-shader-frame-source.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { makeTextureFrameSource } from '../../app/lib/texturefx/frameSource'
import { makeShaderFrameSource } from '../../app/lib/shaderstudio/frameSource'

describe('makeTextureFrameSource', () => {
  it('is a still at the sheet size and renders the current params', async () => {
    let params: any = { a: 1 }
    const canvas = { tag: 'sheet' } as any
    const render = vi.fn(() => canvas)
    const src = makeTextureFrameSource({ getParams: () => params, render, size: p => ({ w: p.a * 100, h: 50 }) })
    expect(src.duration).toBe(0)
    expect(src.width).toBe(100)
    params = { a: 3 }
    expect(src.width).toBe(300)       // live getter, not a snapshot
    expect(await src.getFrame(0.5, 10, 10)).toBe(canvas)
    expect(render).toHaveBeenCalledWith(params)
  })
})

describe('makeShaderFrameSource', () => {
  it('reports the node clock and size and forwards frames', async () => {
    const frame = { tag: 'f' } as any
    const render = vi.fn(async () => frame)
    const src = makeShaderFrameSource({ getSize: () => ({ w: 640, h: 480 }), getDuration: () => 4, render })
    expect([src.width, src.height, src.duration]).toEqual([640, 480, 4])
    expect(await src.getFrame(0.25, 320, 240)).toBe(frame)
    expect(render).toHaveBeenCalledWith(0.25, 320, 240)
  })

  it('rejects rather than returning nothing when the shader has no picture', async () => {
    const src = makeShaderFrameSource({ getSize: () => ({ w: 1, h: 1 }), getDuration: () => 0, render: async () => null })
    await expect(src.getFrame(0, 1, 1)).rejects.toThrow(/no picture/)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (modules not found)

Run: `cd frontend && npx vitest run tests/unit/texture-shader-frame-source.unit.spec.ts`

- [ ] **Step 3: Implement the adapters**

```ts
// frontend/app/lib/texturefx/frameSource.ts
// Pattern (Texture Studio) as a live Frame source — a still: the Frame pulls the
// same full sheet the studio exports (renderSheetCanvas), at the sheet's own size.
// Same shape as lib/geoshape/frameSource.ts. `render` is injected for unit tests.
import type { StudioFrameSource } from '~/lib/studio/frameSource'
import type { Params } from '~/lib/spacetype/effect'

export interface TextureFrameDeps {
  getParams: () => Params
  render: (p: Params) => HTMLCanvasElement
  size: (p: Params) => { w: number; h: number }
}

export function makeTextureFrameSource(deps: TextureFrameDeps): StudioFrameSource {
  return {
    duration: 0,
    fps: 30,
    get width() { return deps.size(deps.getParams()).w },
    get height() { return deps.size(deps.getParams()).h },
    getFrame: async () => deps.render(deps.getParams()),
  }
}
```

```ts
// frontend/app/lib/shaderstudio/frameSource.ts
// Shader Studio as a live Frame source. The node already renders frames for its
// card (renderFrame in ShaderStudioNode.vue); this adapts that to the registry
// contract. A shader with no picture wired in has nothing to show — reject, so the
// Frame reports it instead of painting an empty layer silently.
import type { StudioFrameSource } from '~/lib/studio/frameSource'

export interface ShaderFrameDeps {
  getSize: () => { w: number; h: number }
  getDuration: () => number
  render: (t01: number, w: number, h: number) => Promise<TexImageSource | null>
}

export function makeShaderFrameSource(deps: ShaderFrameDeps): StudioFrameSource {
  return {
    fps: 30,
    get duration() { return deps.getDuration() },
    get width() { return deps.getSize().w },
    get height() { return deps.getSize().h },
    getFrame: async (t01, w, h) => {
      const out = await deps.render(t01, w, h)
      if (!out) throw new Error('shader studio: no picture wired in')
      return out
    },
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Register them in the nodes**

`TextureStudioNode.vue` — add imports and register in `onMounted`, unregister in `onBeforeUnmount`:

```ts
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { makeTextureFrameSource } from '~/lib/texturefx/frameSource'
import { renderSheetCanvas } from '~/lib/texturefx/bake'
// sheetFromParams is already imported from '~/lib/texturefx/sheet'

// inside onMounted, after registerStudioBaker(props.id, bakeOutput):
registerStudioFrameSource(props.id, makeTextureFrameSource({
  getParams: () => params.value,
  render: p => renderSheetCanvas(p),
  size: p => { const s = sheetFromParams(p); return { w: s.w, h: s.h } },
}))

// onBeforeUnmount becomes:
onBeforeUnmount(() => { if (timer) clearTimeout(timer); unregisterStudioBaker(props.id); unregisterStudioFrameSource(props.id) })
```

Before writing, open `lib/texturefx/sheet.ts` and confirm `sheetFromParams` returns an object with numeric `w` and `h` (it is used that way at `TextureStudioNode.vue` ~line 55 via `view.w`). If the field names differ, use the real ones.

`ShaderStudioNode.vue` — read lines 60–200 first. `renderFrame(t01)` draws the card; `bakeOutput` renders full-size through `shaderFx.render(passes, base, w, h)` while holding the bake lock. Add a function `renderForFrame(t01, w, h): Promise<TexImageSource | null>` that follows `bakeOutput`'s pipeline (resolve the source, `composePasses`, `shaderFx.render` at `w × h`), takes the same bake lock, and **copies the result into its own canvas synchronously before returning** (the shaderFx canvas is shared — see the long comment above `SNAP_POOL` in `lib/gradientfx/frameSource.ts`, and reuse that snapshot-pool approach). Then register:

```ts
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { makeShaderFrameSource } from '~/lib/shaderstudio/frameSource'

// next to registerStudioBaker(props.id, bakeOutput):
registerStudioFrameSource(props.id, makeShaderFrameSource({
  getSize: () => { const d = outputDims(config.value); return { w: d.w, h: d.h } },
  getDuration: () => clockDuration(),
  render: renderForFrame,
}))
// and in onBeforeUnmount: unregisterStudioFrameSource(props.id)
```

Check `outputDims`'s real return shape in `lib/shaderstudio/types.ts` and the real name of the node's config ref before using them. **Loop guard:** Shader Studio itself resolves its input through `frameSourceEpoch` (line ~47); registering a source bumps the epoch. Confirm that registering doesn't make the node re-resolve itself in a loop (its input is the upstream Image, not itself). If it does loop, stop and report back rather than papering over it.

- [ ] **Step 6: Run the adapter tests plus existing Pattern and Shader tests**

Run: `cd frontend && npx vitest run tests/unit/texture-shader-frame-source.unit.spec.ts $(ls tests/unit | grep -iE "texture|shader-studio|shaderstudio|frame-source|frameSource" | sed 's#^#tests/unit/#')`
Expected: all PASS.

- [ ] **Step 7: Report** paths + output (controller commits: `feat(frame): Pattern and Shader paint live in a wired Frame`).

---

### Task 4: `materializeStart` on the canvas, and the layout wiring

**Files:**
- Modify: `frontend/app/components/vue-canvas/VueNodeCanvas.vue`: replace `materializeStartGraph` (~7770–7835) and `materializeImageShowcase` (~7837–end of that function) with `materializeStart`; update `defineExpose` (~line 7967). Keep `buildStartNodeData`, `pushStartNode` and `wireStartPair` only if something else still uses them (grep); delete them otherwise.
- Create: `frontend/public/start-modal/shader-starter.webp` (copy of `frontend/public/house-styles/azure-bloom/thumb-1.webp`)
- Modify: `frontend/app/layouts/default.vue` lines 308–342 (`onStartModalPick`, `onStartModalStudio`, `onStartModalSkip`) and the `<StartProjectModal>` usage at ~4570
- Test: covered by Task 2's planner test + Task 8's browser pass (this task is execution glue inside a 8000-line component).

**Interfaces:**
- Consumes: `planStart`, `StartPlan` (Task 2); `StartPickId` (Task 1); `createNodeData`, `nodes`, `edges`, `objectInfo`, `fetchObjectInfo`, `fitView`, `toast` (existing in VueNodeCanvas); `defaultDoc`, `createPrimitive`, `serializeDoc`, `PLACEABLE_PRIMITIVE_KINDS` from `~/lib/scene3d/config`.
- Produces: exposed `materializeStart(pick: StartPickId | null): Promise<boolean>`; `StartProjectModal` emits `start: [pick: StartPickId | null]` (Task 6 builds the modal to this contract).

- [ ] **Step 1: Copy the starter picture**

```bash
mkdir -p frontend/public/start-modal && cp frontend/public/house-styles/azure-bloom/thumb-1.webp frontend/public/start-modal/shader-starter.webp
```

- [ ] **Step 2: Add `materializeStart` to VueNodeCanvas.vue** (where `materializeStartGraph` was)

```ts
/**
 * The start modal's pick → canvas (spec 2026-09-23). Every project gets a Frame;
 * the pick lands to its left, wired into layer1 when it makes a picture. The
 * node/edge recipe is the pure planStart (unit-tested); this mints and wires.
 * Returns false (and toasts) when a node type is missing from object_info.
 */
async function materializeStart(pick: StartPickId | null): Promise<boolean> {
  const plan = planStart(pick)
  if (!objectInfo.value['Compositor']) await fetchObjectInfo()
  // Frontend-only studios (GradientStudio, SpaceType, …) never appear in object_info;
  // everything else must, or the pick can't be built.
  const missing = plan.nodes.find(n => !FRONTEND_ONLY_START_TYPES.has(n.nodeType) && !objectInfo.value[n.nodeType])
  if (missing) {
    toast.error('Couldn’t set up the project', { description: `The backend doesn’t provide “${missing.nodeType}”. Check that ComfyUI is running and up to date, then try again from the + menu.` })
    return false
  }

  const COL_W = 320
  const minted = new Map<string, any>()
  for (const pn of plan.nodes) {
    const widgets: Record<string, unknown> = { ...(pn.widgets ?? {}) }
    if (pn.starter === 'shaderPicture') {
      const name = await uploadStarterPicture('/start-modal/shader-starter.webp')
      if (name) widgets.image = name
    }
    if (pn.starter === 'scene3dObject') widgets.scene_state = starterSceneState()
    const node = createNodeData(pn.nodeType, { x: pn.col * COL_W, y: 0 }, Object.keys(widgets).length ? widgets : undefined)
    nodes.value.push(node) // push before minting the next id (mintNodeId dedupes against nodes.value)
    minted.set(pn.key, node)
  }

  for (const pe of plan.edges) {
    const from = minted.get(pe.from), to = minted.get(pe.to)
    if (!from || !to) continue
    const ins = (to.data.inputs ?? []) as any[]
    const idx = pe.input === '@IMAGE'
      ? ins.findIndex(i => String(i.type).toUpperCase() === 'IMAGE')
      : ins.findIndex(i => i.name === pe.input)
    const out = (from.data.outputs ?? [])[pe.out]
    if (idx < 0 || !out) { console.warn('[start] cannot wire', pe, 'on', to.data.nodeType); continue }
    edges.value.push({
      id: `e-start-${from.id}-${to.id}`,
      source: from.id,
      sourceHandle: `output-${pe.out}`,
      target: to.id,
      targetHandle: `input-${idx}`,
      type: 'comfy',
      data: { dataType: String(out.type).toUpperCase() === '*' ? 'IMAGE' : String(out.type).toUpperCase() },
    } as any)
  }

  await nextTick()
  fitView({ padding: 0.3 })
  return true
}

const FRONTEND_ONLY_START_TYPES = new Set(['GradientStudio', 'ShaderStudio', 'TextureStudio', 'ShapeStudio', 'VectorType', 'SpaceType'])

/** Upload a bundled picture to ComfyUI's input folder so an Image card can hold it. */
async function uploadStarterPicture(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob()
    const fd = new FormData()
    fd.append('image', new File([blob], url.split('/').pop()!, { type: blob.type }))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    return (await res.json())?.name ?? null
  }
  catch (e) {
    console.error('[start] starter picture upload failed', e)
    toast.error('Couldn’t add the starter picture', { description: 'Drop any image onto the Image card to feed the Shader.' })
    return null
  }
}

/** A 3D scene with one object, so the studio never starts empty. */
function starterSceneState(): string {
  const doc = defaultDoc()
  const kind = (['torusKnot', 'sphere', 'box'] as const).find(k => (PLACEABLE_PRIMITIVE_KINDS as string[]).includes(k)) ?? PLACEABLE_PRIMITIVE_KINDS[0]!
  doc.objects.push(createPrimitive(kind as any, doc.objects))
  return serializeDoc(doc)
}
```

Imports to add at the top of the script: `import { planStart } from '~/lib/startModal/plan'`, `import type { StartPickId } from '~/data/start-modal'`, and `defaultDoc, createPrimitive, serializeDoc, PLACEABLE_PRIMITIVE_KINDS` from `~/lib/scene3d/config` (merge with any existing import from that module). Before using them, verify:
- `Moodboard` is in object_info when ComfyUI runs (it has a Python twin). If it is not guaranteed, add it to `FRONTEND_ONLY_START_TYPES`, since `createNodeData` synthesises its `style` output.
- `Scene3DStudio`'s first output is `beauty` (index 0). If not, the planner's `out: 0` for scene3d must change (update Task 2's test with it).
- `SceneDoc.objects` is the array name and `createPrimitive(kind, existing)` is the signature (`config.ts:1014`).

Replace `materializeStartGraph` in `defineExpose` with `materializeStart`. Grep for other callers of `materializeStartGraph` (`seedStarterGraph` in default.vue uses it for the homepage `seedNodeType` path, which the spec keeps unchanged). **Keep `materializeStartGraph` for that caller** but drop its showcase branch (`if (opts.generatorNodeType === 'GenerateImageNode' && !opts.sourceNodeType) return materializeImageShowcase()`), and delete `materializeImageShowcase` entirely. The homepage "Create an image" card seeds `FluxLoRARemoteNode`, so it was never going through the showcase anyway.

- [ ] **Step 3: Wire the layout** (`default.vue`)

Replace `onStartModalPick`, `onStartModalStudio` and `onStartModalSkip` with one handler, and bind it:

```ts
// Start modal → canvas. Every pick (including skip = null) builds through the
// canvas's materializeStart, so every blank project gets its Frame.
function onStartModalStart(pick: StartPickId | null) {
  startModalTabId.value = null
  nextTick(async () => {
    const canvas = vueCanvasRef.value
    if (!canvas?.materializeStart) {
      toast.error('Couldn’t set up the project', {
        description: vueNodesEnabled.value
          ? 'The canvas didn’t finish loading. Refresh the page and try again.'
          : 'Turn on Settings → Modern node design to use starter projects.',
      })
      return
    }
    await canvas.refreshSchema?.()
    await canvas.materializeStart(pick)
  })
}
```

```html
<StartProjectModal
  v-if="startModalTabId && activeTabId === startModalTabId"
  @start="onStartModalStart"
/>
```

Add `import type { StartPickId } from '~/data/start-modal'`. Remove the now-unused `ActionSource` / `ARTIFACT_NODE_FOR_SOURCE` imports only if nothing else in default.vue uses them (grep first).

- [ ] **Step 4: Typecheck your files**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "VueNodeCanvas.vue|layouts/default.vue|startModal/plan.ts" | head -30`
Expected: no NEW errors on lines you touched. Compare with `git stash`-free baseline: run the same grep against the output before your edits (save it first) and diff.

- [ ] **Step 5: Report** paths + typecheck evidence (controller commits: `feat(start): every start pick lands wired into a Frame; the image tour retires`).

---

### Task 5: Studio stills for the tiles

**Files:**
- Create: `frontend/app/lib/startModal/stills.ts`
- Create: `frontend/app/composables/useStartTileHover.ts`
- Test: `frontend/tests/unit/start-modal-stills.unit.spec.ts`

**Interfaces:**
- Consumes: `StartPickId` (Task 1).
- Produces:
```ts
export type StillRenderer = (canvas: HTMLCanvasElement, t: number) => void | Promise<void>
export const ANIMATED_STILLS: ReadonlySet<StartPickId>   // gradient, pattern, vectortype, expressive
export function stillRendererFor(id: StartPickId): StillRenderer | null   // null for AI tiles
export async function paintStill(id: StartPickId, canvas: HTMLCanvasElement, t?: number, renderers?: Partial<Record<StartPickId, StillRenderer>>): Promise<boolean>
// composable
export function useStartTileHover(): { enter(id: StartPickId, canvas: HTMLCanvasElement): void; leave(id: StartPickId): void; stopAll(): void }
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/start-modal-stills.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { paintStill, ANIMATED_STILLS, stillRendererFor } from '../../app/lib/startModal/stills'

describe('start modal stills', () => {
  it('AI tiles have no renderer (they use shipped pictures)', () => {
    for (const id of ['gen', 'style', 'edit', 'upscale', 'video'] as const) expect(stillRendererFor(id)).toBeNull()
  })

  it('every studio tile has a renderer', () => {
    for (const id of ['expressive', 'gradient', 'shader', 'pattern', 'shape', 'vectortype', 'scene3d', 'moodboard'] as const) {
      expect(stillRendererFor(id), id).toBeTypeOf('function')
    }
  })

  it('only synchronous, time-driven studios animate on hover', () => {
    expect([...ANIMATED_STILLS].sort()).toEqual(['expressive', 'gradient', 'pattern', 'vectortype'])
  })

  it('a failed still reports false and logs the studio name — no fake picture', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const canvas = document.createElement('canvas')
    const ok = await paintStill('gradient', canvas, 0, { gradient: () => { throw new Error('no WebGL') } })
    expect(ok).toBe(false)
    expect(err.mock.calls[0]!.join(' ')).toMatch(/gradient/)
    err.mockRestore()
  })

  it('a working still reports true', async () => {
    const canvas = document.createElement('canvas')
    const draw = vi.fn()
    expect(await paintStill('shape', canvas, 0, { shape: draw })).toBe(true)
    expect(draw).toHaveBeenCalledWith(canvas, 0)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd frontend && npx vitest run tests/unit/start-modal-stills.unit.spec.ts`

- [ ] **Step 3: Implement `stills.ts`**

Each renderer draws into the tile's canvas at the canvas's current pixel size, from the same defaults a fresh node starts with. Renderers are lazily imported so the modal doesn't pull every studio into the initial bundle.

```ts
// frontend/app/lib/startModal/stills.ts
// Real stills for the start modal's studio tiles, drawn by each studio's own
// renderer from the settings a fresh node starts with (spec: "the tile shows
// what you'll get"). A failure leaves the tile's placeholder and logs — never a
// stand-in picture that hides the failure.
import type { StartPickId } from '~/data/start-modal'

export type StillRenderer = (canvas: HTMLCanvasElement, t: number) => void | Promise<void>

export const ANIMATED_STILLS: ReadonlySet<StartPickId> = new Set(['gradient', 'pattern', 'vectortype', 'expressive'])

function blit(canvas: HTMLCanvasElement, src: CanvasImageSource, sw: number, sh: number) {
  const ctx = canvas.getContext('2d')!
  const s = Math.max(canvas.width / sw, canvas.height / sh) // cover
  const w = sw * s, h = sh * s
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(src, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
}

const RENDERERS: Partial<Record<StartPickId, StillRenderer>> = {
  gradient: async (canvas, t) => {
    const { gradientFx } = await import('~/lib/gradientfx/renderer')
    const { defaultConfig } = await import('~/lib/gradientfx/randomize')
    const out = gradientFx.render(defaultConfig(), canvas.width, canvas.height, t) as HTMLCanvasElement
    blit(canvas, out, canvas.width, canvas.height)
  },
  pattern: async (canvas, t) => {
    const { textureFx } = await import('~/lib/texturefx/renderer')
    const { textureDefaults } = await import('~/lib/texturefx/controls')
    const { stylizeTile } = await import('~/lib/texturefx/stylize')
    const p = textureDefaults()
    const tile = 128
    const out = stylizeTile(textureFx.render(p, tile, tile, t), p, tile, tile)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = ctx.createPattern(out as CanvasImageSource, 'repeat')!
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  },
  shape: async (canvas) => {
    const { studioDocFromPersisted } = await import('~/lib/geoshape/studio')
    const { renderStudio, drawToCanvas } = await import('~/lib/geoshape/render')
    const doc = studioDocFromPersisted(undefined)
    const shapes = await renderStudio(doc)
    drawToCanvas(shapes, canvas.getContext('2d')!, canvas.width, canvas.height, 16, '#10131a')
  },
  vectortype: async (canvas, t) => {
    const { loadVectorFont, DEFAULT_FONT_ID } = await import('~/lib/vectortype/fonts')
    const { drawVectorTypeToCanvas } = await import('~/lib/vectortype/canvas')
    const { vectorTypeDefaults } = await import('~/lib/vectortype/config')
    const font = await loadVectorFont(DEFAULT_FONT_ID)
    drawVectorTypeToCanvas(canvas, font, vectorTypeDefaults(), t, {})
  },
  shader: async (canvas) => {
    const { renderShaderStill } = await import('~/lib/startModal/shaderStill')
    await renderShaderStill(canvas, '/start-modal/shader-starter.webp')
  },
  scene3d: async (canvas) => {
    const { renderScene3DStill } = await import('~/lib/startModal/scene3dStill')
    await renderScene3DStill(canvas)
  },
  expressive: async (canvas, t) => {
    const { renderSpaceTypeStill } = await import('~/lib/startModal/spaceTypeStill')
    await renderSpaceTypeStill(canvas, t)
  },
  moodboard: async (canvas) => {
    // Moodboard has no renderer of its own — its card is a pile of the user's references.
    // The tile shows the same pile made from the shipped house-style pictures.
    const urls = ['/house-styles/azure-bloom/thumb-2.webp', '/house-styles/luminous-prism/thumb-1.webp', '/house-styles/ribbons/thumb-1.webp']
    const imgs = await Promise.all(urls.map(u => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`load ${u}`)); i.src = u })))
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    ctx.fillStyle = '#e9e6e1'; ctx.fillRect(0, 0, W, H)
    const slots = [[0.06, 0.1, 0.46, -0.04], [0.5, 0.06, 0.42, 0.03], [0.28, 0.44, 0.44, -0.015]] as const
    imgs.forEach((img, i) => {
      const [x, y, w, rot] = slots[i]!
      const pw = W * w, ph = pw
      ctx.save(); ctx.translate(W * x + pw / 2, H * y + ph / 2); ctx.rotate(rot)
      ctx.fillStyle = '#fff'; ctx.fillRect(-pw / 2 - 4, -ph / 2 - 4, pw + 8, ph + 8)
      ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph); ctx.restore()
    })
  },
}

export function stillRendererFor(id: StartPickId): StillRenderer | null {
  return RENDERERS[id] ?? null
}

export async function paintStill(
  id: StartPickId, canvas: HTMLCanvasElement, t = 0,
  renderers: Partial<Record<StartPickId, StillRenderer>> = RENDERERS,
): Promise<boolean> {
  const r = renderers[id]
  if (!r) return false
  try { await r(canvas, t); return true }
  catch (e) { console.error(`[start] ${id} still failed`, e); return false }
}
```

**Before writing each renderer, verify the real export names and signatures** (the plan names come from a code survey; fix any that differ and keep the test green):
- Gradient: `gradientFx.render(cfg, w, h, t)` in `lib/gradientfx/renderer.ts:273`; `defaultConfig` in `lib/gradientfx/randomize.ts:362`.
- Pattern: `textureFx.render` (`texturefx/renderer.ts:963`), `textureDefaults` (`texturefx/controls.ts:169`), `stylizeTile` (`texturefx/stylize.ts`). Call `preloadStylize()` first, as `TextureStudioNode.vue` does.
- Shape: `renderStudio` / `drawToCanvas` (`geoshape/render.ts:336/432`), `studioDocFromPersisted` (`geoshape/studio.ts:184`). Check whether `warmPaints` must be awaited first (see `ShapeStudioNode.vue`).
- Vector type: `loadVectorFont`, `DEFAULT_FONT_ID`, `drawVectorTypeToCanvas` (`vectortype/canvas.ts:2171`). Find the real defaults factory `VectorTypeNode.vue` uses for a fresh node and use that one.
- The three helper modules `shaderStill.ts`, `scene3dStill.ts` and `spaceTypeStill.ts` are Step 4.

- [ ] **Step 4: The three heavier stills** (each its own small file in `frontend/app/lib/startModal/`)

- `shaderStill.ts`: `renderShaderStill(canvas, pictureUrl)`. Load the picture (`loadImage` from `~/lib/shaderstudio/source`), `fetchShaderFxCatalog()`, build the passes a fresh `ShaderStudio` node starts with (`hydrateConfig(undefined)` → `composePasses(...)`, as `ShaderStudioNode.vue` does in `renderFrame`), `shaderFx.render(passes, base, w, h)`, then `blit` a copy into the tile canvas.
- `scene3dStill.ts`: `renderScene3DStill(canvas)`. Build the same starter doc as Task 4's `starterSceneState()` (extract it into this file as an exported `starterSceneDoc()`, and have VueNodeCanvas import it from here so the tile and the node never disagree). Render one frame with a headless engine following `Scene3DStudioNode.vue`'s `renderPreview` (`ensureHeadless`, `renderMotionFrameSettled(eng, doc, 0)`), then dispose the engine.
- `spaceTypeStill.ts`: `renderSpaceTypeStill(canvas, t)`. Drive a `SpaceTypeEngine` bound to an offscreen canvas at the tile's size, with the defaults a fresh `SpaceType` node uses (see `SpaceTypeNode.vue` ~182–215; respect its `detectWebGL` check and throw if WebGL is unavailable). Keep ONE engine per tile canvas across hover frames, and add `disposeSpaceTypeStill()` for modal close.

If any of these three can't be driven headlessly without restructuring its studio, **stop and report** with what blocks it. Don't substitute a drawn picture: the spec forbids fakes, and the controller will take it to the owner.

- [ ] **Step 5: Implement the hover loop composable**

```ts
// frontend/app/composables/useStartTileHover.ts
// One shared rAF loop for the start modal: only hovered tiles whose studio is
// time-driven repaint, only while the page is visible; stops on leave/close.
import { onBeforeUnmount } from 'vue'
import type { StartPickId } from '~/data/start-modal'
import { ANIMATED_STILLS, paintStill } from '~/lib/startModal/stills'

export function useStartTileHover() {
  const live = new Map<StartPickId, { canvas: HTMLCanvasElement; t: number; busy: boolean }>()
  let raf = 0, last = 0
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now
    if (document.visibilityState === 'visible') {
      for (const [id, s] of live) {
        if (s.busy) continue
        s.t += dt; s.busy = true
        void paintStill(id, s.canvas, s.t).finally(() => { s.busy = false })
      }
    }
    raf = live.size ? requestAnimationFrame(loop) : 0
  }
  function enter(id: StartPickId, canvas: HTMLCanvasElement) {
    if (!ANIMATED_STILLS.has(id)) return
    live.set(id, { canvas, t: 0, busy: false })
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop) }
  }
  function leave(id: StartPickId) { live.delete(id) }
  function stopAll() { live.clear(); if (raf) cancelAnimationFrame(raf); raf = 0 }
  onBeforeUnmount(stopAll)
  return { enter, leave, stopAll }
}
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `cd frontend && npx vitest run tests/unit/start-modal-stills.unit.spec.ts`

- [ ] **Step 7: Report** paths + output, and for each of the 8 studios say whether its renderer was verified against the real exports (controller commits: `feat(start): studio tiles draw real stills with their own renderers`).

---

### Task 6: The modal component (layout A)

**Files:**
- Rewrite: `frontend/app/components/StartProjectModal.vue`
- Test: `frontend/tests/unit/start-project-modal.unit.spec.ts`

**Interfaces:**
- Consumes: `START_AI`, `startHandTiles`, `StartTile`, `StartPickId` (Task 1); `paintStill`, `stillRendererFor` (Task 5); `useStartTileHover` (Task 5).
- Produces: `<StartProjectModal @start="(pick: StartPickId | null) => …" />`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/start-project-modal.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
vi.mock('~/lib/startModal/stills', () => ({
  paintStill: vi.fn(async () => true),
  stillRendererFor: (id: string) => (['gen', 'style', 'edit', 'upscale', 'video'].includes(id) ? null : () => {}),
  ANIMATED_STILLS: new Set(),
}))
import StartProjectModal from '~/components/StartProjectModal.vue'

describe('StartProjectModal', () => {
  it('shows AI and studios as two halves', () => {
    const w = mount(StartProjectModal)
    expect(w.get('[data-testid="start-ai"]').findAll('button').length).toBe(5)
    expect(w.get('[data-testid="start-hand"]').findAll('button').length).toBeGreaterThanOrEqual(7)
    expect(w.text()).toContain('Make it with AI')
    expect(w.text()).toContain('Make it by hand')
    expect(w.text()).not.toMatch(/Shot Director|Lip-Sync|Generate music|Generate speech/)
  })

  it('a tile emits its pick', async () => {
    const w = mount(StartProjectModal)
    await w.get('[data-testid="start-tile-gradient"]').trigger('click')
    expect(w.emitted('start')![0]).toEqual(['gradient'])
  })

  it('empty Frame, close and Esc all emit null', async () => {
    const w = mount(StartProjectModal, { attachTo: document.body })
    await w.get('[data-testid="start-empty-frame"]').trigger('click')
    await w.get('[data-testid="start-close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('start')).toEqual([[null], [null], [null]])
    w.unmount()
  })

  it('AI tiles carry the credits dot, studio tiles do not', () => {
    const w = mount(StartProjectModal)
    expect(w.get('[data-testid="start-tile-gen"]').find('[data-testid="credits-dot"]').exists()).toBe(true)
    expect(w.get('[data-testid="start-tile-gradient"]').find('[data-testid="credits-dot"]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd frontend && npx vitest run tests/unit/start-project-modal.unit.spec.ts`

- [ ] **Step 3: Rewrite the component**

The visual reference is the prototype's layout A: a 900px panel, two equal halves 22px apart, each half's grid a fixed 430px tall. AI grid is 2 columns × rows `1.25fr 1fr 1fr`, with the first tile spanning both columns. Hand grid is 2 × 4 equal rows. Each tile is a picture with its caption over the bottom on a dark scrim.

```vue
<script setup lang="ts">
/**
 * The blank-project modal (spec 2026-09-23): "Make it with AI" and "Make it by
 * hand" as two equal halves, a real picture on every tile. Every choice —
 * including skipping — emits `start`; the canvas lands it in a Frame.
 * Studio tiles draw a still with the studio's own renderer (lib/startModal/
 * stills.ts) and play on hover when time-driven; AI tiles show shipped pictures.
 */
import { X } from 'lucide-vue-next'
import { START_AI, startHandTiles, type StartPickId, type StartTile } from '~/data/start-modal'
import { paintStill, stillRendererFor } from '~/lib/startModal/stills'
import { useStartTileHover } from '~/composables/useStartTileHover'

const emit = defineEmits<{ start: [pick: StartPickId | null] }>()

const hand = startHandTiles()
const AI_PICTURE: Record<string, string> = {
  gen: '/start-modal/ai-gen.webp', style: '/start-modal/ai-style.webp', edit: '/start-modal/ai-edit.webp',
  upscale: '/start-modal/ai-upscale.webp', video: '/start-modal/ai-video.webp',
}
const aiPictureOk = reactive<Record<string, boolean>>({})
const stillOk = reactive<Record<string, boolean>>({})
const canvases = new Map<StartPickId, HTMLCanvasElement>()
const hover = useStartTileHover()

function setCanvas(id: StartPickId, el: Element | null) {
  if (el) canvases.set(id, el as HTMLCanvasElement)
}

onMounted(async () => {
  await nextTick()
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  await Promise.all([...canvases].map(async ([id, c]) => {
    const r = c.getBoundingClientRect()
    c.width = Math.max(64, Math.round(r.width * dpr)); c.height = Math.max(48, Math.round(r.height * dpr))
    stillOk[id] = await paintStill(id, c, 0)
  }))
})

function pick(t: StartTile) { hover.stopAll(); emit('start', t.id) }
function skip() { hover.stopAll(); emit('start', null) }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') skip() }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" @click.self="skip">
    <div class="relative w-[900px] max-w-full max-h-[90vh] overflow-auto bg-[#161616] border border-white/10 rounded-2xl shadow-2xl px-7 pt-7 pb-4">
      <button
        data-testid="start-close"
        class="absolute top-3.5 right-3.5 size-7 rounded-md flex items-center justify-center text-white/40 hover:text-white/85 hover:bg-white/[0.06] transition-colors cursor-pointer"
        title="Start with an empty Frame" aria-label="Close" @click="skip"
      >
        <X class="size-4" />
      </button>
      <h2 class="text-[20px] font-medium text-white tracking-[0.1px] mb-1">What do you want to make?</h2>
      <p class="text-[13px] text-white/45 mb-5">Whatever you pick lands in a Frame, ready to lay out.</p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-[22px]">
        <section v-for="half in [{ key: 'ai', title: 'Make it with AI', count: `${START_AI.length} ways`, tiles: START_AI }, { key: 'hand', title: 'Make it by hand', count: `${hand.length} studios`, tiles: hand }]" :key="half.key">
          <div class="flex items-baseline justify-between mb-2.5">
            <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-white/45">{{ half.title }}</span>
            <span class="text-[11px] text-white/30">{{ half.count }}</span>
          </div>
          <div
            :data-testid="`start-${half.key}`"
            class="grid grid-cols-2 gap-2 md:h-[430px] auto-rows-[120px] md:auto-rows-auto"
            :class="half.key === 'ai' ? 'md:[grid-template-rows:1.25fr_1fr_1fr]' : 'md:[grid-template-rows:repeat(4,1fr)]'"
          >
            <button
              v-for="(t, i) in half.tiles" :key="t.id"
              :data-testid="`start-tile-${t.id}`"
              class="group/tile relative overflow-hidden rounded-xl border border-white/10 hover:border-white/25 bg-[#0c0c0d] text-left transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4f8cff] focus-visible:outline-offset-2"
              :class="half.key === 'ai' && i === 0 ? 'col-span-2' : ''"
              @click="pick(t)"
              @pointerenter="canvases.get(t.id) && hover.enter(t.id, canvases.get(t.id)!)"
              @pointerleave="hover.leave(t.id)"
            >
              <img
                v-if="t.kind === 'ai' && aiPictureOk[t.id] !== false"
                :src="AI_PICTURE[t.id]" alt="" class="absolute inset-0 size-full object-cover"
                @error="aiPictureOk[t.id] = false"
              >
              <canvas
                v-else-if="stillRendererFor(t.id)"
                :ref="el => setCanvas(t.id, el as Element | null)"
                class="absolute inset-0 size-full" :class="stillOk[t.id] === false ? 'opacity-0' : ''" aria-hidden="true"
              />
              <span
                v-if="t.credits" data-testid="credits-dot" title="Uses credits"
                class="gen-pastel absolute top-2 right-2 size-[7px] rounded-full"
                style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));"
              />
              <span class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-px px-2.5 pb-2 pt-5 bg-gradient-to-t from-black/75 to-transparent">
                <span class="text-[12.5px] leading-tight text-white/90 truncate">{{ t.name }}</span>
                <span class="text-[10.5px] text-white/60 truncate">{{ t.line }}</span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <span class="flex items-center gap-1.5 text-[11.5px] text-white/35">
          <i class="gen-pastel inline-block size-[7px] rounded-full" style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));" />
          Uses credits
        </span>
        <button data-testid="start-empty-frame" class="text-[12.5px] text-white/50 hover:text-white/85 px-2.5 py-1.5 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer" @click="skip">
          Start with an empty Frame
        </button>
      </div>
    </div>
  </div>
</template>
```

Check first that the `gen-pastel` class exists globally (grep `gen-pastel` in `app/assets`). The old modal used it, so it should. Also confirm auto-imports (`reactive`, `nextTick`, `onMounted`, `onUnmounted`) work the same as in the old file; the old file relied on Nuxt auto-imports.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run tests/unit/start-project-modal.unit.spec.ts tests/unit/start-modal-lineup.unit.spec.ts`

- [ ] **Step 5: Report** paths + output (controller commits: `feat(start): the new start modal — AI and studios side by side, a picture on every tile`).

---

### Task 7: Keep the end-to-end helpers working

Skipping the modal now leaves a Frame on the canvas. Playwright helpers that assume an empty canvas after skipping must clear it.

**Files:**
- Modify: `frontend/tests/_helpers.ts:41-47`
- Modify: `frontend/tests/port-intent.spec.ts:4-12`

- [ ] **Step 1: Update `_helpers.ts`** so it clicks the new button and then removes the starter Frame, leaving the blank canvas the tests expect:

```ts
  // Fresh blank projects pop the start modal (StartProjectModal), which covers
  // the canvas. Skipping it leaves one empty Frame; tests expect a bare canvas,
  // so remove that Frame too.
  const emptyFrame = page.getByTestId('start-empty-frame')
  if (await emptyFrame.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await emptyFrame.click()
    await emptyFrame.waitFor({ state: 'hidden', timeout: 5_000 })
    const frame = page.locator('.vue-flow__node').first()
    if (await frame.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await frame.click()
      await page.keyboard.press('Delete')
      await page.locator('.vue-flow__node').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
    }
  }
```

- [ ] **Step 2: Update `port-intent.spec.ts`'s `dismissStartModal`** the same way: press Escape, wait for the modal to hide, then select the lone `.vue-flow__node` and press Delete.

- [ ] **Step 3: Report.** Do not run Playwright; it needs the dev server, and the controller runs it during Task 8 (controller commits: `test(e2e): blank-project helpers clear the starter Frame`).

---

### Task 8: AI pictures, browser pass, and records (controller)

The controller runs this, not a subagent.

- [ ] **Step 1: Ask the owner before any paid run.** Make five pictures with the real models (about five paid runs), save them as `frontend/public/start-modal/ai-{gen,style,edit,upscale,video}.webp` (about 640 px on the long side), with Edit and Upscale as before/after splits and Video as a still with a play mark. Until they exist, the AI tiles show the plain placeholder (the `<img>` `@error` path).
- [ ] **Step 2: Browser pass** on the running `:3002` server (check it's healthy first; never start a second one):
  - Open a blank project and check the modal against the prototype's layout A.
  - Pick each of the 13 tiles in turn, in a fresh blank project each time. Confirm the nodes and the wire, and that the Frame shows the studio's picture. Check Shader and Pattern especially.
  - Confirm Video sits beside the Frame with no wire.
  - Confirm Skip, the close button and Esc each leave one empty Frame.
  - Hover the Gradient tile and confirm it plays, then leave and confirm it stops.
  - Check the console for `[start]` errors.
  - Keep the pane visible (a hidden pane pauses rAF).
- [ ] **Step 3:** Run the unit suite for the touched areas, plus `npx playwright test tests/port-intent.spec.ts` if the server is healthy.
- [ ] **Step 4:** Update `docs/STATE.md` and the ⛵ dashboard. Read the live artifact first, then replace in place rather than appending.
