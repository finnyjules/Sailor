# AI in Sailor, stage 1: shader-generation engine and model run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine that turns a request ("make it rain on a window"), optionally with a base effect, into four checked, working shader effects. Then run it on Sonnet 5 and Haiku 4.5 against the spike's six requests to decide which model writes the code.

**Architecture:**
- **Contract (shared).** A shared file defines what the model writes: a shader "body" plus 3–5 dials. Sailor supplies the standard preamble and helper functions.
- **Server route.** `/api/shader-gen` makes one model call per take, with a fixed system prompt and a strict JSON schema.
- **Engine (browser).** For each take it runs static checks, compiles and renders with Sailor's own `ShaderFxRenderer`, runs the automatic render checks, and repairs or regenerates on failure. It then has a model look at all four takes at once (reusing `/api/agent-review`) and replaces the misses.
- **Dev page.** `/dev/shader-gen-eval` shows the spike's hand-written takes next to both models' takes, so Julien can mark keepers.

**Tech stack:** Nuxt 4 (Vue 3 + TypeScript), Nitro server routes calling the Anthropic Messages API with `fetch` (no SDK), WebGL2 via `frontend/app/lib/shaderfx/renderer.ts`, Vitest (`tests/unit/**/*.unit.spec.ts`), Playwright (`tests/*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md`. This plan covers §7.1, §7.2 and the loop and cost limits of §7.5, as build stage 1 of §9.

Not in this plan:
- My effects, the gallery, and the UI entry points (§7.3, §7.4). They are stage 5.
- WebGL context-loss recovery for a hung preview (§7.5). It matters once generated shaders run in the studios and on the canvas, which is also stage 5.
- Every other stage gets its own plan.

## Global constraints

- **Dials:** 3–5 per effect, of type `float`, `enum` or `color`, each with a label and a default (spec §7.2).
- **Static limits (spec §7.2):**
  - Loops must have constant bounds, and each loop's iterations *including nesting* must be ≤ 64.
  - Image reads inside loops must be ≤ 32 per pixel. `tex(`/`texture(` count 1, and `blur9(` counts 25.
- **Repairs:** at most 2 compile repairs per take. A take that fails the render checks is regenerated once.
- **Render checks (spec §7.2, thresholds from the spike page):**

  | Check | Fails when |
  |---|---|
  | Black | mean luma < 0.03 |
  | Blown out | mean luma > 0.97 |
  | Flat | luma std < 0.012 |
  | No visible change (image effects only) | mean abs diff to the source < 0.012 |
  | Does not move (animated only) | mean abs diff between t = 2.0 and t = 3.37 ≤ 0.002 |
  | Heavy | extra cost > 8 ms per 1024² frame over a plain copy |

  "Does not move" is a warning, not a failure.
- **Models:** use `AI_TIERS` in `frontend/server/lib/aiModels.ts`. Never hard-code model ids. `patch` = `claude-haiku-4-5` (it has **no** `output_config.effort`: sending it returns a 400). `plan` = `claude-sonnet-5`.
- **UI copy:** sentence case; no internal identifiers in labels (standing rule).
- **Dev server:** use the existing main-checkout server (conventionally `:3002`; check with `lsof -nP -iTCP -sTCP:LISTEN | grep node`). **Never** start `npm run dev`, and never let a subagent start one.
- **Paid calls:** nothing in Tasks 1–8 may call the Anthropic API. Task 9 calls it only after Julien says yes in chat.
- **Commits:** this checkout is shared by several sessions. Every commit uses the private-index recipe written out in each task: seed from `HEAD` with `read-tree`, never `cp .git/index`. Then re-sync the shared index in a **separate** shell call. When running subagent-driven, implementers report file paths and test output, and the **controller** runs the commit step.
- **Test commands** run from `frontend/`: `npx vitest run <file>` for unit tests, and `npx playwright test <file> --project=chromium` for E2E.

## File structure

| File | Responsibility |
|---|---|
| `frontend/shared/shadergen/contract.ts` | The preamble, the helper GLSL, `assembleSource`, the `GenTake`/`GenParam` types, `LIMITS` and the strict JSON schema for one take. Shared by the app and the server. |
| `frontend/shared/shadergen/system.ts` | The static system prompt (cached server-side). |
| `frontend/scripts/extract-shader-spike.mjs` | A one-off generator that pulls the 24 spike takes out of the committed spike page. |
| `frontend/app/lib/shadergen/__eval__/spikeTakes.ts` | Generated fixture: the 24 spike takes as `GenTake`s, plus the spike's preamble and helpers text. |
| `frontend/app/lib/shadergen/__eval__/requests.ts` | The six evaluation requests. |
| `frontend/app/lib/shadergen/staticCheck.ts` | Dials, uniforms and loop/read limits, checked before compiling. |
| `frontend/app/lib/shadergen/renderChecks.ts` | Pure pixel-statistics checks (black, flat, no change, …). |
| `frontend/app/lib/shadergen/prompt.ts` | User-prompt builders, reply parsing, and the visual-review prompt and schema. |
| `frontend/server/lib/shaderGenRequest.ts` | Builds and validates the Anthropic payload for `/api/shader-gen`. |
| `frontend/server/api/shader-gen.post.ts` | The route: one model call, and returns `{ text, usage }`. |
| `frontend/app/lib/shadergen/engine.ts` | The orchestration: parallel takes, repair and regenerate, visual review with replacement. |
| `frontend/app/lib/shadergen/effectDef.ts` | `GenTake` → `EffectDef`, so the rest of Sailor can render it. |
| `frontend/app/lib/shadergen/browserRenderer.ts` | The engine's `TakeRenderer` built on `ShaderFxRenderer`: compile, judge, thumbnail, sheet. |
| `frontend/app/lib/shadergen/client.ts` | Thin `$fetch` wrappers for `/api/shader-gen` and `/api/agent-review`. |
| `frontend/app/pages/dev/shader-gen-eval.vue` | The evaluation page. |
| `frontend/tests/unit/shadergen-*.unit.spec.ts` | Unit tests, one file per module. |
| `frontend/tests/shader-gen-eval.spec.ts` | E2E smoke: the eval page renders all 24 spike takes through the real renderer. |
| `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.md` | Task 9 output: the measured results and the model-tier decision. |

---

### Task 1: The contract and the spike fixture

**Files:**
- Create: `frontend/shared/shadergen/contract.ts`
- Create: `frontend/shared/shadergen/system.ts`
- Create: `frontend/scripts/extract-shader-spike.mjs`
- Create (generated): `frontend/app/lib/shadergen/__eval__/spikeTakes.ts`
- Create: `frontend/app/lib/shadergen/__eval__/requests.ts`
- Test: `frontend/tests/unit/shadergen-contract.unit.spec.ts`

**Interfaces:**
- Produces (from `~~/shared/shadergen/contract`):
  - `SHADERGEN_PREAMBLE: string`, `SHADERGEN_HELPERS: string`
  - `PREAMBLE_UNIFORMS: readonly ['u_image0','u_resolution','u_time','u_seed']`
  - `LIMITS: { minParams: 3; maxParams: 5; maxLoopIterations: 64; maxLoopTextureReads: 32; maxBodyChars: 12000 }`
  - `type GenParamType = 'float' | 'enum' | 'color'`
  - `interface GenParam { uniform: string; label: string; type: GenParamType; min?: number; max?: number; step?: number; default: number | string; options?: { label: string; value: number }[] }`
  - `interface GenTake { name: string; animated: boolean; generative: boolean; params: GenParam[]; body: string }`
  - `assembleSource(body: string): string`
  - `SHADERGEN_TAKE_SCHEMA`
- Produces (from `~~/shared/shadergen/system`): `SHADERGEN_SYSTEM: string`.
- Produces (from `~/lib/shadergen/__eval__/spikeTakes`): `SPIKE_TAKES: Record<string, GenTake[]>` and `SPIKE_PREFIX: string`.
- Produces (from `~/lib/shadergen/__eval__/requests`): `interface EvalRequest { key: string; prompt: string; base: string | null }` and `EVAL_REQUESTS: EvalRequest[]`.

- [ ] **Step 1: Write the contract**

Create `frontend/shared/shadergen/contract.ts`:

```ts
/**
 * The contract between Sailor and the model that writes shader effects
 * (AI in Sailor spec §7.2). Sailor supplies the preamble and the helpers; the
 * model writes only the effect's own uniforms, functions and main() — the
 * "body" — plus 3–5 dials. Shared by the app (engine, checks) and the server
 * (/api/shader-gen's strict output schema).
 *
 * SHADERGEN_PREAMBLE + SHADERGEN_HELPERS must stay byte-identical to the spike's
 * PRE + LIB (tests/unit/shadergen-contract.unit.spec.ts guards this), so the 24
 * spike takes remain valid bodies.
 */

export const SHADERGEN_PREAMBLE = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
`

export const SHADERGEN_HELPERS = `
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+5.2; a*=0.5; } return s; }
vec3 tex(vec2 uv){ return texture(u_image0, clamp(uv,0.0,1.0)).rgb; }
vec3 blur9(vec2 uv, float r){ vec3 s=vec3(0.0); for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++) s+=tex(uv+vec2(float(i),float(j))*r); return s/25.0; }
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
vec2 ASP(){ return vec2(u_resolution.x/u_resolution.y,1.0); }
vec3 hsv2rgb(vec3 c){ vec3 p=abs(fract(c.xxx+vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0); return c.z*mix(vec3(1.0),clamp(p-1.0,0.0,1.0),c.y); }
vec3 thinfilm(float d){ return 0.5+0.5*cos(6.28318*(d*vec3(1.0,1.18,1.42)+vec3(0.0,0.1,0.2))); }
`

export const PREAMBLE_UNIFORMS = ['u_image0', 'u_resolution', 'u_time', 'u_seed'] as const

export const LIMITS = {
  minParams: 3,
  maxParams: 5,
  maxLoopIterations: 64,
  maxLoopTextureReads: 32,
  maxBodyChars: 12_000,
} as const

export type GenParamType = 'float' | 'enum' | 'color'

export interface GenParam {
  uniform: string
  label: string
  type: GenParamType
  min?: number
  max?: number
  step?: number
  /** number for float/enum · '#rrggbb' for color */
  default: number | string
  options?: { label: string; value: number }[]
}

export interface GenTake {
  name: string
  animated: boolean
  generative: boolean
  params: GenParam[]
  /** Uniform declarations + functions + main(); no preamble, no helpers. */
  body: string
}

/** The full GLSL ES 3.00 fragment source the renderer compiles. */
export function assembleSource(body: string): string {
  return `${SHADERGEN_PREAMBLE}${SHADERGEN_HELPERS}\n${body.trim()}\n`
}

/** Strict output schema for ONE take (structured outputs, output_config.format). */
export const SHADERGEN_TAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'animated', 'generative', 'params', 'body'],
  properties: {
    name: { type: 'string' },
    animated: { type: 'boolean' },
    generative: { type: 'boolean' },
    body: { type: 'string' },
    params: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['uniform', 'label', 'type', 'default'],
        properties: {
          uniform: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['float', 'enum', 'color'] },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
          default: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: { label: { type: 'string' }, value: { type: 'number' } },
            },
          },
        },
      },
    },
  },
} as const
```

- [ ] **Step 2: Write the system prompt**

Create `frontend/shared/shadergen/system.ts`:

```ts
/**
 * Static system prompt for /api/shader-gen. Byte-identical across calls so the
 * server can send it as a cached system block (see agent-review.post.ts).
 */
