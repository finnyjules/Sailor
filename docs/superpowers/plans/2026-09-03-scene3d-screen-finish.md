# 3D Studio Screen finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every 3D Studio material except glass gains a **Screen** section — dots, lines, or cross-hatch anchored to the object's surface coordinates, sized by the lit shading, with red/blue misregistration and transparent or coloured gaps — so a sphere dissolves into a printed dot screen the way Carsten Gueth's do.

**Architecture:** One helper, `applyScreen(m, mat)`, runs at the end of the material factory and chains a GLSL injection onto whatever `onBeforeCompile` the material already has. It declares its own `vScrUv` varying (the `uv` attribute is always in three's vertex prefix) and replaces `#include <opaque_fragment>`, the one point every built-in material shares where `outgoingLight` exists. Every dial is a uniform updated in place; only screen off↔on and gap transparent↔colour rebuild. Controls, panel, agent words and motion targets derive from the shared control schema exactly like Surface relief does today.

**Tech Stack:** TypeScript, three.js 0.171 (`MeshStandardMaterial` / `MeshPhysicalMaterial` / `MeshPhongMaterial` / `MeshToonMaterial` / `MeshMatcapMaterial` / `MeshBasicMaterial` — all include `uv_pars_vertex`, `uv_vertex`, `uv_pars_fragment`, `opaque_fragment`), Vue 3 / Nuxt 4 (schema-drawn inspector), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-scene3d-screen-finish-design.md`.

## Global Constraints

- `SceneMaterial.screen?: ScreenSpec` is optional; absent = no screen; a doc without it round-trips byte-identically. `MaterialType` / `MATERIAL_TYPES` do not change.
- `ScreenSpec`: `pattern: 'none'|'dots'|'lines'|'cross'`, `density` 4..200 (default 48), `angle` 0..180 degrees (default 45), `contrast` 0.25..4 (default 1), `softness` 0..1 (default 0.15), `misregister` 0..1 (default 0), `invert?: boolean`, `gap: 'transparent'|'colour'` (default transparent), `gapColor?` (default `#ffffff`), `ink: 'lit'|'colour'` (default lit), `inkColor?` (default `#111111`).
- `MATERIAL_DEFAULTS` gains `screenDensity 48, screenAngle 45, screenContrast 1, screenSoftness 0.15, screenMisregister 0, screenGapColor '#ffffff', screenInkColor '#111111'`.
- Applies to every material type except `glass`; unlit shaderFill (MeshBasicMaterial) included.
- Injection points: vertex `#include <uv_pars_vertex>` (+ `varying vec2 vScrUv;`) and `#include <uv_vertex>` (+ `vScrUv = uv;`); fragment `#include <uv_pars_fragment>` (+ varying, uniforms, `scrCoverage`) and `#include <opaque_fragment>` (replaced by the screen body). Chains onto an existing `onBeforeCompile`; `customProgramCacheKey` = previous key + `|screen`.
- Transparent gaps: `m.transparent = true`, `m.alphaTest = 0.02`, `m.depthWrite = true`. Colour gaps leave the material opaque.
- Identity boundaries: screen off↔on and gap transparent↔colour only; everything else updates in place.
- Controls live in group `Material`, keys `object.material.screen.*`, gated `screenApplies` (editable material and not glass); dials are hidden panel-side when pattern is `none` (the Surface-relief precedent) so the agent can set pattern and density in one patch. Sliders animatable by default.
- Plain-language hints on every new control.
- Commit after every task; stage only the named files; never `git add -A`, never stash; every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commands run from `frontend/`. Unit tests: `npx vitest run <files>`. Typecheck: `npx vue-tsc --noEmit -p . 2>&1 | grep -E "<pattern>"; echo done` must print only `done` — the `timeout` binary does NOT exist on this machine, never prefix with it.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/scene3d/config.ts` | `ScreenSpec`, `SCREEN_PATTERNS/GAPS/INKS`, `screenOf(mat)`, defaults, parse. |
| `frontend/app/lib/scene3d/materials.ts` | GLSL consts, `applyScreen`, `screenKey` in `identityKey`, in-place update, `applyPhysical` keeps `transparent` for screen gaps. |
| `frontend/app/lib/scene3d/controls.ts` | Screen rows + gates; `agentControls.ts` gets the SCREEN paragraph. |
| `frontend/app/lib/scene3d/panelPresentation.ts` | `Material/Screen` card: order, keys, chrome, labels, read, panel gate. |
| `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` | `setMaterialControl` writes `screen.*` into the nested object. |
| `frontend/app/lib/scene3d/glb.ts` + `engine.ts` | `ensureUv(group)` spherical fallback for GLB meshes without UVs. |
| Tests | `scene3d-screen-config.unit.spec.ts` (new), `scene3d-screen-material.unit.spec.ts` (new), extend `scene3d-controls`, `scene3d-motion-targets`, `scene3d-panel-parity`, `scene3d-glb-uv.unit.spec.ts` (new). |

---

### Task 1: Config — `ScreenSpec`, defaults, resolver, parse

**Files:**
- Modify: `frontend/app/lib/scene3d/config.ts` (interface near `ReliefSpec` ~line 67; `SceneMaterial` after `relief?` ~line 154; `MATERIAL_DEFAULTS` after `reliefTiling` ~line 524; the material parse block after the relief block ~line 1055)
- Test: `frontend/tests/unit/scene3d-screen-config.unit.spec.ts` (new)

**Interfaces (produces):**
```ts
export type ScreenPattern = 'none' | 'dots' | 'lines' | 'cross'
export type ScreenGap = 'transparent' | 'colour'
export type ScreenInk = 'lit' | 'colour'
export const SCREEN_PATTERNS = ['none', 'dots', 'lines', 'cross'] as const
export const SCREEN_GAPS = ['transparent', 'colour'] as const
export const SCREEN_INKS = ['lit', 'colour'] as const
export interface ScreenSpec {
  pattern: ScreenPattern
  density: number; angle: number; contrast: number; softness: number; misregister: number
  invert?: boolean
  gap: ScreenGap; gapColor?: string
  ink: ScreenInk; inkColor?: string
}
/** Every field filled from MATERIAL_DEFAULTS; absent block → pattern 'none'. */
export function screenOf(mat: Pick<SceneMaterial, 'screen'>): Required<ScreenSpec>
```
`SceneMaterial.screen?: ScreenSpec`. Defaults in `MATERIAL_DEFAULTS` as listed in Global Constraints.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/scene3d-screen-config.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  createPrimitive, defaultDoc, parseDoc, serializeDoc, screenOf, MATERIAL_DEFAULTS, MATERIAL_TYPES,
  SCREEN_PATTERNS, SCREEN_GAPS, SCREEN_INKS, type SceneMaterial,
} from '~/lib/scene3d/config'

const withScreen = (screen: Partial<SceneMaterial['screen']>) => {
  const doc = defaultDoc()
  const o = createPrimitive('sphere', doc.objects)
  o.material.screen = screen as SceneMaterial['screen']
  doc.objects.push(o)
  return doc
}

describe('scene3d screen — config', () => {
  it('the material type list is untouched — a screen is a finish, not a type', () => {
    expect(MATERIAL_TYPES).toEqual(['standard', 'phong', 'toon', 'matcap', 'glass', 'fresnel', 'gradient', 'opalescent', 'image', 'shaderFill'])
    expect([...SCREEN_PATTERNS]).toEqual(['none', 'dots', 'lines', 'cross'])
    expect([...SCREEN_GAPS]).toEqual(['transparent', 'colour'])
    expect([...SCREEN_INKS]).toEqual(['lit', 'colour'])
  })

  it('a doc without a screen round-trips with no screen field at all', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
    expect((back.objects[0] as any).material.screen).toBeUndefined()
  })

  it('screenOf fills every field from MATERIAL_DEFAULTS and reads pattern none when absent', () => {
    const s = screenOf({})
    expect(s).toEqual({
      pattern: 'none', density: MATERIAL_DEFAULTS.screenDensity, angle: MATERIAL_DEFAULTS.screenAngle,
      contrast: MATERIAL_DEFAULTS.screenContrast, softness: MATERIAL_DEFAULTS.screenSoftness,
      misregister: MATERIAL_DEFAULTS.screenMisregister, invert: false,
      gap: 'transparent', gapColor: MATERIAL_DEFAULTS.screenGapColor, ink: 'lit', inkColor: MATERIAL_DEFAULTS.screenInkColor,
    })
    expect(MATERIAL_DEFAULTS.screenDensity).toBe(48)
    expect(MATERIAL_DEFAULTS.screenAngle).toBe(45)
    expect(MATERIAL_DEFAULTS.screenContrast).toBe(1)
    expect(MATERIAL_DEFAULTS.screenSoftness).toBe(0.15)
    expect(MATERIAL_DEFAULTS.screenMisregister).toBe(0)
    expect(MATERIAL_DEFAULTS.screenGapColor).toBe('#ffffff')
    expect(MATERIAL_DEFAULTS.screenInkColor).toBe('#111111')
  })

  it('a full screen block round-trips exactly', () => {
    const doc = withScreen({ pattern: 'dots', density: 60, angle: 30, contrast: 1.5, softness: 0.2, misregister: 0.4, invert: true, gap: 'colour', gapColor: '#ff2d95', ink: 'colour', inkColor: '#000000' })
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)
  })

  it('junk degrades field by field, never dropping the block', () => {
    const raw = JSON.parse(serializeDoc(withScreen({ pattern: 'dots' })))
    raw.objects[0].material.screen = { pattern: 'stipple', density: 'lots', angle: 999, contrast: -3, softness: 2, misregister: 7, gap: 'holes', ink: 'wax', gapColor: 12 }
    const s = parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!
    expect(s.pattern).toBe('none')
    expect(s.density).toBe(MATERIAL_DEFAULTS.screenDensity)
    expect(s.angle).toBe(180)        // clamped
    expect(s.contrast).toBe(0.25)    // clamped
    expect(s.softness).toBe(1)       // clamped
    expect(s.misregister).toBe(1)    // clamped
    expect(s.gap).toBe('transparent')
    expect(s.ink).toBe('lit')
    expect(s.gapColor).toBeUndefined()
  })

  it('density clamps to 4..200', () => {
    const raw = JSON.parse(serializeDoc(withScreen({ pattern: 'lines', density: 1000 })))
    expect(parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!.density).toBe(200)
    raw.objects[0].material.screen.density = 1
    expect(parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!.density).toBe(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-screen-config.unit.spec.ts`
Expected: FAIL — `screenOf`, `SCREEN_PATTERNS` are not exported.

- [ ] **Step 3: Edit `config.ts`**

Right after the `ReliefSpec` interface:

```ts
/** Print-style screen — dots / lines / cross-hatch anchored to the object's own UVs, sized by
 *  the LIT shading (bright = big dot). A finish on top of any material type except glass, not a
 *  type of its own: the colour underneath (gradient, opal, toon…) shows through as the ink.
 *  Absent = no screen. See materials.ts's applyScreen. */
export type ScreenPattern = 'none' | 'dots' | 'lines' | 'cross'
export type ScreenGap = 'transparent' | 'colour'
export type ScreenInk = 'lit' | 'colour'
export const SCREEN_PATTERNS = ['none', 'dots', 'lines', 'cross'] as const
export const SCREEN_GAPS = ['transparent', 'colour'] as const
export const SCREEN_INKS = ['lit', 'colour'] as const
export interface ScreenSpec {
  pattern: ScreenPattern
  /** Cells across one UV span (4..200). */
  density: number
  /** Degrees, 0..180. */
  angle: number
  /** Gamma on the coverage — how fast dots shrink into shadow (0.25..4). */
  contrast: number
  /** Edge blur, 0..1. */
  softness: number
  /** Red/blue grid offset in cells, 0..1. */
  misregister: number
  /** false: bright = big dot. true: dark = big dot. */
  invert?: boolean
  /** What shows between the dots. */
  gap: ScreenGap
  gapColor?: string
  /** Dot colour: the material's own lit colour, or one ink. */
  ink: ScreenInk
  inkColor?: string
}
```

In `SceneMaterial`, after `relief?: ReliefSpec`:

```ts
  /** Surface-anchored print screen. Absent = off. Never applied to `glass` (transmission +
   *  alpha gaps is out of scope). See ScreenSpec. */
  screen?: ScreenSpec
```

In `MATERIAL_DEFAULTS`, after `reliefTiling: 1,`:

```ts
  screenDensity: 48,
  screenAngle: 45,
  screenContrast: 1,
  screenSoftness: 0.15,
  screenMisregister: 0,
  screenGapColor: '#ffffff',
  screenInkColor: '#111111',
```

After `MATERIAL_DEFAULTS` (module level):

```ts
/** The screen block with every field filled — what materials.ts and the panel read. */
export function screenOf(mat: Pick<SceneMaterial, 'screen'>): Required<ScreenSpec> {
  const s = mat.screen
  return {
    pattern: s?.pattern ?? 'none',
    density: s?.density ?? MATERIAL_DEFAULTS.screenDensity,
    angle: s?.angle ?? MATERIAL_DEFAULTS.screenAngle,
    contrast: s?.contrast ?? MATERIAL_DEFAULTS.screenContrast,
    softness: s?.softness ?? MATERIAL_DEFAULTS.screenSoftness,
    misregister: s?.misregister ?? MATERIAL_DEFAULTS.screenMisregister,
    invert: s?.invert === true,
    gap: s?.gap ?? 'transparent',
    gapColor: s?.gapColor ?? MATERIAL_DEFAULTS.screenGapColor,
    ink: s?.ink ?? 'lit',
    inkColor: s?.inkColor ?? MATERIAL_DEFAULTS.screenInkColor,
  }
}
```

In the material parse block, right after the `if (m?.relief && …) { … }` block and before `if (typeof m?.normalImage === 'string')`:

```ts
    // Screen: same copy-when-present rule; a junk pattern degrades to 'none' and every
    // number clamps to its slider range so a hand-edited doc still loads.
    if (m?.screen && typeof m.screen === 'object') {
      const s = m.screen
      const clamp = (v: unknown, fb: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, num(v, fb)))
      const scr: ScreenSpec = {
        pattern: (SCREEN_PATTERNS as readonly string[]).includes(s.pattern) ? s.pattern : 'none',
        density: clamp(s.density, MATERIAL_DEFAULTS.screenDensity, 4, 200),
        angle: clamp(s.angle, MATERIAL_DEFAULTS.screenAngle, 0, 180),
        contrast: clamp(s.contrast, MATERIAL_DEFAULTS.screenContrast, 0.25, 4),
        softness: clamp(s.softness, MATERIAL_DEFAULTS.screenSoftness, 0, 1),
        misregister: clamp(s.misregister, MATERIAL_DEFAULTS.screenMisregister, 0, 1),
        gap: (SCREEN_GAPS as readonly string[]).includes(s.gap) ? s.gap : 'transparent',
        ink: (SCREEN_INKS as readonly string[]).includes(s.ink) ? s.ink : 'lit',
      }
      if (typeof s.invert === 'boolean') scr.invert = s.invert
      if (typeof s.gapColor === 'string') scr.gapColor = s.gapColor
      if (typeof s.inkColor === 'string') scr.inkColor = s.inkColor
      out.screen = scr
    }
```

(`num` is the local helper already defined in that function: `const num = (v: any, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-screen-config.unit.spec.ts tests/unit/scene3d-config.unit.spec.ts tests/unit/scene3d-opalescent-config.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/config.ts tests/unit/scene3d-screen-config.unit.spec.ts && git commit -m "feat(scene3d): ScreenSpec on SceneMaterial — pattern/density/angle/contrast/softness/misregister/gap/ink with defaults, resolver and tolerant parse

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Material factory — `applyScreen`, identity, in-place update

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` (import `screenOf`, `type ScreenSpec` from `./config`; new GLSL consts next to `OPAL_FRAG_BODY` ~line 730; `applyScreen` after `applyTextureSet`; call in `materialFor`'s tail after `applyTextureSet(m, mat)`; `screenKey` folded into `identityKey`; in-place block at the top of `updateMaterial`; `applyPhysical` line `p.transparent = p.opacity < 1`)
- Test: `frontend/tests/unit/scene3d-screen-material.unit.spec.ts` (new)

**Interfaces:**
- Consumes: `screenOf(mat)` (Task 1).
- Produces: `export function applyScreen(m: THREE.Material, mat: SceneMaterial): void`; `m.userData.screenUniforms: Record<string, { value: unknown }>` when a screen is on; `m.userData.screenTransparent: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/scene3d-screen-material.unit.spec.ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial, disposeMaterial } from '~/lib/scene3d/materials'
import { MATERIAL_DEFAULTS, type SceneMaterial, type ScreenSpec } from '~/lib/scene3d/config'

// Headless like the opalescent suite: materials build without a GL context and
// onBeforeCompile runs against a stub carrying the four include placeholders the screen targets.
const base = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'standard', color: '#9aa3af', roughness: 0.6, metalness: 0, ...patch })
const dots = (over: Partial<ScreenSpec> = {}): ScreenSpec =>
  ({ pattern: 'dots', density: 48, angle: 45, contrast: 1, softness: 0.15, misregister: 0, gap: 'transparent', ink: 'lit', ...over })

function compile(m: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <uv_pars_vertex>\n#include <begin_vertex>\n#include <uv_vertex>',
    fragmentShader: '#include <common>\n#include <uv_pars_fragment>\nvec4 diffuseColor;\n#include <color_fragment>\n#include <emissivemap_fragment>\nvec3 outgoingLight;\n#include <opaque_fragment>',
  }
  ;(m as any).onBeforeCompile?.(shader, {} as any)
  return shader
}

describe('screen finish — build', () => {
  it('does nothing when the screen is absent or pattern is none', () => {
    for (const m of [materialFor(base()), materialFor(base({ screen: dots({ pattern: 'none' }) }))]) {
      expect(m.userData.screenUniforms).toBeUndefined()
      expect(compile(m).fragmentShader).toContain('#include <opaque_fragment>')
      expect(m.transparent).toBe(false)
      disposeMaterial(m)
    }
  })

  it('injects its own varying at the uv chunks and replaces opaque_fragment', () => {
    const m = materialFor(base({ screen: dots() }))
    const sh = compile(m)
    expect(sh.vertexShader).toContain('varying vec2 vScrUv;')
    expect(sh.vertexShader).toMatch(/#include <uv_vertex>[\s\S]*vScrUv = uv;/)
    expect(sh.fragmentShader).toContain('scrCoverage')
    expect(sh.fragmentShader).not.toContain('#include <opaque_fragment>')
    expect(sh.fragmentShader).toContain('gl_FragColor')
    expect(sh.uniforms.uScrDensity!.value).toBe(48)
    disposeMaterial(m)
  })

  it('wires every dial into a uniform', () => {
    const m = materialFor(base({ screen: dots({ pattern: 'cross', density: 90, angle: 30, contrast: 2, softness: 0.4, misregister: 0.5, invert: true, gap: 'colour', gapColor: '#ff2d95', ink: 'colour', inkColor: '#000000' }) }))
    const u = m.userData.screenUniforms as Record<string, { value: any }>
    expect(u.uScrPattern.value).toBe(2)
    expect(u.uScrDensity.value).toBe(90)
    expect(u.uScrAngle.value).toBeCloseTo(Math.PI / 6, 6)
    expect(u.uScrContrast.value).toBe(2)
    expect(u.uScrSoft.value).toBe(0.4)
    expect(u.uScrMisreg.value).toBe(0.5)
    expect(u.uScrInvert.value).toBe(1)
    expect(u.uScrGapMode.value).toBe(1)
    expect((u.uScrGapColor.value as THREE.Color).getHexString()).toBe('ff2d95')
    expect(u.uScrInkMode.value).toBe(1)
    expect((u.uScrInkColor.value as THREE.Color).getHexString()).toBe('000000')
    disposeMaterial(m)
  })

  it('transparent gaps flip the material transparent with an alpha cutoff and depth writes kept', () => {
    const m = materialFor(base({ screen: dots({ gap: 'transparent' }) }))
    expect(m.transparent).toBe(true)
    expect(m.alphaTest).toBeCloseTo(0.02)
    expect(m.depthWrite).toBe(true)
    expect(m.userData.screenTransparent).toBe(true)
    const c = materialFor(base({ screen: dots({ gap: 'colour' }) }))
    expect(c.transparent).toBe(false)
    disposeMaterial(m); disposeMaterial(c)
  })

  it('chains onto a material that already injects (gradient) — both bodies present', () => {
    const m = materialFor(base({ type: 'gradient', gradientB: '#123456', screen: dots() }))
    const sh = compile(m)
    expect(sh.fragmentShader).toContain('uRamp')        // gradient body still there
    expect(sh.fragmentShader).toContain('scrCoverage')  // screen body added
    expect(String((m as any).customProgramCacheKey())).toContain('|screen')
    disposeMaterial(m)
  })

  it('applies to toon, matcap, phong, opalescent, image, shaderFill (unlit too) — and never to glass', () => {
    for (const patch of [
      { type: 'toon' as const }, { type: 'matcap' as const }, { type: 'phong' as const }, { type: 'opalescent' as const },
      { type: 'image' as const, image: 'a.png' }, { type: 'shaderFill' as const, unlit: true },
    ]) {
      const m = materialFor(base({ ...patch, screen: dots() }))
      expect(m.userData.screenUniforms, patch.type).toBeDefined()
      disposeMaterial(m)
    }
    const g = materialFor(base({ type: 'glass', screen: dots() }))
    expect(g.userData.screenUniforms).toBeUndefined()
    disposeMaterial(g)
  })
})

describe('screen finish — identity and in-place update', () => {
  it('off→on, on→off and gap transparent↔colour force a rebuild; dials update in place', () => {
    const m = materialFor(base({ screen: dots() }))
    expect(updateMaterial(m, base())).toBe(false)                                   // on→off
    expect(updateMaterial(m, base({ screen: dots({ gap: 'colour' }) }))).toBe(false) // gap boundary
    expect(updateMaterial(m, base({ screen: dots({ pattern: 'lines', density: 120, angle: 90, contrast: 3, softness: 0.5, misregister: 0.8, invert: true, ink: 'colour', inkColor: '#ff0000' }) }))).toBe(true)
    const u = m.userData.screenUniforms as Record<string, { value: any }>
    expect(u.uScrPattern.value).toBe(1)
    expect(u.uScrDensity.value).toBe(120)
    expect(u.uScrAngle.value).toBeCloseTo(Math.PI / 2, 6)
    expect(u.uScrContrast.value).toBe(3)
    expect(u.uScrSoft.value).toBe(0.5)
    expect(u.uScrMisreg.value).toBe(0.8)
    expect(u.uScrInvert.value).toBe(1)
    expect(u.uScrInkMode.value).toBe(1)
    expect((u.uScrInkColor.value as THREE.Color).getHexString()).toBe('ff0000')
    disposeMaterial(m)
    const off = materialFor(base())
    expect(updateMaterial(off, base({ screen: dots() }))).toBe(false)              // off→on
    disposeMaterial(off)
  })

  it('an unrelated in-place update on a standard material keeps transparent gaps transparent', () => {
    const m = materialFor(base({ screen: dots() }))
    expect(updateMaterial(m, base({ roughness: 0.1, screen: dots() }))).toBe(true)
    expect(m.transparent).toBe(true) // applyPhysical must not reset it to opacity < 1
    disposeMaterial(m)
  })

  it('a material without a screen is byte-identical to before: no uniforms, no flags, same identity key', () => {
    const a = materialFor(base()), b = materialFor(base({ screen: dots({ pattern: 'none' }) }))
    expect(a.userData.identity).toBe(b.userData.identity)
    expect(a.transparent).toBe(false); expect(b.transparent).toBe(false)
    disposeMaterial(a); disposeMaterial(b)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-screen-material.unit.spec.ts`
Expected: FAIL — `screenUniforms` undefined for a dots screen.

- [ ] **Step 3: Add the GLSL constants** (after `OPAL_FRAG_BODY`)

```ts
// Screen finish: a print-style dot/line/cross screen anchored to the mesh's own UVs, sized by
// the LIT result. Injected AFTER lighting at <opaque_fragment> — the one chunk every built-in
// material shares where `outgoingLight` and `diffuseColor.a` both exist — so it composes with
// gradient/fresnel/opal (which inject at color_fragment/emissivemap_fragment) and with toon,
// matcap and basic. Reads the `uv` attribute through its OWN varying: three's vertex prefix
// always declares `attribute vec2 uv;`, so this never depends on USE_UV or on a texture being
// bound. Kinds (pattern/gap/ink) are uniforms so switching them never recompiles.
const SCREEN_VERT_PARS = /* glsl */ `#include <uv_pars_vertex>
varying vec2 vScrUv;`
const SCREEN_VERT_BODY = /* glsl */ `#include <uv_vertex>
vScrUv = uv;`
const SCREEN_FRAG_PARS = /* glsl */ `#include <uv_pars_fragment>
varying vec2 vScrUv;
uniform float uScrPattern; uniform float uScrDensity; uniform float uScrAngle; uniform float uScrContrast;
uniform float uScrSoft; uniform float uScrMisreg; uniform float uScrInvert;
uniform float uScrGapMode; uniform vec3 uScrGapColor; uniform float uScrInkMode; uniform vec3 uScrInkColor;
// Coverage 0..1 of ink at grid position p for brightness lum. Dot AREA follows lum, so a
// half-bright cell is half covered; lines/cross use lum as the half-width.
float scrCoverage(vec2 p, float lum) {
  vec2 cell = fract(p) - 0.5;
  float soft = uScrSoft * 0.25 + fwidth(p.x) * 0.75;
  if (uScrPattern < 0.5) {
    float r = sqrt(lum) * 0.7071;
    return 1.0 - smoothstep(r - soft, r + soft, length(cell));
  }
  float hw = lum * 0.5;
  float ly = 1.0 - smoothstep(hw - soft, hw + soft, abs(cell.y));
  if (uScrPattern < 1.5) return ly;
  float lx = 1.0 - smoothstep(hw - soft, hw + soft, abs(cell.x));
  return max(lx, ly);
}`
// Replaces <opaque_fragment> outright (its OPAQUE clamp is reproduced; the transmission alpha
// branch is not — glass never gets a screen).
const SCREEN_FRAG_BODY = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
{
  float c = cos(uScrAngle), s = sin(uScrAngle);
  vec2 p = mat2(c, -s, s, c) * vScrUv * uScrDensity;
  float lum = clamp(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  lum = pow(lum, uScrContrast);
  if (uScrInvert > 0.5) lum = 1.0 - lum;
  float shift = uScrMisreg * 0.35;
  vec3 cov = vec3(scrCoverage(p + vec2(shift, 0.0), lum), scrCoverage(p, lum), scrCoverage(p - vec2(shift, 0.0), lum));
  vec3 ink = uScrInkMode < 0.5 ? outgoingLight : uScrInkColor;
  if (uScrGapMode < 0.5) {
    float a = max(cov.r, max(cov.g, cov.b));
    gl_FragColor = vec4(ink * cov / max(a, 1e-4), a * diffuseColor.a);
  } else {
    gl_FragColor = vec4(mix(uScrGapColor, ink, cov), diffuseColor.a);
  }
}`
const SCREEN_PATTERN_INDEX: Record<string, number> = { dots: 0, lines: 1, cross: 2 }
```

- [ ] **Step 4: Add `applyScreen` and the uniform writer** (after `applyTextureSet`)

```ts
/** Write the doc's screen dials into an existing material's screen uniforms (in place). */
function writeScreenUniforms(u: Record<string, { value: unknown }>, s: ReturnType<typeof screenOf>): void {
  u.uScrPattern!.value = SCREEN_PATTERN_INDEX[s.pattern] ?? 0
  u.uScrDensity!.value = s.density
  u.uScrAngle!.value = (s.angle * Math.PI) / 180
  u.uScrContrast!.value = s.contrast
  u.uScrSoft!.value = s.softness
  u.uScrMisreg!.value = s.misregister
  u.uScrInvert!.value = s.invert ? 1 : 0
  u.uScrGapMode!.value = s.gap === 'colour' ? 1 : 0
  ;(u.uScrGapColor!.value as THREE.Color).set(stripAlpha(s.gapColor))
  u.uScrInkMode!.value = s.ink === 'colour' ? 1 : 0
  ;(u.uScrInkColor!.value as THREE.Color).set(stripAlpha(s.inkColor))
}

/** The screen finish: chains a post-lighting screen onto whatever `onBeforeCompile` the
 *  material already carries. No-op for glass and for `pattern: 'none'` (so a screen-less
 *  material is byte-identical to before this feature existed). */
export function applyScreen(m: THREE.Material, mat: SceneMaterial): void {
  if (mat.type === 'glass') return
  const s = screenOf(mat)
  if (s.pattern === 'none') return
  const u: Record<string, { value: unknown }> = {
    uScrPattern: { value: 0 }, uScrDensity: { value: 0 }, uScrAngle: { value: 0 }, uScrContrast: { value: 1 },
    uScrSoft: { value: 0 }, uScrMisreg: { value: 0 }, uScrInvert: { value: 0 },
    uScrGapMode: { value: 0 }, uScrGapColor: { value: new THREE.Color('#ffffff') },
    uScrInkMode: { value: 0 }, uScrInkColor: { value: new THREE.Color('#111111') },
  }
  writeScreenUniforms(u, s)
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', SCREEN_VERT_PARS)
      .replace('#include <uv_vertex>', SCREEN_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <uv_pars_fragment>', SCREEN_FRAG_PARS)
      .replace('#include <opaque_fragment>', SCREEN_FRAG_BODY)
  }
  const prevKey = m.customProgramCacheKey.bind(m)
  m.customProgramCacheKey = () => `${prevKey()}|screen`
  m.userData.screenUniforms = u
  // Transparent gaps: alpha in the gaps, depth writes kept so the dots still occlude, a small
  // cutoff so fully-open gaps don't write depth. Colour gaps stay opaque.
  m.userData.screenTransparent = s.gap === 'transparent'
  if (m.userData.screenTransparent) { m.transparent = true; m.alphaTest = 0.02; m.depthWrite = true }
}
```

`stripAlpha` is already imported in this module. `m.onBeforeCompile`'s default on `THREE.Material` is a no-op function, so `prev.call` is always safe.

- [ ] **Step 5: Wire it into build, identity, update, and `applyPhysical`**

In `materialFor`'s tail, after `applyTextureSet(m, mat)`:

```ts
  applyScreen(m, mat)
```

Add next to `reliefKey`:

```ts
/** The two screen boundaries that need a rebuild: off↔on (the injection exists or not) and the
 *  gap mode (it flips `transparent`, which moves the material between render lists). Every
 *  other screen dial is a uniform written in place by updateMaterial. */
function screenKey(mat: SceneMaterial): string {
  if (mat.type === 'glass') return '|scr:-'
  const s = screenOf(mat)
  return s.pattern === 'none' ? '|scr:-' : `|scr:${s.gap === 'transparent' ? 't' : 'c'}`
}
```

and change `identityKey` to `return baseIdentityKey(mat) + reliefKey(mat) + screenKey(mat)`.

At the top of `updateMaterial`, right after the identity guard line (`if (m.userData.matType !== mat.type || m.userData.identity !== identityKey(mat)) return false`):

```ts
  // Screen dials update in place (the identity guard above already forced a rebuild for the
  // two boundaries that need one).
  const su = m.userData.screenUniforms as Record<string, { value: unknown }> | undefined
  if (su) writeScreenUniforms(su, screenOf(mat))
```

In `applyPhysical`, change `p.transparent = p.opacity < 1` to:

```ts
  // A screen with transparent gaps owns `transparent` too — an unrelated slider drag must not
  // flip it back to opaque (see applyScreen).
  p.transparent = p.opacity < 1 || p.userData.screenTransparent === true
```

Import `screenOf` in the `./config` import list.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-screen-material.unit.spec.ts tests/unit/scene3d-opalescent-material.unit.spec.ts tests/unit/scene3d-relief-material.unit.spec.ts tests/unit/scene3d-materials*.unit.spec.ts`
Expected: PASS. Then typecheck: `npx vue-tsc --noEmit -p . 2>&1 | grep -E "scene3d/(materials|config)"; echo done` → only `done`.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add app/lib/scene3d/materials.ts tests/unit/scene3d-screen-material.unit.spec.ts && git commit -m "feat(scene3d): screen finish material helper — UV-anchored dot/line/cross screen chained after lighting on every material but glass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Controls, agent words, motion targets

**Files:**
- Modify: `frontend/app/lib/scene3d/controls.ts` (imports; gates next to `reliefApplies`; rows after the relief `invert` switch ~line 478), `frontend/app/lib/scene3d/agentControls.ts` (`SCENE_GUIDANCE`, after the SURFACE TEXTURES worked example)
- Test: `frontend/tests/unit/scene3d-controls.unit.spec.ts`, `frontend/tests/unit/scene3d-motion-targets.unit.spec.ts`, `frontend/tests/unit/scene3d-agent-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `SCREEN_PATTERNS`, `SCREEN_GAPS`, `SCREEN_INKS`, `MATERIAL_DEFAULTS.screen*` (Task 1).
- Produces: eleven controls keyed `object.material.screen.{pattern,density,angle,contrast,softness,misregister,invert,gap,gapColor,ink,inkColor}`, group `Material`.

- [ ] **Step 1: Write the failing tests**

In `scene3d-controls.unit.spec.ts`, add to `MATERIAL_DEFAULT_KEYS`:

```ts
    'object.material.screen.density': 'screenDensity',
    'object.material.screen.angle': 'screenAngle',
    'object.material.screen.contrast': 'screenContrast',
    'object.material.screen.softness': 'screenSoftness',
    'object.material.screen.misregister': 'screenMisregister',
```

and a new `describe` at the end of the file:

```ts
describe('screen finish controls', () => {
  const keysFor = (type: MaterialType) => {
    const doc = defaultDoc()
    const prim = createPrimitive('sphere', [])
    prim.material.type = type
    return visibleSceneControls(doc, prim).map((c) => c.key)
  }
  it('offers the screen rows on every material type except glass', () => {
    for (const type of MATERIAL_TYPES) {
      const keys = keysFor(type)
      const has = keys.includes('object.material.screen.pattern')
      expect(has, type).toBe(type !== 'glass')
      if (has) {
        for (const k of ['density', 'angle', 'contrast', 'softness', 'misregister', 'invert', 'gap', 'gapColor', 'ink', 'inkColor']) {
          expect(keys, `${type} ${k}`).toContain(`object.material.screen.${k}`)
        }
      }
    }
  })
  it('the pattern select lists none/dots/lines/cross with plain labels', () => {
    const c = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.pattern') as any
    expect(c.options).toEqual(['none', 'dots', 'lines', 'cross'])
    expect(c.optionLabels).toEqual(['None', 'Dots', 'Lines', 'Cross'])
  })
  it('every screen row has a plain-language hint (except the colour rows and the switch)', () => {
    for (const c of SCENE_CONTROLS.filter((c) => c.key.startsWith('object.material.screen.'))) {
      if (c.kind === 'color' || c.kind === 'switch') continue
      expect((c as any).hint, c.key).toBeTruthy()
    }
  })
  it('gap and ink colours show only when their mode is colour', () => {
    const gap = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.gapColor') as any
    expect(gap.showIf).toEqual({ key: 'object.material.screen.gap', equals: 'colour' })
    const ink = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.inkColor') as any
    expect(ink.showIf).toEqual({ key: 'object.material.screen.ink', equals: 'colour' })
  })
})
```

(`MaterialType`, `MATERIAL_TYPES`, `createPrimitive`, `defaultDoc`, `visibleSceneControls`, `SCENE_CONTROLS` — add whichever of these the spec does not already import from `~/lib/scene3d/config` / `~/lib/scene3d/controls`.)

In `scene3d-motion-targets.unit.spec.ts`, next to `RELIEF`:

```ts
  const SCREEN = ['material.screen.angle', 'material.screen.contrast', 'material.screen.density', 'material.screen.misregister', 'material.screen.softness']
```

and update the per-type table: every row except `glass` gains `...SCREEN`:

```ts
    ['standard', [...PBR, ...PHYSICAL, ...RELIEF, ...TEXTURE, ...SCREEN]],
    ['glass', [...PBR, ...PHYSICAL, ...RELIEF, ...TEXTURE]],
    ['phong', ['material.shininess', ...RELIEF, ...SCREEN]],
    ['toon', [...RELIEF, ...SCREEN]],
    ['matcap', [...RELIEF, ...SCREEN]],
    ['fresnel', [...RELIEF, ...SCREEN]],
    ['gradient', [...RELIEF, ...SCREEN]],
    ['image', [...PBR, ...RELIEF, ...SCREEN]],
    ['shaderFill', [...PBR, ...RELIEF, ...SCREEN]],
    ['opalescent', [
      ...PBR, ...COAT, ...RELIEF, ...TEXTURE, ...SCREEN,
      'material.opalAngleMix', 'material.opalFlowSpeed', 'material.opalFrequency',
      'material.opalHueShift', 'material.opalStrength',
    ]],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts`
Expected: FAIL — the MATERIAL_DEFAULT_KEYS ↔ slider set mismatch and missing screen keys.

- [ ] **Step 3: Edit `controls.ts`**

Import `SCREEN_PATTERNS, SCREEN_GAPS, SCREEN_INKS` from `./config` (they are value exports).

Gate, next to `reliefApplies`:

```ts
// The screen finish sits after the per-type chain like relief, on every branch except glass
// (transmission + alpha gaps is out of scope — see ScreenSpec). Dials stay in the schema
// whatever the pattern is, so the agent can set pattern AND density in one patch; the panel
// hides them while the pattern is none (panelPresentation's panelGate, the relief precedent).
const screenApplies = (doc: SceneDoc, obj?: SceneObject): boolean =>
  isEditableMaterial(doc, obj) && materialTypeOf(obj) !== 'glass'
```

Rows, after the relief `invert` switch entry:

```ts
  // Screen finish — print-style dots/lines/cross anchored to the surface, sized by the lit shading.
  select('object.material.screen.pattern', 'Screen', [...SCREEN_PATTERNS], 'none', 'Material',
    'Print-style dots that wrap the object and shrink in shadow',
    { when: screenApplies, optionLabels: ['None', 'Dots', 'Lines', 'Cross'] }),
  slider('object.material.screen.density', 'Screen density', 4, 200, 1, 'Material', MATERIAL_DEFAULTS.screenDensity,
    'How many dots across the surface', { when: screenApplies }),
  slider('object.material.screen.angle', 'Screen angle', 0, 180, 1, 'Material', MATERIAL_DEFAULTS.screenAngle,
    'Rotates the dot grid', { when: screenApplies }),
  slider('object.material.screen.contrast', 'Screen contrast', 0.25, 4, 0.05, 'Material', MATERIAL_DEFAULTS.screenContrast,
    'How fast dots shrink into shadow', { when: screenApplies }),
  slider('object.material.screen.softness', 'Screen softness', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.screenSoftness,
    'Edge blur on each dot', { when: screenApplies }),
  slider('object.material.screen.misregister', 'Misregister', 0, 1, 0.01, 'Material', MATERIAL_DEFAULTS.screenMisregister,
    'Offsets red and blue so edges fringe like a misprint', { when: screenApplies }),
  {
    key: 'object.material.screen.invert', label: 'Invert screen', kind: 'switch', default: false, group: 'Material',
    hint: 'Dark areas get the big dots instead of bright ones', when: screenApplies, agent: false,
  } as SceneControl,
  select('object.material.screen.gap', 'Screen gaps', [...SCREEN_GAPS], 'transparent', 'Material',
    'What shows between the dots — the background, or one colour',
    { when: screenApplies, optionLabels: ['Transparent', 'Colour'] }),
  color('object.material.screen.gapColor', 'Gap colour', MATERIAL_DEFAULTS.screenGapColor, 'Material',
    { when: screenApplies, showIf: { key: 'object.material.screen.gap', equals: 'colour' } }),
  select('object.material.screen.ink', 'Screen ink', [...SCREEN_INKS], 'lit', 'Material',
    "Dot colour: the material's own shading, or one ink",
    { when: screenApplies, optionLabels: ['Lit colour', 'Colour'] }),
  color('object.material.screen.inkColor', 'Ink colour', MATERIAL_DEFAULTS.screenInkColor, 'Material',
    { when: screenApplies, showIf: { key: 'object.material.screen.ink', equals: 'colour' } }),
```

- [ ] **Step 4: Edit `agentControls.ts`** — append to `SCENE_GUIDANCE` after the "a wooden box" worked example:

```
SCREEN FINISH: \`object.material.screen.pattern\` ('dots' / 'lines' / 'cross') lays a print-style screen over ANY material except glass — the dots wrap the object's surface and shrink into its shadows, so the shading becomes dot density. "halftone", "dot screen", "print dots", "engraved lines", "risograph sphere", "die doing", "dots that wrap the object", "dissolves into the background" all mean this. Pair it with \`screen.density\` (40–80 reads as print), \`screen.misregister\` (0.3–0.6 gives the red/blue misprint fringe) and a \`gradient\` or \`opalescent\` material underneath for colour; gaps are transparent by default so the background shows through — set \`screen.gap\` = 'colour' + \`screen.gapColor\` for paper. Contrast with the post-stack \`post.dotScreen\`, which screens the WHOLE picture flat: reach for \`screen\` when the dots should follow the form.
WORKED EXAMPLE — "a pink-to-blue dotted sphere dissolving into magenta": {"primitive":"sphere", "object.material.type":"gradient", "object.material.gradientStops":[{"pos":0,"color":"#ff7ab6"},{"pos":1,"color":"#3b6bff"}], "object.material.screen.pattern":"dots", "object.material.screen.density":60, "object.material.screen.misregister":0.4}.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-tune-macro.unit.spec.ts tests/unit/scene3d-opalescent-controls.unit.spec.ts`
Expected: PASS. Typecheck grep `scene3d/(controls|agentControls)` → only `done`.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/scene3d/controls.ts app/lib/scene3d/agentControls.ts tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-motion-targets.unit.spec.ts && git commit -m "feat(scene3d): Screen controls on every material but glass (pattern, density, angle, contrast, softness, misregister, invert, gaps, ink) + agent recipe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Inspector — the Screen card, nested read/write

**Files:**
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (`SCENE_PANEL_ORDER`, `scenePanelChrome`, `materialField`, `SUB_CARDS`, `OVERRIDE`, `panelGate`), `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (`setMaterialControl`)
- Test: `frontend/tests/unit/scene3d-panel-parity.unit.spec.ts`

**Interfaces:**
- Consumes: the eleven controls (Task 3), `screenOf` (Task 1).
- Produces: a `Material/Screen` card after `Material/Surface relief`; `setMaterialControl('screen.<sub>', v)` writes `mat.screen = { ...screenOf(mat), [sub]: v }`.

- [ ] **Step 1: Write the failing tests**

In `scene3d-panel-parity.unit.spec.ts`:

Add to the `ROWS` map (after the relief rows):

```ts
  // <details> Screen — collapsed to its pattern row until a pattern is picked
  [`${M}screen.pattern`]: { label: 'Pattern', kind: 'select', options: ['none', 'dots', 'lines', 'cross'], optionLabels: ['None', 'Dots', 'Lines', 'Cross'] },
  [`${M}screen.density`]: { label: 'Density', kind: 'slider', min: 4, max: 200, step: 1, hint: 'How many dots across the surface' },
  [`${M}screen.angle`]: { label: 'Angle', kind: 'slider', min: 0, max: 180, step: 1, hint: 'Rotates the dot grid' },
  [`${M}screen.contrast`]: { label: 'Contrast', kind: 'slider', min: 0.25, max: 4, step: 0.05, hint: 'How fast dots shrink into shadow' },
  [`${M}screen.softness`]: { label: 'Softness', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Edge blur on each dot' },
  [`${M}screen.misregister`]: { label: 'Misregister', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Offsets red and blue so edges fringe like a misprint' },
  [`${M}screen.invert`]: { label: 'Invert', kind: 'switch' },
  [`${M}screen.gap`]: { label: 'Gaps', kind: 'select', options: ['transparent', 'colour'], optionLabels: ['Transparent', 'Colour'] },
  [`${M}screen.gapColor`]: { label: 'Gap colour', kind: 'color' },
  [`${M}screen.ink`]: { label: 'Ink', kind: 'select', options: ['lit', 'colour'], optionLabels: ['Lit colour', 'Colour'] },
  [`${M}screen.inkColor`]: { label: 'Ink colour', kind: 'color' },
```

Add `const SCREEN_OFF = [\`${M}screen.pattern\`]` next to `RELIEF_OFF`, and in `MATERIAL_SCENARIO` give every type EXCEPT `glass` a new last card `Screen: SCREEN_OFF` (after `'Surface relief': RELIEF_OFF`).

Add a new describe after the Surface relief one:

```ts
describe('Scene3D panel parity — Screen', () => {
  const sphereWith = (screen: Record<string, unknown>) => {
    const doc = defaultDoc()
    const o = createPrimitive('sphere', doc.objects)
    o.material.screen = screen as any
    doc.objects.push(o)
    return { doc, o }
  }
  it('a picked pattern reveals the dials, in order, with the colour rows following their mode', () => {
    const { doc, o } = sphereWith({ pattern: 'dots' })
    const card = designCards(doc, o).find((s) => s.title === 'Screen')!
    expect(card.keys).toEqual([
      `${M}screen.pattern`, `${M}screen.density`, `${M}screen.angle`, `${M}screen.contrast`, `${M}screen.softness`,
      `${M}screen.misregister`, `${M}screen.invert`, `${M}screen.gap`, `${M}screen.ink`,
    ])
    const { doc: d2, o: o2 } = sphereWith({ pattern: 'dots', gap: 'colour', ink: 'colour' })
    const keys2 = designCards(d2, o2).find((s) => s.title === 'Screen')!.keys
    expect(keys2).toContain(`${M}screen.gapColor`)
    expect(keys2).toContain(`${M}screen.inkColor`)
    expect(keys2.indexOf(`${M}screen.gapColor`)).toBe(keys2.indexOf(`${M}screen.gap`) + 1)
  })
  it('reads nested screen values off the document with defaults for absent fields', () => {
    const { doc, o } = sphereWith({ pattern: 'lines', density: 90 })
    expect(readSceneControl(doc, o, `${M}screen.pattern`)).toBe('lines')
    expect(readSceneControl(doc, o, `${M}screen.density`)).toBe(90)
    expect(readSceneControl(doc, o, `${M}screen.angle`)).toBe(45)
    expect(readSceneControl(doc, o, `${M}screen.gap`)).toBe('transparent')
    const plain = createPrimitive('box', [])
    expect(readSceneControl(defaultDoc(), plain, `${M}screen.pattern`)).toBe('none')
  })
  it('glass draws no Screen card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('sphere', doc.objects)
    o.material.type = 'glass'
    doc.objects.push(o)
    expect(designCards(doc, o).map((s) => s.title)).not.toContain('Screen')
  })
  it('the Screen card starts collapsed', () => {
    expect(scenePanelChrome('standard').Screen).toEqual({ open: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-panel-parity.unit.spec.ts`
Expected: FAIL — no `Screen` card; screen rows land in the main Material card.

- [ ] **Step 3: Edit `panelPresentation.ts`**

`SCENE_PANEL_ORDER`: add `'Material/Screen',` right after `'Material/Surface relief',`.

`scenePanelChrome`: add `Screen: { open: false },` after `Reflection`.

Add next to `RELIEF_DEFAULTS` (and import `screenOf` from `./config`):

```ts
const SCREEN_DEFAULTS = screenOf({}) as unknown as Record<string, ParamValue>
```

In `materialField`, after the `relief.` branch:

```ts
  if (field.startsWith('screen.')) {
    const sub = field.slice('screen.'.length)
    const v = (mat.screen as Record<string, unknown> | undefined)?.[sub]
    return (v ?? SCREEN_DEFAULTS[sub] ?? 0) as ParamValue
  }
```

`SUB_CARDS`: add

```ts
  'Material/Screen': [
    'object.material.screen.pattern', 'object.material.screen.density', 'object.material.screen.angle',
    'object.material.screen.contrast', 'object.material.screen.softness', 'object.material.screen.misregister',
    'object.material.screen.invert', 'object.material.screen.gap', 'object.material.screen.gapColor',
    'object.material.screen.ink', 'object.material.screen.inkColor',
  ],
```

`OVERRIDE`: add

```ts
  'object.material.screen.pattern': { label: 'Pattern', hint: null },
  'object.material.screen.density': { label: 'Density' },
  'object.material.screen.angle': { label: 'Angle' },
  'object.material.screen.contrast': { label: 'Contrast' },
  'object.material.screen.softness': { label: 'Softness' },
  'object.material.screen.invert': { label: 'Invert', hint: null },
  'object.material.screen.gap': { label: 'Gaps', hint: null },
  'object.material.screen.ink': { label: 'Ink', hint: null },
```

`panelGate`: add before the final `return true`:

```ts
  if (key.startsWith('object.material.screen.') && key !== 'object.material.screen.pattern') {
    return materialField(obj!.material, 'screen.pattern') !== 'none'
  }
```

(`showIf` on the two colour rows is evaluated by `scenePanelVisible` already, through `readSceneControl` → `materialField`.)

- [ ] **Step 4: Edit `Scene3DStudioSurface.vue` `setMaterialControl`**

```ts
function setMaterialControl(field: string, value: string | number | boolean): void {
  if (field === 'relief.source') { setReliefSource(value as 'none' | 'shader' | 'image'); return }
  if (field.startsWith('relief.')) { setReliefField(field.slice('relief.'.length), value); return }
  // Screen: always write a FULL block (every field filled from defaults) so a first dial
  // write from a screen-less material creates a valid ScreenSpec rather than a bare
  // `{ density: 60 }` the parser would read as pattern none.
  if (field.startsWith('screen.')) {
    const sub = field.slice('screen.'.length)
    applyMaterial((m) => { m.screen = { ...screenOf(m), [sub]: value } as ScreenSpec })
    return
  }
  applyMaterial((m) => writeMaterialField(m, field, value))
}
```

Import `screenOf` and `type ScreenSpec` from `~/lib/scene3d/config` in the surface's script.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-panel-parity.unit.spec.ts tests/unit/scene3d-controls.unit.spec.ts`
Expected: PASS. Typecheck grep `scene3d/panelPresentation|Scene3DStudioSurface` → only `done`.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add app/lib/scene3d/panelPresentation.ts app/components/vue-canvas/Scene3DStudioSurface.vue tests/unit/scene3d-panel-parity.unit.spec.ts && git commit -m "feat(scene3d): Screen card in the inspector — nested read/write, dials hidden until a pattern is picked, colour rows follow their mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: GLB meshes without UVs get the spherical fallback

**Files:**
- Modify: `frontend/app/lib/scene3d/glb.ts` (new export), `frontend/app/lib/scene3d/engine.ts` (the `loadGlb(obj.url).then((g) => …)` traverse ~line 900)
- Test: `frontend/tests/unit/scene3d-glb-uv.unit.spec.ts` (new)

**Interfaces:**
- Produces: `export function ensureUv(root: THREE.Object3D): number` — adds spherical UVs to every mesh geometry lacking a `uv` attribute; returns how many it patched.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/scene3d-glb-uv.unit.spec.ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ensureUv } from '~/lib/scene3d/glb'

describe('ensureUv — GLB meshes without UVs', () => {
  it('adds spherical UVs only to geometries that lack them', () => {
    const g = new THREE.Group()
    const withUv = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const bare = new THREE.BufferGeometry()
    bare.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3))
    const withoutUv = new THREE.Mesh(bare)
    g.add(withUv, withoutUv)
    expect(ensureUv(g)).toBe(1)
    expect(withoutUv.geometry.getAttribute('uv').count).toBe(3)
    for (let i = 0; i < 3; i++) {
      const u = withoutUv.geometry.getAttribute('uv').getX(i), v = withoutUv.geometry.getAttribute('uv').getY(i)
      expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
    }
    // The box's own UVs are untouched.
    expect(withUv.geometry.getAttribute('uv').count).toBe(24)
    expect(ensureUv(g)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/scene3d-glb-uv.unit.spec.ts`
Expected: FAIL — `ensureUv` is not exported.

- [ ] **Step 3: Implement**

In `glb.ts` (import `addSphericalUV` from `./roundedGeometry` and `* as THREE from 'three'` if not already):

```ts
/** Imported meshes with no `uv` attribute would read every UV-anchored finish (the screen,
 *  a shaderFill, a texture set) as one giant cell. Give them the same spherical projection
 *  the gem hull gets. Returns how many geometries were patched. */
export function ensureUv(root: THREE.Object3D): number {
  let n = 0
  root.traverse((c) => {
    const mesh = c as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.getAttribute('uv')) { addSphericalUV(mesh.geometry); n++ }
  })
  return n
}
```

In `engine.ts`, inside `loadGlb(obj.url).then((g) => { … })`, right after the `g.traverse((c) => { … castShadow … })` line:

```ts
          ensureUv(g)
```

and add `ensureUv` to the `./glb` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/scene3d-glb-uv.unit.spec.ts tests/unit/scene3d-rounded-geometry.unit.spec.ts`
Expected: PASS. Typecheck grep `scene3d/(glb|engine)` → only `done`.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add app/lib/scene3d/glb.ts app/lib/scene3d/engine.ts tests/unit/scene3d-glb-uv.unit.spec.ts && git commit -m "feat(scene3d): GLB meshes without UVs get the spherical fallback so surface-anchored finishes work

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Whole-suite check, live verification, docs

- [ ] **Step 1: Run the scene3d suites together**

Run: `cd frontend && npx vitest run tests/unit/scene3d-*.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck the touched files**

Run: `cd frontend && npx vue-tsc --noEmit -p . 2>&1 | grep -E "scene3d/|Scene3DStudioSurface|scene3d-"; echo done`
Expected: only `done`.

- [ ] **Step 3: Live check in the Browser pane** (dev server `frontend` on port 3002 via `preview_start`; open `http://127.0.0.1:3002/dev/scene3d-lab`; `resize_window` to 1440×900)

1. Add a sphere; Material type → gradient; two stops pink `#ff7ab6` → blue `#3b6bff`; background colour magenta `#ff2d95`.
2. Material → Screen → Pattern Dots. Expected: the dials appear; the sphere becomes dots that wrap it (denser toward the poles), big where lit, tiny in shadow, magenta showing through the gaps.
3. Density 60, Misregister 0.4 → red/blue fringes at the terminator. Angle 0 vs 90 → the grid visibly rotates. Contrast 3 → shadows go clear.
4. Gaps → Colour, gap colour white → paper look; back to Transparent.
5. Add a second sphere overlapping the first, both screened → check ordering looks right (front sphere's dots occlude the back sphere; gaps show the back sphere, not black). If ordering is wrong, note it: the fallback is `alphaTest: 0.5` with `transparent: false` (hard-edged cutouts), applied in `applyScreen` — decide with the user before changing.
6. Material type → toon and → opalescent with the screen on: both still render the screen over their own shading.
7. Type → glass: the Screen card disappears.
8. Save a proof PNG: in the page, `canvas.toDataURL()` of the WebGL canvas is black without `preserveDrawingBuffer`, so use the Browser pane `screenshot` and, if a file is needed, the `/api/dev-scratch` POST route on a 2D readback is NOT available for WebGL — the screenshot is the proof.

- [ ] **Step 4: Update the documents**

- `docs/STATE.md`: in the Die Doing entry, change the Screen finish paragraph from designed to **LANDED** with the commit range and the live-check outcome; keep the owed items (any visual quirk from step 5).
- Spec `docs/superpowers/specs/2026-09-03-scene3d-screen-finish-design.md`: `**Status:**` → landed with the commit range.
- Dashboard artifact: read the live page first, edit in place (Now block → shared moves core next; Landed 09-03 line; Surface maturity row for Scene3D small text gains `screen finish`), republish with its URL.

- [ ] **Step 5: Commit**

```bash
git add docs/STATE.md docs/superpowers/specs/2026-09-03-scene3d-screen-finish-design.md && git commit -m "docs(state): 3D Screen finish — landed write-up + live-check notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §1 → Task 1 (types, defaults, parse, `screenOf`). §2 → Task 2 (helper, chain, cache key, identity, in-place, transparency, `applyPhysical` guard); geometry-without-UVs → Task 5. §3 → Task 3 (controls, gates, hints, animatable by default) + Task 4 (panel card, nested read/write, hidden until a pattern is picked, colour rows via `showIf`). §4 → Task 3 (guidance + worked example). §5 → each task's tests; the input-correlation pixel check is the live step in Task 6 (headless three cannot render). §6 out of scope honoured (no glass, no screen-space, no time drift).
- Names consistent: `ScreenSpec`, `screenOf`, `SCREEN_PATTERNS/GAPS/INKS` (Task 1 → 2, 3, 4); `applyScreen`, `screenUniforms`, `screenTransparent` (Task 2); control keys `object.material.screen.*` (Task 3 → 4); `ensureUv` (Task 5).
- The `showIf` shape `{ key, equals }` is supported by `ControlSpec` (`~/lib/spacetype/effect.ts` line 15).