export const SHADERGEN_SYSTEM = `You write GLSL ES 3.00 fragment shaders for Sailor, a creative tool. Each shader is one visual effect that people pick, tune with a few dials, and use on images, text and 3D.

Sailor provides these — never write them yourself:
- The preamble: #version, precision, and the inputs
  uniform sampler2D u_image0;  // the input image (ignore it for generative effects)
  uniform vec2 u_resolution;   // output size in pixels
  uniform float u_time;        // seconds
  uniform float u_seed;        // a whole number, for variety
  in vec2 v_texCoord;          // 0..1, origin bottom-left
  layout(location = 0) out vec4 fragColor0;
- These helper functions:
  float h21(vec2 p)                 // hash, 0..1
  float vnoise(vec2 p)              // value noise, 0..1
  float fbm(vec2 p)                 // 5-octave fbm, 0..1
  vec3 tex(vec2 uv)                 // clamped read of u_image0
  vec3 blur9(vec2 uv, float r)      // 5×5 box blur, radius r in uv units (25 image reads)
  float luma(vec3 c)
  vec2 ASP()                        // aspect vector (width/height, 1)
  vec3 hsv2rgb(vec3 c)
  vec3 thinfilm(float d)            // iridescent thin-film palette

You write "body": the effect's own uniform declarations (one per dial), any functions, and void main() that writes fragColor0 with alpha 1.0.

Rules:
1. 3 to 5 dials. Every dial is a uniform you declare and use.
   - "float": a float uniform, with min, max, step and default.
   - "enum": a float uniform, with options whose values are whole numbers; default is one of them.
   - "color": a vec3 uniform; default is a hex string like "#ff7a3d".
   Labels are sentence case in plain words ("Drop size", never "u_size").
2. Defaults must look good untouched. Choose them as a designer would; dials are for taste, not for rescuing a weak default.
3. Loops: only for (int i = A; i < B; i++) with whole-number literals, at most 64 iterations per pixel including nesting. No while loops. At most 32 image reads (tex or texture; blur9 counts as 25) inside loops per pixel.
4. Keep the subject readable unless the request asks otherwise: an effect on an image transforms it, it does not replace it.
5. If the effect moves, drive the motion from u_time and set "animated": true. Frame 0 must already look finished — no fade-in from blank.
6. "generative": true only if the effect ignores the input image entirely.
7. "name": two or three words in sentence case naming the look ("Fogged glass"), not repeating the request.`
```

- [ ] **Step 3: Write the fixture generator**

Create `frontend/scripts/extract-shader-spike.mjs`:

```js
// Generates app/lib/shadergen/__eval__/spikeTakes.ts from the committed spike page
// (docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/shader-takes-spike.html).
// Run once from frontend/:  node scripts/extract-shader-spike.mjs
import fs from 'node:fs'
import vm from 'node:vm'

const page = new URL('../../docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/shader-takes-spike.html', import.meta.url)
const html = fs.readFileSync(page, 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
const code = scripts.find(s => s.includes('window.SPIKE = ['))
if (!code) throw new Error('spike takes script not found in the page')

const ctx = { window: {} }
vm.createContext(ctx)
const out = vm.runInContext(`${code}\n;({ SPIKE: window.SPIKE, prefix: PRE + LIB })`, ctx)

const takes = {}
for (const g of out.SPIKE) {
  takes[g.key] = g.takes.map(t => {
    if (!t.source.startsWith(out.prefix)) throw new Error(`take ${t.name} does not start with the shared prefix`)
    return {
      name: t.name,
      animated: !!t.animated,
      generative: !!t.generative,
      params: t.params,
      body: t.source.slice(out.prefix.length).trim(),
    }
  })
}

const target = new URL('../app/lib/shadergen/__eval__/spikeTakes.ts', import.meta.url)
fs.mkdirSync(new URL('.', target), { recursive: true })
fs.writeFileSync(target, `// Generated by scripts/extract-shader-spike.mjs from the spike page. Do not edit by hand.
import type { GenTake } from '~~/shared/shadergen/contract'

/** The spike's preamble + helpers, exactly as the 24 takes were rendered with. */
export const SPIKE_PREFIX: string = ${JSON.stringify(out.prefix)}

export const SPIKE_TAKES: Record<string, GenTake[]> = ${JSON.stringify(takes, null, 2)}
`)
console.log(`wrote ${Object.values(takes).flat().length} takes to ${target.pathname}`)
```

- [ ] **Step 4: Generate the fixture**

Run (from `frontend/`): `node scripts/extract-shader-spike.mjs`
Expected: `wrote 24 takes to …/app/lib/shadergen/__eval__/spikeTakes.ts`

- [ ] **Step 5: Write the evaluation requests**

Create `frontend/app/lib/shadergen/__eval__/requests.ts`:

```ts
/** The six requests from the shader spike (AI in Sailor spec §7.1). `base` is a
 *  catalog effect id for transforms, null for "from nothing". */
export interface EvalRequest { key: string; prompt: string; base: string | null }

export const EVAL_REQUESTS: EvalRequest[] = [
  { key: 'rain', prompt: 'Turn this into rain on a window', base: 'water_ripple' },
  { key: 'popart', prompt: 'Make it a Lichtenstein pop-art panel', base: 'halftone' },
  { key: 'lava', prompt: 'Make it a slow lava lamp', base: 'aurora' },
  { key: 'oil', prompt: 'Make it look like a wet oil slick on asphalt', base: 'holographic' },
  { key: 'haze', prompt: 'Heat haze over a desert road', base: null },
  { key: 'ink', prompt: 'Ink bleeding into wet paper', base: null },
]
```

- [ ] **Step 6: Write the failing test**

Create `frontend/tests/unit/shadergen-contract.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  assembleSource,
  LIMITS,
  SHADERGEN_HELPERS,
  SHADERGEN_PREAMBLE,
  SHADERGEN_TAKE_SCHEMA,
} from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { SPIKE_PREFIX, SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { EVAL_REQUESTS } from '~/lib/shadergen/__eval__/requests'

describe('shadergen contract', () => {
  it('preamble + helpers are byte-identical to what the spike takes were rendered with', () => {
    expect(SHADERGEN_PREAMBLE + SHADERGEN_HELPERS).toBe(SPIKE_PREFIX)
  })

  it('assembleSource wraps a body in the preamble and helpers exactly once', () => {
    const src = assembleSource('\n  void main(){ fragColor0 = vec4(1.0); }\n')
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    expect(src.split('#version').length - 1).toBe(1)
    expect(src.split('float h21(').length - 1).toBe(1)
    expect(src.endsWith('void main(){ fragColor0 = vec4(1.0); }\n')).toBe(true)
  })

  it('the take schema requires every field the engine reads', () => {
    expect(SHADERGEN_TAKE_SCHEMA.required).toEqual(['name', 'animated', 'generative', 'params', 'body'])
    expect(SHADERGEN_TAKE_SCHEMA.properties.params.items.properties.type.enum).toEqual(['float', 'enum', 'color'])
  })

  it('the system prompt states the same limits the checks enforce', () => {
    expect(SHADERGEN_SYSTEM).toContain(`${LIMITS.minParams} to ${LIMITS.maxParams} dials`)
    expect(SHADERGEN_SYSTEM).toContain(`at most ${LIMITS.maxLoopIterations} iterations`)
    expect(SHADERGEN_SYSTEM).toContain(`At most ${LIMITS.maxLoopTextureReads} image reads`)
  })

  it('the fixture holds 4 spike takes for each of the 6 requests', () => {
    expect(EVAL_REQUESTS.map(r => r.key)).toEqual(Object.keys(SPIKE_TAKES))
    for (const r of EVAL_REQUESTS) expect(SPIKE_TAKES[r.key]).toHaveLength(4)
  })
})
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/unit/shadergen-contract.unit.spec.ts`
Expected: PASS, 5 tests. If the first test fails, the helpers text in `contract.ts` differs from the spike's `LIB`. Fix the contract, not the fixture, because the fixture is what actually rendered.

- [ ] **Step 8: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/shared/shadergen/contract.ts frontend/shared/shadergen/system.ts frontend/scripts/extract-shader-spike.mjs frontend/app/lib/shadergen/__eval__/spikeTakes.ts frontend/app/lib/shadergen/__eval__/requests.ts frontend/tests/unit/shadergen-contract.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): contract, system prompt and spike fixture" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/shared/shadergen/contract.ts frontend/shared/shadergen/system.ts frontend/scripts/extract-shader-spike.mjs frontend/app/lib/shadergen/__eval__/spikeTakes.ts frontend/app/lib/shadergen/__eval__/requests.ts frontend/tests/unit/shadergen-contract.unit.spec.ts && git show --stat --oneline HEAD | head -10
```

Expected: the stat lists exactly those 6 files.

---

### Task 2: Static checks

**Files:**
- Create: `frontend/app/lib/shadergen/staticCheck.ts`
- Test: `frontend/tests/unit/shadergen-static-check.unit.spec.ts`

**Interfaces:**
- Consumes: `GenTake`, `GenParam`, `LIMITS` and `PREAMBLE_UNIFORMS` from Task 1; `SPIKE_TAKES` from Task 1.
- Produces:
  - `type CheckResult = { ok: true } | { ok: false; reason: string }`
  - `checkParams(take: GenTake): CheckResult`
  - `checkUniforms(take: GenTake): CheckResult`
  - `checkLoops(body: string): CheckResult`
  - `staticCheck(take: GenTake): CheckResult`

  Each `reason` is a plain sentence that is sent back to the model verbatim.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-static-check.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { GenParam, GenTake } from '~~/shared/shadergen/contract'
import { checkLoops, staticCheck } from '~/lib/shadergen/staticCheck'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const f = (uniform: string): GenParam => ({ uniform, label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 })
const GOOD = `uniform float u_a; uniform float u_b; uniform float u_c;
void main(){
  vec3 c = tex(v_texCoord);
  for(int i=0;i<4;i++){ c += tex(v_texCoord + float(i)*0.01) * u_a; }
  fragColor0 = vec4(c*u_b*u_c, 1.0);
}`
const take = (over: Partial<GenTake> = {}): GenTake => ({
  name: 'Test', animated: false, generative: false, params: [f('u_a'), f('u_b'), f('u_c')], body: GOOD, ...over,
})
const reasonOf = (r: ReturnType<typeof staticCheck>) => (r.ok ? '' : r.reason)

describe('staticCheck', () => {
  it('accepts a well-formed take', () => {
    expect(staticCheck(take())).toEqual({ ok: true })
  })

  it('accepts all 24 spike takes (they compiled and rendered)', () => {
    for (const [key, takes] of Object.entries(SPIKE_TAKES)) {
      for (const t of takes) expect({ key, name: t.name, r: staticCheck(t) }).toEqual({ key, name: t.name, r: { ok: true } })
    }
  })

  it('needs 3 to 5 dials', () => {
    const two = take({ params: [f('u_a'), f('u_b')], body: GOOD.replace('uniform float u_c;', '').replace('*u_c', '') })
    expect(reasonOf(staticCheck(two))).toContain('It has 2 dials; it needs 3 to 5')
    const six = take({ params: ['u_a', 'u_b', 'u_c', 'u_d', 'u_e', 'u_f'].map(f) })
    expect(reasonOf(staticCheck(six))).toContain('It has 6 dials')
  })

  it('rejects a dial that is never declared, and a uniform with no dial', () => {
    expect(reasonOf(staticCheck(take({ params: [f('u_a'), f('u_b'), f('u_z')] })))).toContain('declares uniform u_c, but there is no dial for it')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('uniform float u_c;', '').replace('*u_c', '') })))).toContain('(u_c) is never declared')
  })

  it('rejects a colour dial declared as float, and an unused dial', () => {
    const col: GenParam = { uniform: 'u_c', label: 'Tint', type: 'color', default: '#ff0000' }
    expect(reasonOf(staticCheck(take({ params: [f('u_a'), f('u_b'), col] })))).toContain('u_c is declared as float; a color dial needs vec3')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('*u_c', '') })))).toContain('(u_c) is declared but never used')
  })

  it('rejects preamble content in the body', () => {
    expect(reasonOf(staticCheck(take({ body: `#version 300 es\n${GOOD}` })))).toContain('must not include #version')
    expect(reasonOf(staticCheck(take({ body: `uniform float u_time;\n${GOOD}` })))).toContain('redeclares the built-in uniform u_time')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('void main()', 'void mainly()') })))).toContain('no void main()')
  })
})

describe('checkLoops', () => {
  it('rejects loops whose bounds are not whole-number literals', () => {
    const r = checkLoops('void main(){ for(int i=0;i<n;i++){ } }')
    expect(r.ok ? '' : r.reason).toContain('whole-number literals')
  })

  it('counts nested iterations', () => {
    const r = checkLoops('void main(){ for(int i=0;i<8;i++){ for(int j=0;j<10;j++){ } } }')
    expect(r.ok ? '' : r.reason).toContain('runs 80 times per pixel')
    expect(checkLoops('void main(){ for(int i=0;i<8;i++){ for(int j=0;j<8;j++){ } } }')).toEqual({ ok: true })
  })

  it('counts <= bounds inclusively and accepts single-statement bodies', () => {
    expect(checkLoops('void main(){ for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++) x+=1.0; }')).toEqual({ ok: true })
    const r = checkLoops('void main(){ for(int i=0;i<=64;i++) x+=1.0; }')
    expect(r.ok ? '' : r.reason).toContain('runs 65 times')
  })

  it('rejects while loops', () => {
    const r = checkLoops('void main(){ while(true){ } }')
    expect(r.ok ? '' : r.reason).toContain('While loops are not allowed')
  })

  it('limits image reads inside loops, with blur9 counting 25', () => {
    const many = checkLoops('void main(){ for(int i=0;i<16;i++){ c+=tex(a)+tex(b)+texture(u_image0,c); } }')
    expect(many.ok ? '' : many.reason).toContain('read the image 48 times')
    const blur = checkLoops('void main(){ for(int i=0;i<2;i++){ c+=blur9(a, 0.01); } }')
    expect(blur.ok ? '' : blur.reason).toContain('read the image 50 times')
    expect(checkLoops('void main(){ c = blur9(a, 0.01); for(int i=0;i<8;i++){ c+=tex(a); } }')).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-static-check.unit.spec.ts`
Expected: FAIL. It cannot resolve `~/lib/shadergen/staticCheck`.

- [ ] **Step 3: Implement**

Create `frontend/app/lib/shadergen/staticCheck.ts`:

```ts
/**
 * Checks a model-written take BEFORE it is compiled (AI in Sailor spec §7.2):
 * dial shape, uniform/dial agreement, and the loop and image-read limits that
 * keep a runaway shader from hanging the graphics card. Every `reason` is a
 * plain sentence the engine sends back to the model verbatim.
 */
import { LIMITS, PREAMBLE_UNIFORMS, type GenTake } from '~~/shared/shadergen/contract'

export type CheckResult = { ok: true } | { ok: false; reason: string }

const OK: CheckResult = { ok: true }
const fail = (reason: string): CheckResult => ({ ok: false, reason })
const isPreamble = (name: string) => (PREAMBLE_UNIFORMS as readonly string[]).includes(name)

export function checkParams(take: GenTake): CheckResult {
  const n = take.params.length
  if (n < LIMITS.minParams || n > LIMITS.maxParams) {
    return fail(`It has ${n} dials; it needs ${LIMITS.minParams} to ${LIMITS.maxParams}.`)
  }
  const seen = new Set<string>()
  for (const p of take.params) {
    if (!/^u_[A-Za-z][A-Za-z0-9]*$/.test(p.uniform)) return fail(`Dial uniform "${p.uniform}" must look like u_name.`)
    if (isPreamble(p.uniform)) return fail(`Dial uniform "${p.uniform}" clashes with a built-in input.`)
    if (seen.has(p.uniform)) return fail(`Dial uniform "${p.uniform}" is used twice.`)
    seen.add(p.uniform)
  }
  return OK
}

const UNIFORM_RE = /\buniform\s+(\w+)\s+(\w+)\s*;/g

export function checkUniforms(take: GenTake): CheckResult {
  const body = take.body
  if (/#version|\bprecision\s+\w+\s+float/.test(body)) return fail('The body must not include #version or precision; Sailor adds them.')
  if (/\bout\s+vec4\b|\bin\s+vec2\s+v_texCoord/.test(body)) return fail('The body must not redeclare the preamble inputs or outputs.')
  if (!/\bvoid\s+main\s*\(\s*\)/.test(body)) return fail('The body has no void main().')
  const declared = new Map<string, string>()
  for (const m of body.matchAll(UNIFORM_RE)) declared.set(m[2]!, m[1]!)
  for (const name of declared.keys()) {
    if (isPreamble(name)) return fail(`The body redeclares the built-in uniform ${name}.`)
    if (!take.params.some(p => p.uniform === name)) return fail(`The body declares uniform ${name}, but there is no dial for it.`)
  }
  for (const p of take.params) {
    const type = declared.get(p.uniform)
    if (!type) return fail(`The dial "${p.label}" (${p.uniform}) is never declared as a uniform.`)
    const want = p.type === 'color' ? 'vec3' : 'float'
    if (type !== want) return fail(`${p.uniform} is declared as ${type}; a ${p.type} dial needs ${want}.`)
    const mentions = body.split(new RegExp(`\\b${p.uniform}\\b`)).length - 1
    if (mentions < 2) return fail(`The dial "${p.label}" (${p.uniform}) is declared but never used.`)
  }
  return OK
}

interface Loop { start: number; end: number; iterations: number }

const FOR_HEADER = /^for ?\( ?int (\w+) ?= ?(-?\d+) ?; ?(\w+) ?(<=|<) ?(-?\d+) ?; ?(?:(\w+) ?\+\+|\+\+ ?(\w+)|(\w+) ?\+= ?1) ?\)$/

function closing(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close && --depth === 0) return i
  }
  return -1
}

function findLoops(body: string): Loop[] | string {
  const loops: Loop[] = []
  for (const m of body.matchAll(/\bfor\s*\(/g)) {
    const start = m.index!
    const parenOpen = body.indexOf('(', start)
    const parenClose = closing(body, parenOpen, '(', ')')
    if (parenClose < 0) return 'A for loop has unbalanced brackets.'
    const header = body.slice(start, parenClose + 1).replace(/\s+/g, ' ')
    const h = FOR_HEADER.exec(header)
    const sameVar = h && [h[3], h[6] ?? h[7] ?? h[8]].every(v => v === h[1])
    if (!h || !sameVar) return `Loop bounds must be whole-number literals, like for (int i = 0; i < 8; i++). Found: ${header}`
    const iterations = Math.max(0, Number(h[5]) - Number(h[2]) + (h[4] === '<=' ? 1 : 0))
    let k = parenClose + 1
    while (/\s/.test(body[k] ?? '')) k++
    const end = body[k] === '{' ? closing(body, k, '{', '}') : body.indexOf(';', k)
    if (end < 0) return 'A for loop body is not closed.'
    loops.push({ start, end, iterations })
  }
  return loops
}

const READ_RE = /\b(texture|tex|blur9)\s*\(/g
const READ_WEIGHT: Record<string, number> = { texture: 1, tex: 1, blur9: 25 }

export function checkLoops(body: string): CheckResult {
  if (/\bwhile\s*\(/.test(body)) return fail('While loops are not allowed; use a for loop with fixed bounds.')
  const loops = findLoops(body)
  if (typeof loops === 'string') return fail(loops)
  const enclosing = (pos: number) => loops.filter(l => l.start <= pos && pos <= l.end)
  const multiplier = (pos: number) => enclosing(pos).reduce((acc, l) => acc * l.iterations, 1)
  for (const l of loops) {
    const total = multiplier(l.start)
    if (total > LIMITS.maxLoopIterations) {
      return fail(`A loop runs ${total} times per pixel (including nesting); the limit is ${LIMITS.maxLoopIterations}.`)
    }
  }
  let reads = 0
  for (const m of body.matchAll(READ_RE)) {
    if (enclosing(m.index!).length) reads += READ_WEIGHT[m[1]!]! * multiplier(m.index!)
  }
  if (reads > LIMITS.maxLoopTextureReads) {
    return fail(`Loops read the image ${reads} times per pixel; the limit is ${LIMITS.maxLoopTextureReads}.`)
  }
  return OK
}

export function staticCheck(take: GenTake): CheckResult {
  if (take.body.length > LIMITS.maxBodyChars) return fail(`The body is ${take.body.length} characters; keep it under ${LIMITS.maxBodyChars}.`)
  for (const check of [checkParams(take), checkUniforms(take), checkLoops(take.body)]) {
    if (!check.ok) return check
  }
  return OK
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/shadergen-static-check.unit.spec.ts`
Expected: PASS, 11 tests. If a spike take fails, the check is too strict, not the spike: those 24 compiled and rendered. Read the reason, then adjust the check (usually a regex) rather than the fixture.

- [ ] **Step 5: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/lib/shadergen/staticCheck.ts frontend/tests/unit/shadergen-static-check.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): static checks — dials, uniforms, loop and read limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/lib/shadergen/staticCheck.ts frontend/tests/unit/shadergen-static-check.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 3: Render checks

**Files:**
- Create: `frontend/app/lib/shadergen/renderChecks.ts`
- Test: `frontend/tests/unit/shadergen-render-checks.unit.spec.ts`

**Interfaces:**
- Produces:
  - `type Flag = 'black' | 'blown out' | 'flat' | 'no visible change' | 'heavy' | 'does not move'`
  - `HARD_FLAGS: readonly Flag[]`, and `THRESHOLDS`
  - `frameStats(px: ArrayLike<number>): { mean: number; std: number }`
  - `meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number`
  - `interface JudgeInput { a: ArrayLike<number>; b: ArrayLike<number>; source: ArrayLike<number>; generative: boolean; animated: boolean; extraMs: number }`
  - `judgeFrames(i: JudgeInput): { pass: boolean; flags: Flag[] }`

  Pixel arrays are RGBA bytes, as returned by `getImageData`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-render-checks.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { frameStats, judgeFrames, meanAbsDiff } from '~/lib/shadergen/renderChecks'

const N = 24 * 24
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) px.set([r, g, b, 255], i * 4)
  return px
}
function stripes(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) { const v = i % 2 ? 220 : 40; px.set([v, v, v, 255], i * 4) }
  return px
}
const base = { generative: false, animated: false, extraMs: 1 }

describe('render checks', () => {
  it('frameStats measures luma mean and spread', () => {
    expect(frameStats(solid(0, 0, 0))).toEqual({ mean: 0, std: 0 })
    const s = frameStats(stripes())
    expect(s.mean).toBeCloseTo(130 / 255, 3)
    expect(s.std).toBeCloseTo(90 / 255, 3)
  })

  it('meanAbsDiff is 0 for equal frames and 1 for black vs white', () => {
    expect(meanAbsDiff(stripes(), stripes())).toBe(0)
    expect(meanAbsDiff(solid(0, 0, 0), solid(255, 255, 255))).toBe(1)
  })

  it('passes a textured frame that changed the source', () => {
    expect(judgeFrames({ ...base, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: true, flags: [] })
  })

  it('fails black, blown-out and flat frames', () => {
    expect(judgeFrames({ ...base, a: solid(2, 2, 2), b: solid(2, 2, 2), source: stripes() }).flags).toContain('black')
    expect(judgeFrames({ ...base, a: solid(254, 254, 254), b: solid(254, 254, 254), source: stripes() }).flags).toContain('blown out')
    const flat = judgeFrames({ ...base, a: solid(120, 120, 120), b: solid(120, 120, 120), source: stripes() })
    expect(flat).toEqual({ pass: false, flags: ['flat'] })
  })

  it('fails an image effect that leaves the image unchanged, but not a generative one', () => {
    expect(judgeFrames({ ...base, a: stripes(), b: stripes(), source: stripes() }).flags).toEqual(['no visible change'])
    expect(judgeFrames({ ...base, generative: true, a: stripes(), b: stripes(), source: stripes() }).pass).toBe(true)
  })

  it('warns, without failing, when an animated effect does not move', () => {
    expect(judgeFrames({ ...base, animated: true, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: true, flags: ['does not move'] })
  })

  it('fails a heavy effect', () => {
    expect(judgeFrames({ ...base, extraMs: 9, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: false, flags: ['heavy'] })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-render-checks.unit.spec.ts`
Expected: FAIL. It cannot resolve `~/lib/shadergen/renderChecks`.

- [ ] **Step 3: Implement**

Create `frontend/app/lib/shadergen/renderChecks.ts`:

```ts
/**
 * Cheap automatic checks on a rendered take (AI in Sailor spec §7.2), with the
 * spike page's thresholds. They catch breakage, not taste: in the spike they
 * passed every bad-looking take, which is why the engine also asks a model to
 * look at the renders. Inputs are small RGBA samples (24×24 in the renderer).
 */
export type Flag = 'black' | 'blown out' | 'flat' | 'no visible change' | 'heavy' | 'does not move'

/** Flags that reject a take. 'does not move' only warns. */
export const HARD_FLAGS: readonly Flag[] = ['black', 'blown out', 'flat', 'no visible change', 'heavy']

export const THRESHOLDS = {
  black: 0.03,
  blown: 0.97,
  flatStd: 0.012,
  noChange: 0.012,
  moves: 0.002,
  heavyMs: 8,
} as const

export function frameStats(px: ArrayLike<number>): { mean: number; std: number } {
  let s = 0, s2 = 0, n = 0
  for (let i = 0; i + 3 < px.length; i += 4) {
    const l = (px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114) / 255
    s += l; s2 += l * l; n++
  }
  if (!n) return { mean: 0, std: 0 }
  const mean = s / n
  return { mean, std: Math.sqrt(Math.max(s2 / n - mean * mean, 0)) }
}

export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, n = 0
  for (let i = 0; i + 3 < a.length && i + 3 < b.length; i += 4) {
    s += (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 765
    n++
  }
  return n ? s / n : 0
}

export interface JudgeInput {
  /** frame at t = 2.0 */
  a: ArrayLike<number>
  /** frame at t = 3.37 — a non-harmonic gap, so periodic motion can't alias to "still" */
  b: ArrayLike<number>
  /** the input image, same sample size */
  source: ArrayLike<number>
  generative: boolean
  animated: boolean
  /** ms per 1024² frame over a plain copy */
  extraMs: number
}

export function judgeFrames(i: JudgeInput): { pass: boolean; flags: Flag[] } {
  const flags: Flag[] = []
  const st = frameStats(i.a)
  if (st.mean < THRESHOLDS.black) flags.push('black')
  else if (st.mean > THRESHOLDS.blown) flags.push('blown out')
  else if (st.std < THRESHOLDS.flatStd) flags.push('flat')
  if (!i.generative && meanAbsDiff(i.a, i.source) < THRESHOLDS.noChange) flags.push('no visible change')
  if (i.animated && meanAbsDiff(i.a, i.b) <= THRESHOLDS.moves) flags.push('does not move')
  if (i.extraMs > THRESHOLDS.heavyMs) flags.push('heavy')
  return { pass: !flags.some(f => HARD_FLAGS.includes(f)), flags }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/shadergen-render-checks.unit.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/lib/shadergen/renderChecks.ts frontend/tests/unit/shadergen-render-checks.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): automatic render checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/lib/shadergen/renderChecks.ts frontend/tests/unit/shadergen-render-checks.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 4: Prompts and reply parsing

**Files:**
- Create: `frontend/app/lib/shadergen/prompt.ts`
- Test: `frontend/tests/unit/shadergen-prompt.unit.spec.ts`

**Interfaces:**
- Consumes: `GenParam` and `GenTake` from Task 1.
- Produces:
  - `TAKE_ANGLES: readonly string[]`
  - `interface GenBase { name: string; source: string; params: GenParam[] }`
  - `interface GenRequest { request: string; base?: GenBase | null; references?: GenBase[]; takeIndex: number; avoid?: string }`
  - `buildGenPrompt(r: GenRequest): string`
  - `buildRepairPrompt(r: GenRequest, failed: GenTake, reason: string): string`
  - `parseGenResponse(text: string): GenTake | null`
  - `REVIEW_SCHEMA`
  - `buildReviewPrompt(request: string, count: number): string`
  - `parseReview(text: string, count: number): boolean[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-prompt.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { GenTake } from '~~/shared/shadergen/contract'
import { buildGenPrompt, buildRepairPrompt, buildReviewPrompt, parseGenResponse, parseReview, TAKE_ANGLES } from '~/lib/shadergen/prompt'

const reply = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: '  Fogged glass  ', animated: true, generative: false, body: 'void main(){}',
  params: [
    { uniform: 'u_fog', label: 'Fog', type: 'float', min: 0, max: 1, step: 0.01, default: 1.4 },
    { uniform: 'u_mode', label: 'Pattern', type: 'enum', default: 7, options: [{ label: 'Drops', value: 0 }, { label: 'Streaks', value: 1 }] },
    { uniform: 'u_tint', label: 'Tint', type: 'color', default: '#FF7A3D' },
  ],
  ...over,
})

describe('buildGenPrompt', () => {
  it('states the request and the take angle', () => {
    const p = buildGenPrompt({ request: 'rain on a window', takeIndex: 2 })
    expect(p).toContain('Request: "rain on a window"')
    expect(p).toContain(TAKE_ANGLES[2])
    expect(p).not.toContain('Start from this existing effect')
  })

  it('includes a base effect with its source and dials', () => {
    const p = buildGenPrompt({ request: 'rain', takeIndex: 0, base: { name: 'Water Ripple', source: 'void main(){ /*ripple*/ }', params: [] } })
    expect(p).toContain('Start from this existing effect, "Water Ripple"')
    expect(p).toContain('/*ripple*/')
  })

  it('includes references and what to avoid', () => {
    const p = buildGenPrompt({ request: 'rain', takeIndex: 1, references: [{ name: 'Fbm Warp', source: 'REF_SRC', params: [] }], avoid: 'the render was black' })
    expect(p).toContain('"Fbm Warp"')
    expect(p).toContain('REF_SRC')
    expect(p).toContain('A previous attempt failed: the render was black')
  })

  it('repair prompts carry the reason and the rejected body', () => {
    const failed: GenTake = { name: 'X', animated: false, generative: false, params: [], body: 'BROKEN_BODY' }
    const p = buildRepairPrompt({ request: 'rain', takeIndex: 0 }, failed, "it did not compile:\nERROR: 0:12: 'foo' : undeclared")
    expect(p).toContain('was rejected: it did not compile')
    expect(p).toContain('BROKEN_BODY')
  })
})

describe('parseGenResponse', () => {
  it('reads a valid reply, trimming the name and fixing out-of-range defaults', () => {
    const t = parseGenResponse(reply())!
    expect(t.name).toBe('Fogged glass')
    expect(t.params[0]).toEqual({ uniform: 'u_fog', label: 'Fog', type: 'float', min: 0, max: 1, step: 0.01, default: 1 })
    expect(t.params[1]!.default).toBe(0)
    expect(t.params[2]!.default).toBe('#ff7a3d')
  })

  it('rejects malformed replies', () => {
    expect(parseGenResponse('not json')).toBeNull()
    expect(parseGenResponse(reply({ body: 5 }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'float', min: 1, max: 1, default: 1 }] }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'color', default: 'red' }] }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'enum', default: 0, options: [{ label: 'One', value: 0 }] }] }))).toBeNull()
  })

  it('gives a float without a usable step a hundredth of its range', () => {
    const t = parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'float', min: 0, max: 2, default: 1 }] }))!
    expect(t.params[0]!.step).toBe(0.02)
  })
})

describe('visual review', () => {
  it('asks for one verdict per take, left to right', () => {
    expect(buildReviewPrompt('rain on a window', 4)).toContain('exactly 4 booleans in left-to-right order')
  })

  it('reads verdicts, and keeps everything when the reply is unusable', () => {
    expect(parseReview('{"keep":[true,false,true,true],"reasons":["a","b","c","d"]}', 4)).toEqual([true, false, true, true])
    expect(parseReview('{"keep":[true,false]}', 4)).toEqual([true, true, true, true])
    expect(parseReview('nope', 3)).toEqual([true, true, true])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-prompt.unit.spec.ts`
Expected: FAIL. It cannot resolve `~/lib/shadergen/prompt`.

- [ ] **Step 3: Implement**

Create `frontend/app/lib/shadergen/prompt.ts`:

```ts
/**
 * User-turn prompts for /api/shader-gen (the system prompt is static and lives
 * server-side, ~~/shared/shadergen/system.ts), strict parsing of the model's
 * reply into a GenTake, and the one-image visual review that drops misses
 * (sent through the existing /api/agent-review route).
 */
import type { GenParam, GenTake } from '~~/shared/shadergen/contract'

/** One angle per take, so four parallel calls don't return four near-copies. */
export const TAKE_ANGLES = [
  'Take 1 of 4: the most direct, literal reading of the request.',
  'Take 2 of 4: a bolder, more stylised reading.',
  'Take 3 of 4: a restrained reading that keeps the image easy to read.',
  'Take 4 of 4: an unexpected interpretation that still clearly answers the request.',
] as const

export interface GenBase { name: string; source: string; params: GenParam[] }

export interface GenRequest {
  request: string
  /** The effect being remixed (full catalog source, preamble included). */
  base?: GenBase | null
  /** Related existing effects for a "from nothing" request. */
  references?: GenBase[]
  takeIndex: number
  /** Why the previous attempt was thrown away, in plain words. */
  avoid?: string
}

export function buildGenPrompt(r: GenRequest): string {
  const parts: string[] = [`Request: "${r.request}"`]
  if (r.base) {
    parts.push(`Start from this existing effect, "${r.base.name}". Keep what serves the request and change whatever you need to. Its full source (preamble included) and dials:\n\`\`\`glsl\n${r.base.source}\n\`\`\`\nDials: ${JSON.stringify(r.base.params)}`)
  }
  for (const ref of r.references ?? []) {
    parts.push(`For reference only, a related existing effect, "${ref.name}":\n\`\`\`glsl\n${ref.source}\n\`\`\``)
  }
  parts.push(TAKE_ANGLES[r.takeIndex % TAKE_ANGLES.length]!)
  if (r.avoid) parts.push(`A previous attempt failed: ${r.avoid}. Do not repeat that.`)
  parts.push('Reply with the JSON object only.')
  return parts.join('\n\n')
}

export function buildRepairPrompt(r: GenRequest, failed: GenTake, reason: string): string {
  return `${buildGenPrompt(r)}\n\nYour previous reply for this take was rejected: ${reason}\nPrevious body:\n\`\`\`glsl\n${failed.body}\n\`\`\`\nFix the problem and return the whole corrected JSON object.`
}

const HEX = /^#[0-9a-fA-F]{6}$/

function parseParam(p: any): GenParam | null {
  if (!p || typeof p.uniform !== 'string' || typeof p.label !== 'string') return null
  if (p.type === 'float') {
    if (![p.min, p.max, p.default].every(Number.isFinite) || p.min >= p.max) return null
    const step = Number.isFinite(p.step) && p.step > 0 ? p.step : Math.round(((p.max - p.min) / 100) * 1e6) / 1e6
    return { uniform: p.uniform, label: p.label, type: 'float', min: p.min, max: p.max, step, default: Math.min(Math.max(p.default, p.min), p.max) }
  }
  if (p.type === 'enum') {
    const options = (Array.isArray(p.options) ? p.options : [])
      .filter((o: any) => o && typeof o.label === 'string' && Number.isInteger(o.value))
      .map((o: any) => ({ label: o.label, value: o.value as number }))
    if (options.length < 2) return null
    const def = options.some((o: { value: number }) => o.value === p.default) ? p.default : options[0].value
    return { uniform: p.uniform, label: p.label, type: 'enum', default: def, options }
  }
  if (p.type === 'color') {
    if (typeof p.default !== 'string' || !HEX.test(p.default)) return null
    return { uniform: p.uniform, label: p.label, type: 'color', default: p.default.toLowerCase() }
  }
  return null
}

export function parseGenResponse(text: string): GenTake | null {
  let v: any
  try { v = JSON.parse(text) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.body !== 'string' || !Array.isArray(v.params)) return null
  const params: GenParam[] = []
  for (const raw of v.params) {
    const p = parseParam(raw)
    if (!p) return null
    params.push(p)
  }
  return { name: v.name.trim().slice(0, 40) || 'Untitled', animated: !!v.animated, generative: !!v.generative, params, body: v.body }
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'reasons'],
  properties: {
    keep: { type: 'array', items: { type: 'boolean' } },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const

export function buildReviewPrompt(request: string, count: number): string {
  return `The image shows ${count} shader effects side by side, left to right, made for the request "${request}". Each was rendered on the same photo. For each one, decide whether a designer would plausibly keep it: it answers the request, looks intentional, and is not muddy, washed out, too dark, or missing the subject (unless the request asks for that). Return "keep" with exactly ${count} booleans in left-to-right order, and "reasons" with one short reason per effect.`
}

/** A reply that can't be read keeps everything — the review only ever removes. */
export function parseReview(text: string, count: number): boolean[] {
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v?.keep) && v.keep.length === count && v.keep.every((b: unknown) => typeof b === 'boolean')) return v.keep
  } catch { /* fall through */ }
  return Array.from({ length: count }, () => true)
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/shadergen-prompt.unit.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/lib/shadergen/prompt.ts frontend/tests/unit/shadergen-prompt.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): prompts, reply parsing and visual review" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/lib/shadergen/prompt.ts frontend/tests/unit/shadergen-prompt.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 5: The `/api/shader-gen` route

**Files:**
- Create: `frontend/server/lib/shaderGenRequest.ts`
- Create: `frontend/server/api/shader-gen.post.ts`
- Test: `frontend/tests/unit/shadergen-request.unit.spec.ts`

**Interfaces:**
- Consumes:
  - `SHADERGEN_TAKE_SCHEMA` (Task 1) and `SHADERGEN_SYSTEM` (Task 1).
  - `modelForTier` and `effortForTier` from `server/lib/aiModels.ts`.
  - `requireString`, `optionalTier`, `optionalApiKey`, `resolveAnthropicKey` and `MAX_PROMPT_CHARS` from `server/lib/agentRequest.ts`.
  - `extractModelText` from `server/lib/modelText.ts`; `meterAssist` from `server/utils/anthropicMeter.ts`; `assertRateLimit` from `server/lib/rateLimit.ts`.
- Produces:
  - `SHADERGEN_MAX_TOKENS = 6000`
  - `buildShaderGenPayload(body: { tier?: unknown; prompt?: unknown }): Record<string, unknown>`
  - HTTP: `POST /api/shader-gen`, body `{ apiKey?, tier?: 'patch'|'plan'|'campaign', prompt }`, which returns `{ text: string, usage: { input_tokens: number, output_tokens: number } | null }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-request.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildShaderGenPayload, SHADERGEN_MAX_TOKENS } from '../../server/lib/shaderGenRequest'
import { AI_TIERS } from '../../server/lib/aiModels'
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'

describe('buildShaderGenPayload', () => {
  it('defaults to the plan tier with capped effort, the cached system prompt and the take schema', () => {
    const p = buildShaderGenPayload({ prompt: 'Request: "rain"' }) as any
    expect(p.model).toBe(AI_TIERS.plan)
    expect(p.max_tokens).toBe(SHADERGEN_MAX_TOKENS)
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA }, effort: 'low' })
    expect(p.system).toEqual([{ type: 'text', text: SHADERGEN_SYSTEM, cache_control: { type: 'ephemeral' } }])
    expect(p.messages).toEqual([{ role: 'user', content: 'Request: "rain"' }])
  })

  it('patch tier uses Haiku and sends no effort (Haiku rejects it with a 400)', () => {
    const p = buildShaderGenPayload({ prompt: 'x', tier: 'patch' }) as any
    expect(p.model).toBe(AI_TIERS.patch)
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA } })
  })

  it('rejects a missing prompt and an unknown tier', () => {
    expect(() => buildShaderGenPayload({})).toThrow('prompt is required')
    expect(() => buildShaderGenPayload({ prompt: 'x', tier: 'turbo' })).toThrow("unknown tier 'turbo'")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-request.unit.spec.ts`
Expected: FAIL. It cannot resolve `server/lib/shaderGenRequest`.

- [ ] **Step 3: Implement the payload builder**

Create `frontend/server/lib/shaderGenRequest.ts`:

```ts
/**
 * Payload for one /api/shader-gen call: one take, strict JSON (the shared take
 * schema), the static system prompt as a cached block. Kept out of the route so
 * it is unit-testable without h3 (same pattern as agentRequest.ts).
 */
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { effortForTier, modelForTier } from './aiModels'
import { MAX_PROMPT_CHARS, optionalTier, requireString } from './agentRequest'

/** One take: ~1–3k tokens of GLSL + dials, with headroom. */
export const SHADERGEN_MAX_TOKENS = 6000

export function buildShaderGenPayload(body: { tier?: unknown; prompt?: unknown }): Record<string, unknown> {
  const prompt = requireString(body?.prompt, 'prompt', MAX_PROMPT_CHARS)
  const tier = optionalTier(body?.tier) ?? 'plan'
  const effort = effortForTier(tier)
  return {
    model: modelForTier(tier),
    max_tokens: SHADERGEN_MAX_TOKENS,
    system: [{ type: 'text', text: SHADERGEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA },
      ...(effort ? { effort } : {}),
    },
    messages: [{ role: 'user', content: prompt }],
  }
}
```

- [ ] **Step 4: Implement the route**

Create `frontend/server/api/shader-gen.post.ts`:

```ts
/**
 * Writes ONE shader take (AI in Sailor spec §7.2). The browser engine calls this
 * four times in parallel (one per take angle) plus repair calls, then compiles,
 * checks and reviews the results itself. Returns the raw JSON text and token
 * usage so the evaluation page can report cost.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { assertRateLimit } from '../lib/rateLimit'
import { optionalApiKey, resolveAnthropicKey } from '../lib/agentRequest'
import { extractModelText } from '../lib/modelText'
import { buildShaderGenPayload } from '../lib/shaderGenRequest'
import { meterAssist } from '../utils/anthropicMeter'

export default defineEventHandler(async (event) => {
  // A request is 4 parallel takes, each with up to 5 calls (repairs); two tiers
  // can run side by side on the eval page — 120/min leaves headroom for that.
  assertRateLimit(event, 'shader-gen', 120)
  const body = await readBody<{ apiKey?: string; tier?: string; prompt?: string }>(event)
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(body?.apiKey))
  const payload = buildShaderGenPayload(body ?? {})

  await meterAssist(event)

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw createError({ statusCode: res.status, statusMessage: `model error: ${detail.slice(0, 200)}` })
  }
  const json = await res.json()
  return { text: extractModelText(json), usage: json?.usage ?? null }
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/shadergen-request.unit.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Check that the route loads (no paid call)**

Check the existing dev server first: `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then find the main checkout's port (usually 3002). Do **not** start one. Run:

`curl -s -X POST http://127.0.0.1:3002/api/shader-gen -H 'content-type: application/json' -d '{"tier":"turbo","prompt":"x"}'`

Expected: a JSON error containing `unknown tier 'turbo'`. That proves the route is registered and validates before it reaches the paid call. If the response instead mentions AI assist not being configured (503), that's also acceptable proof, because the key check runs first.

- [ ] **Step 7: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/server/lib/shaderGenRequest.ts frontend/server/api/shader-gen.post.ts frontend/tests/unit/shadergen-request.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): /api/shader-gen — one take per call, strict schema" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/server/lib/shaderGenRequest.ts frontend/server/api/shader-gen.post.ts frontend/tests/unit/shadergen-request.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 6: The engine

**Files:**
- Create: `frontend/app/lib/shadergen/engine.ts`
- Test: `frontend/tests/unit/shadergen-engine.unit.spec.ts`

**Interfaces:**
- Consumes: `GenTake` (Task 1); `staticCheck` (Task 2); `Flag` (Task 3); `buildGenPrompt`, `buildRepairPrompt`, `parseGenResponse`, `GenBase` and `GenRequest` (Task 4).
- Produces:
  - `interface Usage { input_tokens: number; output_tokens: number }`
  - `interface TakeRenderer { compile(take: GenTake): string | null; judge(take: GenTake): { pass: boolean; flags: Flag[]; thumbnail: string }; sheet(takes: GenTake[]): string }`
  - `interface EngineDeps { callModel(prompt: string): Promise<{ text: string; usage?: Usage }>; review?(sheet: string, request: string, count: number): Promise<boolean[]>; renderer: TakeRenderer; now?: () => number }`
  - `interface EngineInput { request: string; base?: GenBase | null; references?: GenBase[]; count?: number }`
  - `interface EngineTake { take: GenTake; flags: Flag[]; thumbnail: string; modelCalls: number; log: string[] }`
  - `interface EngineFailure { index: number; modelCalls: number; log: string[] }`
  - `interface EngineResult { takes: EngineTake[]; failures: EngineFailure[]; dropped: number; usage: Usage; ms: number }`
  - `MAX_COMPILE_REPAIRS = 2`, `MAX_MODEL_CALLS_PER_TAKE = 5`
  - `generateTakes(input: EngineInput, deps: EngineDeps): Promise<EngineResult>`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-engine.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { GenTake } from '~~/shared/shadergen/contract'
import { generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'

const P = (u: string) => ({ uniform: u, label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 })
const body = (marker = '') => `uniform float u_a; uniform float u_b; uniform float u_c;
void main(){ /*${marker}*/ fragColor0 = vec4(tex(v_texCoord)*u_a*u_b*u_c, 1.0); }`
const reply = (marker = '', name = 'Take') =>
  JSON.stringify({ name, animated: false, generative: false, params: [P('u_a'), P('u_b'), P('u_c')], body: body(marker) })

/** Scripted model: replies per take index, consumed in order; the last reply repeats. */
function scripted(byTake: Record<number, string[]>) {
  const prompts: string[][] = [[], [], [], []]
  const used: number[] = [0, 0, 0, 0]
  return {
    prompts,
    callModel: async (prompt: string) => {
      const i = Number(/Take (\d) of 4/.exec(prompt)![1]) - 1
      prompts[i]!.push(prompt)
      const list = byTake[i] ?? [reply('', `Take ${i + 1}`)]
      const text = list[Math.min(used[i]!, list.length - 1)]!
      used[i]!++
      return { text, usage: { input_tokens: 10, output_tokens: 5 } }
    },
  }
}

/** Fake renderer: BROKEN doesn't compile, BLACK fails the checks. */
const renderer: TakeRenderer = {
  compile: (t: GenTake) => (t.body.includes('BROKEN') ? "ERROR: 0:9: 'x' : undeclared identifier" : null),
  judge: (t: GenTake) => (t.body.includes('BLACK') ? { pass: false, flags: ['black'], thumbnail: '' } : { pass: true, flags: [], thumbnail: `thumb:${t.name}` }),
  sheet: (takes: GenTake[]) => `sheet:${takes.length}`,
}

describe('generateTakes', () => {
  it('returns four takes from four clean replies, one call each, with usage summed', async () => {
    const m = scripted({})
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer, now: () => 0 })
    expect(r.takes.map(t => t.take.name)).toEqual(['Take 1', 'Take 2', 'Take 3', 'Take 4'])
    expect(r.takes.every(t => t.modelCalls === 1)).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.usage).toEqual({ input_tokens: 40, output_tokens: 20 })
  })

  it('repairs a compile error by sending the error back', async () => {
    const m = scripted({ 0: [reply('BROKEN'), reply('fixed')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.takes.find(t => t.take.body.includes('fixed'))!.modelCalls).toBe(2)
    expect(m.prompts[0]![1]).toContain('was rejected: it did not compile')
    expect(m.prompts[0]![1]).toContain('undeclared identifier')
  })

  it('gives up on a take after two compile repairs', async () => {
    const m = scripted({ 1: [reply('BROKEN')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.takes).toHaveLength(3)
    expect(r.failures).toEqual([expect.objectContaining({ index: 1, modelCalls: 3 })])
  })

  it('sends a static-check failure back as the reason', async () => {
    const twoDials = JSON.stringify({ name: 'X', animated: false, generative: false, params: [P('u_a'), P('u_b')], body: 'uniform float u_a; uniform float u_b; void main(){ fragColor0=vec4(u_a*u_b); }' })
    const m = scripted({ 2: [twoDials, reply('ok')] })
    await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(m.prompts[2]![1]).toContain('It has 2 dials; it needs 3 to 5')
  })

  it('regenerates once when the render checks fail, naming what went wrong', async () => {
    const m = scripted({ 3: [reply('BLACK'), reply('lit')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(m.prompts[3]![1]).toContain('A previous attempt failed: the render was black')
    expect(r.takes).toHaveLength(4)
  })

  it('drops takes the visual review rejects and replaces them', async () => {
    const m = scripted({ 1: [reply('first', 'Muddy'), reply('second', 'Better')] })
    const seen: string[] = []
    const r = await generateTakes({ request: 'rain' }, {
      callModel: m.callModel,
      renderer,
      review: async (sheet, request, count) => { seen.push(`${sheet}|${request}|${count}`); return [true, false, true, true] },
    })
    expect(seen).toEqual(['sheet:4|rain|4'])
    expect(r.dropped).toBe(1)
    expect(r.takes.map(t => t.take.name)).toEqual(['Take 1', 'Take 3', 'Take 4', 'Better'])
    expect(m.prompts[1]![1]).toContain('a reviewer judged the previous attempt a miss')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-engine.unit.spec.ts`
Expected: FAIL. It cannot resolve `~/lib/shadergen/engine`.

- [ ] **Step 3: Implement**

Create `frontend/app/lib/shadergen/engine.ts`:

```ts
/**
 * The shader-generation engine (AI in Sailor spec §7.2). Four takes run in
 * parallel, one per take angle. Each take: model reply → parse → static checks →
 * compile (repair up to twice with the compiler's error) → render checks
 * (regenerate once, naming the flags) → done. Then one visual review of all
 * survivors; each rejected take is regenerated once. The renderer and the model
 * are injected, so this file never touches WebGL or the network.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { staticCheck } from './staticCheck'
import { buildGenPrompt, buildRepairPrompt, parseGenResponse, type GenBase, type GenRequest } from './prompt'
import type { Flag } from './renderChecks'

export interface Usage { input_tokens: number; output_tokens: number }

export interface TakeRenderer {
  /** null when the shader compiles; otherwise the compiler's error log. */
  compile(take: GenTake): string | null
  /** Render, time and judge one take; thumbnail is a data URL. */
  judge(take: GenTake): { pass: boolean; flags: Flag[]; thumbnail: string }
  /** One image of the takes side by side, left to right, as a data URL. */
  sheet(takes: GenTake[]): string
}

export interface EngineDeps {
  callModel(prompt: string): Promise<{ text: string; usage?: Usage }>
  review?(sheet: string, request: string, count: number): Promise<boolean[]>
  renderer: TakeRenderer
  now?: () => number
}

export interface EngineInput { request: string; base?: GenBase | null; references?: GenBase[]; count?: number }
export interface EngineTake { take: GenTake; flags: Flag[]; thumbnail: string; modelCalls: number; log: string[] }
export interface EngineFailure { index: number; modelCalls: number; log: string[] }
export interface EngineResult { takes: EngineTake[]; failures: EngineFailure[]; dropped: number; usage: Usage; ms: number }

export const MAX_COMPILE_REPAIRS = 2
export const MAX_MODEL_CALLS_PER_TAKE = 5

const REVIEW_MISS = 'a reviewer judged the previous attempt a miss (muddy, off-brief, or losing the subject)'

const isTake = (r: EngineTake | EngineFailure): r is EngineTake => 'take' in r

async function runTake(input: EngineInput, index: number, deps: EngineDeps, usage: Usage, avoid?: string): Promise<EngineTake | EngineFailure> {
  const req: GenRequest = { request: input.request, base: input.base ?? null, references: input.references, takeIndex: index, avoid }
  const log: string[] = []
  let prompt = buildGenPrompt(req)
  let compileRepairs = 0
  let regenerated = false
  let calls = 0
  while (calls < MAX_MODEL_CALLS_PER_TAKE) {
    calls++
    const res = await deps.callModel(prompt)
    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens
      usage.output_tokens += res.usage.output_tokens
    }
    const take = parseGenResponse(res.text)
    if (!take) {
      log.push('reply could not be read')
      prompt = buildGenPrompt({ ...req, avoid: 'the reply was not valid JSON in the required shape' })
      continue
    }
    const st = staticCheck(take)
    if (!st.ok) {
      log.push(`static: ${st.reason}`)
      prompt = buildRepairPrompt(req, take, st.reason)
      continue
    }
    const err = deps.renderer.compile(take)
    if (err) {
      log.push(`compile: ${err.slice(0, 300)}`)
      if (compileRepairs >= MAX_COMPILE_REPAIRS) break
      compileRepairs++
      prompt = buildRepairPrompt(req, take, `it did not compile:\n${err}`)
      continue
    }
    const judged = deps.renderer.judge(take)
    if (!judged.pass) {
      log.push(`checks: ${judged.flags.join(', ')}`)
      if (regenerated) break
      regenerated = true
      prompt = buildGenPrompt({ ...req, avoid: `the render was ${judged.flags.join(', ')}` })
      continue
    }
    return { take, flags: judged.flags, thumbnail: judged.thumbnail, modelCalls: calls, log }
  }
  return { index, modelCalls: calls, log }
}

export async function generateTakes(input: EngineInput, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const count = input.count ?? 4
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }

  const first = await Promise.all(Array.from({ length: count }, (_, i) => runTake(input, i, deps, usage)))
  let takes = first.filter(isTake)
  const failures = first.filter((r): r is EngineFailure => !isTake(r))
  let dropped = 0

  if (deps.review && takes.length >= 2) {
    const keep = await deps.review(deps.renderer.sheet(takes.map(t => t.take)), input.request, takes.length)
    const indexOf = new Map(takes.map((t, i) => [t, first.indexOf(t)] as const))
    const rejected = takes.filter((_, i) => keep[i] === false)
    dropped = rejected.length
    const replacements = await Promise.all(rejected.map(t => runTake(input, indexOf.get(t)!, deps, usage, REVIEW_MISS)))
    takes = [...takes.filter((_, i) => keep[i] !== false), ...replacements.filter(isTake)]
    failures.push(...replacements.filter((r): r is EngineFailure => !isTake(r)))
  }

  return { takes, failures, dropped, usage, ms: now() - t0 }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/shadergen-engine.unit.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/lib/shadergen/engine.ts frontend/tests/unit/shadergen-engine.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): engine — parallel takes, repair, regenerate, visual review" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/lib/shadergen/engine.ts frontend/tests/unit/shadergen-engine.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 7: The browser renderer and the client wrappers

**Files:**
- Create: `frontend/app/lib/shadergen/effectDef.ts`
- Create: `frontend/app/lib/shadergen/browserRenderer.ts`
- Create: `frontend/app/lib/shadergen/client.ts`
- Test: `frontend/tests/unit/shadergen-effect-def.unit.spec.ts`

`browserRenderer.ts` has no unit test, because it needs WebGL2. Task 8's E2E renders all 24 spike takes through it.

**Interfaces:**
- Consumes:
  - `assembleSource` and `GenTake` (Task 1); `judgeFrames` (Task 3); `REVIEW_SCHEMA`, `buildReviewPrompt` and `parseReview` (Task 4); `TakeRenderer` and `Usage` (Task 6).
  - `ShaderFxRenderer`, `expandPasses` and the `ShaderPass` type from `~/lib/shaderfx/renderer`; `resolveUniforms` from `~/lib/shaderfx/params`; `EffectDef` and `EffectParamDef` from `~/lib/shaderfx/types`.
- Produces:
  - `toEffectDef(take: GenTake, id: string): EffectDef`
  - `createBrowserTakeRenderer(source: HTMLImageElement | HTMLCanvasElement): TakeRenderer`
  - `makeCallModel(apiKey: string, tier: 'patch' | 'plan'): EngineDeps['callModel']`
  - `makeReview(apiKey: string): NonNullable<EngineDeps['review']>`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/shadergen-effect-def.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assembleSource } from '~~/shared/shadergen/contract'
import { resolveUniforms } from '~/lib/shaderfx/params'
import { toEffectDef } from '~/lib/shadergen/effectDef'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

describe('toEffectDef', () => {
  it('turns a take into an EffectDef the existing renderer and params code accept', () => {
    const take = SPIKE_TAKES.lava![0]!
    const def = toEffectDef(take, 'gen_1')
    expect(def).toMatchObject({ id: 'gen_1', name: take.name, category: 'mine', passes: 1, centerParam: null, textures: [], animated: take.animated, generative: take.generative })
    expect(def.source).toBe(assembleSource(take.body))
    const u = resolveUniforms(def, {})
    expect(u.u_blob).toEqual([1, 90 / 255, 31 / 255])
    expect(typeof u.u_speed).toBe('number')
  })
})
```

The lava take's `u_blob` default is `#ff5a1f`, so `hexVec3` gives `[1, 90/255, 31/255]`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/shadergen-effect-def.unit.spec.ts`
Expected: FAIL. It cannot resolve `~/lib/shadergen/effectDef`.

- [ ] **Step 3: Implement `effectDef.ts`**

Create `frontend/app/lib/shadergen/effectDef.ts`:

```ts
/** A generated take as a regular EffectDef, so every existing shader path
 *  (renderer, params, dials, fills, embeds) can use it unchanged. */
import { assembleSource, type GenTake } from '~~/shared/shadergen/contract'
import type { EffectDef, EffectParamDef } from '~/lib/shaderfx/types'

export function toEffectDef(take: GenTake, id: string): EffectDef {
  return {
    id,
    name: take.name,
    category: 'mine',
    animated: take.animated,
    passes: 1,
    centerParam: null,
    textures: [],
    generative: take.generative,
    source: assembleSource(take.body),
    params: take.params.map(p => ({ ...p }) as EffectParamDef),
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/shadergen-effect-def.unit.spec.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Implement the browser renderer**

Create `frontend/app/lib/shadergen/browserRenderer.ts`:

```ts
/**
 * The engine's TakeRenderer on Sailor's own WebGL2 renderer. Compiles by
 * rendering a tiny frame (ShaderFxRenderer throws "shaderfx compile (id): …"
 * with the info log), judges from two 24×24 samples (t = 2.0 and 3.37) plus a
 * cost measurement against a plain copy, exactly like the spike page.
 * Holds its OWN renderer instance, never the app-wide `shaderFx` singleton.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { ShaderFxRenderer, expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import { resolveUniforms } from '~/lib/shaderfx/params'
import type { EffectDef } from '~/lib/shaderfx/types'
import { toEffectDef } from './effectDef'
import { judgeFrames } from './renderChecks'
import type { TakeRenderer } from './engine'

const THUMB = 256
const SAMPLE = 24
const COST_SIZE = 1024
const COST_FRAMES = 10
const COPY_FS = `#version 300 es
precision highp float; uniform sampler2D u_image0; in vec2 v_texCoord; layout(location = 0) out vec4 fragColor0;
void main(){ fragColor0 = texture(u_image0, v_texCoord); }`

function passesFor(def: EffectDef, t: number): ShaderPass[] {
  return expandPasses(def.id, def.source, { ...resolveUniforms(def, {}), u_time: t, u_seed: 0 }, undefined, 1)
}

export function createBrowserTakeRenderer(source: HTMLImageElement | HTMLCanvasElement): TakeRenderer {
  const renderer = new ShaderFxRenderer()
  const defs = new WeakMap<GenTake, EffectDef>()
  let seq = 0
  // One EffectDef (and program id) per take object: attempts never share an id,
  // so the renderer's program cache can't serve an older attempt's source.
  const defFor = (take: GenTake) => {
    let d = defs.get(take)
    if (!d) { d = toEffectDef(take, `shadergen_${++seq}`); defs.set(take, d) }
    return d
  }

  const small = document.createElement('canvas')
  small.width = small.height = SAMPLE
  const sctx = small.getContext('2d', { willReadFrequently: true })!
  const sample = (src: CanvasImageSource) => {
    sctx.clearRect(0, 0, SAMPLE, SAMPLE)
    sctx.drawImage(src, 0, 0, SAMPLE, SAMPLE)
    return sctx.getImageData(0, 0, SAMPLE, SAMPLE).data
  }
  const sourcePx = sample(source)

  const px = new Uint8Array(4)
  function cost(passes: ShaderPass[]): number {
    renderer.render(passes, source, COST_SIZE, COST_SIZE)
    const gl = renderer.outputCanvas!.getContext('webgl2')!
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t0 = performance.now()
    for (let k = 0; k < COST_FRAMES; k++) {
      renderer.render(passes.map(p => ({ ...p, uniforms: { ...p.uniforms, u_time: 3 + k * 0.01 } })), source, COST_SIZE, COST_SIZE)
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return (performance.now() - t0) / COST_FRAMES
  }
  let baseline: number | null = null
  const copy: ShaderPass[] = [{ id: '__shadergen_copy', source: COPY_FS, uniforms: {} }]

  return {
    compile(take) {
      try {
        renderer.render(passesFor(defFor(take), 0), source, 64, 64)
        return null
      } catch (e) {
        return String((e as Error)?.message ?? e)
      }
    },
    judge(take) {
      const def = defFor(take)
      renderer.render(passesFor(def, 2.0), source, THUMB, THUMB)
      const a = sample(renderer.outputCanvas!)
      const thumbnail = renderer.outputCanvas!.toDataURL('image/png')
      renderer.render(passesFor(def, 3.37), source, THUMB, THUMB)
      const b = sample(renderer.outputCanvas!)
      if (baseline === null) { cost(copy); baseline = cost(copy) }
      const extraMs = Math.max(0, cost(passesFor(def, 3)) - baseline)
      return { ...judgeFrames({ a, b, source: sourcePx, generative: take.generative, animated: take.animated, extraMs }), thumbnail }
    },
    sheet(takes) {
      const c = document.createElement('canvas')
      c.width = THUMB * takes.length
      c.height = THUMB
      const ctx = c.getContext('2d')!
      takes.forEach((t, i) => {
        renderer.render(passesFor(defFor(t), 2.0), source, THUMB, THUMB)
        ctx.drawImage(renderer.outputCanvas!, i * THUMB, 0)
      })
      return c.toDataURL('image/jpeg', 0.85)
    },
  }
}
```

- [ ] **Step 6: Implement the client wrappers**

Create `frontend/app/lib/shadergen/client.ts`:

```ts
/** Network side of the engine: one take per /api/shader-gen call, and the visual
 *  review through the existing /api/agent-review route (always on 'plan', so
 *  both code-writing tiers are judged by the same reviewer). */
import type { EngineDeps, Usage } from './engine'
import { buildReviewPrompt, parseReview, REVIEW_SCHEMA } from './prompt'

export function makeCallModel(apiKey: string, tier: 'patch' | 'plan'): EngineDeps['callModel'] {
  return async (prompt: string) => {
    const res = await $fetch<{ text: string; usage: Usage | null }>('/api/shader-gen', {
      method: 'POST',
      body: { apiKey, tier, prompt },
      timeout: 120_000,
    })
    return { text: res.text, usage: res.usage ?? undefined }
  }
}

export function makeReview(apiKey: string): NonNullable<EngineDeps['review']> {
  return async (sheet: string, request: string, count: number) => {
    const res = await $fetch<{ text: string }>('/api/agent-review', {
      method: 'POST',
      body: { apiKey, tier: 'plan', prompt: buildReviewPrompt(request, count), schema: REVIEW_SCHEMA, image: sheet },
      timeout: 60_000,
    })
    return parseReview(res.text, count)
  }
}
```

- [ ] **Step 7: Run all shadergen unit tests**

Run: `npx vitest run tests/unit/shadergen-`
Expected: PASS for all 6 files.

- [ ] **Step 8: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/lib/shadergen/effectDef.ts frontend/app/lib/shadergen/browserRenderer.ts frontend/app/lib/shadergen/client.ts frontend/tests/unit/shadergen-effect-def.unit.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): browser renderer on ShaderFxRenderer, client wrappers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/lib/shadergen/effectDef.ts frontend/app/lib/shadergen/browserRenderer.ts frontend/app/lib/shadergen/client.ts frontend/tests/unit/shadergen-effect-def.unit.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 8: The evaluation page

**Files:**
- Create: `frontend/app/pages/dev/shader-gen-eval.vue`
- Test: `frontend/tests/shader-gen-eval.spec.ts`

**Interfaces:**
- Consumes:
  - `EVAL_REQUESTS` and `SPIKE_TAKES` (Task 1); `generateTakes`, `EngineResult` and `TakeRenderer` (Task 6); `createBrowserTakeRenderer`, `makeCallModel` and `makeReview` (Task 7); `GenBase` (Task 4).
  - `fetchShaderFxCatalog()` from `~/lib/shaderfx/catalog`, which returns `{ effects: EffectDef[] }`.
  - `useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey')`.
- Produces: the dev page `/dev/shader-gen-eval`. Its DOM contract for tests is `[data-row="spike"|"plan"|"patch"]` holding `[data-tile]` elements with `data-compiled` and `data-flags` attributes.

- [ ] **Step 1: Write the failing E2E test**

Create `frontend/tests/shader-gen-eval.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

// Renders the 24 hand-written spike takes through the engine's browser renderer
// (Sailor's real ShaderFxRenderer). Never presses Run, so it makes no paid calls.
test('shader-gen eval page renders all 24 spike takes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/dev/shader-gen-eval')
  const tiles = page.locator('[data-row="spike"] [data-tile]')
  await expect(tiles).toHaveCount(24, { timeout: 60_000 })
  await expect(page.locator('[data-row="spike"] [data-tile][data-compiled="false"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run Sonnet 5 and Haiku 4.5' })).toBeEnabled()
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Confirm the main dev server is up (`lsof -nP -iTCP -sTCP:LISTEN | grep node`); do not start one. Then run:
`npx playwright test tests/shader-gen-eval.spec.ts --project=chromium`
Expected: FAIL. The page 404s, so it finds 0 tiles.

- [ ] **Step 3: Implement the page**

Create `frontend/app/pages/dev/shader-gen-eval.vue`:

```vue
<script setup lang="ts">
// Dev-only evaluation of the shader-generation engine (AI in Sailor spec §7, build
// stage 1). Per request: the hand-written spike takes, then the real engine on
// Sonnet 5 and Haiku 4.5. Nothing calls the paid API until Run is pressed AND
// confirmed. Click a tile to mark it a keeper; "Copy results" exports everything.
definePageMeta({ layout: false })
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import type { GenTake } from '~~/shared/shadergen/contract'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import type { EffectDef } from '~/lib/shaderfx/types'
import { EVAL_REQUESTS } from '~/lib/shadergen/__eval__/requests'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { createBrowserTakeRenderer } from '~/lib/shadergen/browserRenderer'
import { makeCallModel, makeReview } from '~/lib/shadergen/client'
import { generateTakes, type EngineResult, type TakeRenderer } from '~/lib/shadergen/engine'
import type { GenBase } from '~/lib/shadergen/prompt'

type RowId = 'spike' | 'plan' | 'patch'
interface Tile { take: GenTake; thumbnail: string; flags: string[]; compiled: boolean; calls: number | null; keep: boolean }
interface Row { status: 'idle' | 'running' | 'done' | 'error'; tiles: Tile[]; failures: number; dropped: number; ms: number; tokensIn: number; tokensOut: number; error: string }

const ROWS: { id: RowId; label: string }[] = [
  { id: 'spike', label: 'Spike (hand-written)' },
  { id: 'plan', label: 'Sonnet 5' },
  { id: 'patch', label: 'Haiku 4.5' },
]
const emptyRow = (): Row => ({ status: 'idle', tiles: [], failures: 0, dropped: 0, ms: 0, tokensIn: 0, tokensOut: 0, error: '' })
const rows = reactive<Record<string, Record<RowId, Row>>>(
  Object.fromEntries(EVAL_REQUESTS.map(r => [r.key, { spike: emptyRow(), plan: emptyRow(), patch: emptyRow() }])),
)

const { getLocalSetting } = useLocalSettings()
const apiKey = computed(() => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '')
const ready = ref(false)
const armed = ref(false)
const running = ref(false)
const copied = ref(false)
const catalog = shallowRef<EffectDef[]>([])
let renderer: TakeRenderer | null = null

function baseFor(id: string | null): GenBase | null {
  if (!id) return null
  const e = catalog.value.find(x => x.id === id)
  return e ? { name: e.name, source: e.source, params: e.params as GenBase['params'] } : null
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

onMounted(async () => {
  const [img, cat] = await Promise.all([loadImage('/house-styles/azure-bloom/thumb-2.webp'), fetchShaderFxCatalog()])
  catalog.value = cat.effects
  renderer = createBrowserTakeRenderer(img)
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]!.spike
    row.tiles = (SPIKE_TAKES[r.key] ?? []).map((take): Tile => {
      const err = renderer!.compile(take)
      if (err) return { take, thumbnail: '', flags: ['compile error'], compiled: false, calls: null, keep: false }
      const j = renderer!.judge(take)
      return { take, thumbnail: j.thumbnail, flags: j.flags, compiled: true, calls: null, keep: false }
    })
    row.status = 'done'
  }
  ready.value = true
})

function fill(row: Row, res: EngineResult) {
  row.tiles = res.takes.map(t => ({ take: t.take, thumbnail: t.thumbnail, flags: t.flags, compiled: true, calls: t.modelCalls, keep: false }))
  row.failures = res.failures.length
  row.dropped = res.dropped
  row.ms = res.ms
  row.tokensIn = res.usage.input_tokens
  row.tokensOut = res.usage.output_tokens
  row.status = 'done'
}

async function runTier(tier: 'plan' | 'patch') {
  const deps = { callModel: makeCallModel(apiKey.value, tier), review: makeReview(apiKey.value), renderer: renderer! }
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]![tier]
    row.status = 'running'
    row.error = ''
    try {
      fill(row, await generateTakes({ request: r.prompt, base: baseFor(r.base) }, deps))
    } catch (e) {
      row.status = 'error'
      row.error = String((e as Error)?.message ?? e)
    }
  }
}

async function run() {
  if (!armed.value) { armed.value = true; return }
  armed.value = false
  running.value = true
  try { await Promise.all([runTier('plan'), runTier('patch')]) } finally { running.value = false }
}

const tally = computed(() => Object.fromEntries(ROWS.map(({ id }) => {
  let keep = 0, total = 0, failures = 0
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]![id]
    total += row.tiles.length
    keep += row.tiles.filter(t => t.keep).length
    failures += row.failures
  }
  return [id, { keep, total, failures }]
})) as Record<RowId, { keep: number; total: number; failures: number }>)

async function copyResults() {
  const out = EVAL_REQUESTS.map(r => ({
    key: r.key, prompt: r.prompt, base: r.base,
    rows: Object.fromEntries(ROWS.map(({ id }) => {
      const row = rows[r.key]![id]
      return [id, {
        status: row.status, error: row.error, failures: row.failures, dropped: row.dropped,
        ms: row.ms, tokensIn: row.tokensIn, tokensOut: row.tokensOut,
        tiles: row.tiles.map(t => ({ name: t.take.name, keep: t.keep, flags: t.flags, calls: t.calls, params: t.take.params, body: t.take.body })),
      }]
    })),
  }))
  await navigator.clipboard.writeText(JSON.stringify(out, null, 2))
  copied.value = true
}
</script>

<template>
  <main class="eval">
    <header>
      <h1>Shader generation: engine run</h1>
      <p>The six requests from the spike. The first row of each is the hand-written spike; the others are the real engine. Click a tile to mark it a keeper.</p>
      <div class="bar">
        <button type="button" :disabled="!ready || running" @click="run">
          {{ running ? 'Running…' : armed ? 'Confirm: this calls the paid API' : 'Run Sonnet 5 and Haiku 4.5' }}
        </button>
        <span v-if="!apiKey" class="note">No key in Settings → AI, so the server's key is used if it has one.</span>
        <button type="button" @click="copyResults">{{ copied ? 'Copied' : 'Copy results' }}</button>
        <span v-for="r in ROWS" :key="r.id" class="tally">
          {{ r.label }}: {{ tally[r.id].keep }} of {{ tally[r.id].total }} kept<template v-if="r.id !== 'spike'"> · {{ tally[r.id].failures }} failed</template>
        </span>
      </div>
    </header>

    <section v-for="req in EVAL_REQUESTS" :key="req.key">
      <h2>“{{ req.prompt }}” <small>{{ req.base ? `from ${baseFor(req.base)?.name ?? req.base}` : 'from nothing' }}</small></h2>
      <div v-for="r in ROWS" :key="r.id" class="row" :data-row="r.id">
        <div class="rowhead">
          <strong>{{ r.label }}</strong>
          <span v-if="rows[req.key]![r.id].status === 'running'">Working…</span>
          <span v-else-if="rows[req.key]![r.id].status === 'error'" class="err">{{ rows[req.key]![r.id].error }}</span>
          <span v-else-if="r.id !== 'spike' && rows[req.key]![r.id].status === 'done'">
            {{ (rows[req.key]![r.id].ms / 1000).toFixed(1) }} s · {{ rows[req.key]![r.id].tokensIn }} in / {{ rows[req.key]![r.id].tokensOut }} out ·
            {{ rows[req.key]![r.id].failures }} failed · {{ rows[req.key]![r.id].dropped }} dropped by review
          </span>
        </div>
        <div class="tiles">
          <button
            v-for="(t, i) in rows[req.key]![r.id].tiles" :key="i" type="button" class="tile" :class="{ keep: t.keep }"
            data-tile :data-compiled="String(t.compiled)" :data-flags="t.flags.join(',')" @click="t.keep = !t.keep"
          >
            <img v-if="t.thumbnail" :src="t.thumbnail" :alt="t.take.name">
            <span v-else class="broken">Didn't compile</span>
            <span class="name">{{ t.take.name }}</span>
            <span class="meta">{{ t.flags.join(' · ') || 'Checks pass' }}<template v-if="t.calls"> · {{ t.calls }} call{{ t.calls > 1 ? 's' : '' }}</template></span>
          </button>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.eval { min-height: 100vh; background: #0e0f11; color: #ebe8e1; font: 14px/1.5 system-ui, sans-serif; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
header p { color: #8e8a83; margin: 0 0 12px; }
.bar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-bottom: 8px; }
.bar button { background: #1e1f23; color: inherit; border: 1px solid #34363c; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.bar button:disabled { opacity: .5; cursor: default; }
.note, .tally { color: #8e8a83; font-size: 12.5px; }
section { border-top: 1px solid #2a2c31; margin-top: 24px; padding-top: 16px; }
h2 { font-size: 17px; font-weight: 500; margin: 0 0 10px; }
h2 small { color: #8e8a83; font-weight: 400; font-size: 12.5px; }
.row { margin-bottom: 12px; }
.rowhead { display: flex; gap: 12px; font-size: 12.5px; color: #8e8a83; margin-bottom: 6px; }
.rowhead strong { color: #ebe8e1; font-weight: 500; min-width: 150px; }
.err { color: #e2645a; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.tile { display: grid; gap: 4px; text-align: left; background: #17181b; border: 1px solid #2a2c31; border-radius: 8px; padding: 6px; color: inherit; cursor: pointer; }
.tile.keep { border-color: #7fbf8a; box-shadow: 0 0 0 1px #7fbf8a; }
.tile img, .broken { width: 100%; aspect-ratio: 1; border-radius: 5px; display: grid; place-items: center; background: #000; color: #e2645a; font-size: 12px; }
.name { font-size: 13px; }
.meta { font-size: 11.5px; color: #8e8a83; }
</style>
```

- [ ] **Step 4: Run the E2E test**

Run: `npx playwright test tests/shader-gen-eval.spec.ts --project=chromium`
Expected: PASS. If `data-compiled="false"` shows up, the renderer adapter's source differs from what the spike rendered: compare `toEffectDef(take).source` with `SPIKE_PREFIX + take.body` and check the preamble and helpers.

- [ ] **Step 5: Look at the page yourself (real mouse)**

Open `/dev/shader-gen-eval` in the browser pane. Check that the spike rows show 24 thumbnails that look like the spike page (`docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/shader-takes-spike.html`), and that clicking a tile toggles its green keeper outline. **Do not press Run.**

- [ ] **Step 6: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- frontend/app/pages/dev/shader-gen-eval.vue frontend/tests/shader-gen-eval.spec.ts && git diff --cached --stat HEAD && git commit -q -m "feat(shadergen): /dev/shader-gen-eval — spike vs Sonnet vs Haiku" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- frontend/app/pages/dev/shader-gen-eval.vue frontend/tests/shader-gen-eval.spec.ts && git show --stat --oneline HEAD | head -6
```

---

### Task 9: The model run and the decision (needs Julien's OK)

**Files:**
- Create: `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.md`
- Modify: `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md` (§7.2, the "Model tiers" line)

**Interfaces:**
- Consumes: the `/dev/shader-gen-eval` page (Task 8).
- Produces: the decided code-writing tier, recorded in the spec for stage 5.

- [ ] **Step 1: Ask before spending**

Ask Julien in chat, and wait for a clear yes:

> "Ready to run the shader engine for real: the 6 spike requests × 4 takes on Sonnet 5 and on Haiku 4.5, with repairs as needed, plus 12 visual reviews on Sonnet 5. The page reports the tokens used for writing shaders (the 12 reviews are not counted). OK to run?"

- [ ] **Step 2: Run it**

Use the existing dev server. Open `/dev/shader-gen-eval` in the browser pane, press **Run Sonnet 5 and Haiku 4.5**, then **Confirm: this calls the paid API**. Wait until no row says "Working…".

- [ ] **Step 3: Julien judges**

Ask Julien to click the keepers in each model row. The spike rows can be judged too, for a baseline. Then press **Copy results** and save the clipboard to `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.json`.

- [ ] **Step 4: Write the results and apply the decision rule**

Create `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.md`, with one table filled from the JSON:

```markdown
# Shader engine run: 2026-09-23 stage 1

| | Spike | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| Keepers (Julien) | n / 24 | n / 24 | n / 24 |
| Takes that failed outright | – | n | n |
| Dropped by the visual review | – | n | n |
| Model calls per delivered take (avg) | – | x.x | x.x |
| Time per request (avg) | – | x.x s | x.x s |
| Tokens per request (avg, in / out) | – | n / n | n / n |

Both tiers run in parallel on one renderer, so each tier's time includes some of the other's rendering.

**Decision:** …
```

**Decision rule** (write down which case applied):
- Haiku writes the code if its keepers are within 2 of Sonnet's **and** its outright failures are at most Sonnet's + 2.
- Otherwise Sonnet writes the code, and Haiku stays for dial-only takes, as the spec assumes.

- [ ] **Step 5: Record the decision in the spec**

In `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md` §7.2, replace the line starting `- **Model tiers:** Sonnet 5 (`plan` tier) for writing code` with the measured decision. For example:

`- **Model tiers (measured 2026-09-23, see assets/…/engine-run-results.md):** <tier> writes the code; Haiku for dial-only takes. Latency: <x> s per four takes.`

- [ ] **Step 6: Commit** (controller)

```bash
cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.md docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.json docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md && git diff --cached --stat HEAD && git commit -q -m "docs(spec): shader engine run — measured results and model tier" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "HEAD moved: $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"; unset GIT_INDEX_FILE
```

Then, in a **separate** shell call:

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.md docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/engine-run-results.json docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md && git show --stat --oneline HEAD | head -6
```
