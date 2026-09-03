# Shape Library Foundation + Expressive Studio Separator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 100 SVGs in `Assets/Shapes/` into a bundled, typed shape library with a shared picker and a new `shape` control kind, and paint a chosen shape as a separator between word repeats in every tile-based Space Type (Expressive Studio) effect.

**Architecture:** A node build script parses the SVGs (only `M L H V C S Z` commands, plus `polygon`/`rect`/`circle` with an optional `transform`) into absolute path data and writes `app/data/shape-library.manifest.json`. A pure catalog module wraps it; a canvas helper draws any shape into a box. Space Type gets three separator controls appended once at registration for eligible effects; the ONE tile painter (`makeTextTexture`) lays the tile out as `[text][gap][shape][gap]` when a separator is present, and both tile-options builders (`texOptsFromState` and the embed's `buildTexOpts`) resolve the separator through one shared function.

**Tech Stack:** Node ESM scripts (no new deps), Nuxt 4 / Vue 3 / TypeScript, vitest (node env, hand-rolled canvas fakes), THREE.CanvasTexture, Tailwind.

Spec: `docs/superpowers/specs/2026-09-02-shape-library-foundation-expressive-separator-design.md`

## Global Constraints

- Run all frontend commands from `frontend/`. Package manager is **pnpm** (`pnpm vitest run <file>`), never `npm install`.
- Typecheck baseline: `pnpm nuxt typecheck` has pre-existing errors; only errors naming files/types you touched count (see memory "Typecheck baseline anchoring").
- No new npm dependencies.
- Manifest numbers are rounded to 2 decimals; path data stored ABSOLUTE with only `M L C Z` commands.
- `separator` unset or `'none'` ⇒ `makeTextTexture` output byte-identical to today (canvas width, `userData` fractions, no path fill).
- Raw-word effects (`coil`, `elastic`, `echo`) and per-glyph effects (`blend`, `cascade`, `cylinder`, `onionburst`, `ring`, `slot`) get no separator controls and no behaviour change.
- Colour: the SVG fill is stored as `sourceColor` and never used to paint. Picker thumbnails use `currentColor`.
- Plain language in all user-facing copy. Action blue is the only accent; purple is banned. Selected picker tile uses the same `bg-white text-neutral-900` chip style as `StudioSegmented`.
- Commit after every task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer. Stage only your own files (`git add <paths>`), never `git add -A` (parallel sessions share this checkout).
- Every per-effect embed bundle must stay under `SPACETYPE_EFFECT_CEILING_BYTES = 1_750_000` (tests/unit/embed-build-output.unit.spec.ts). The manifest adds to every bundle; that is why numbers are rounded to 2 decimals.

## File map

| Path | Responsibility |
|---|---|
| `frontend/scripts/shapeLibrary.mjs` | Pure parser: slug/name, path tokeniser → absolute `M L C Z`, transform matrices, bbox, one-SVG parse. Unit-tested. |
| `frontend/scripts/build-shape-library.mjs` | Walk `Assets/Shapes`, call the parser, fail on any error, write the manifest. |
| `frontend/app/data/shape-library.manifest.json` | Generated. One shape per line. |
| `frontend/shared/shape-library.ts` | `LibraryShape`, `ShapeManifest` types (shared by app + tests). |
| `frontend/app/lib/shapes/catalog.ts` | `SHAPES`, `shapeById`, `SHAPE_FAMILIES`, `familyOf`, `searchShapes`, `SHAPE_NONE`, `isShapeId`. |
| `frontend/app/lib/shapes/path2d.ts` | `shapePath2D` (cached), `shapeAspect`, `drawShape`. |
| `frontend/app/components/vue-canvas/studio/ShapePicker.vue` | Teleported popover: search, family rail, thumbnail grid, None tile. |
| `frontend/app/components/vue-canvas/studio/rows/RowShape.vue` | Value-side renderer for the `shape` kind; opens the picker. |
| `frontend/app/components/vue-canvas/studio/rows/registry.ts` | `shape: RowShape`. |
| `frontend/app/lib/spacetype/effect.ts` | `ControlSpec` gains `shape`; exports `RAW_WORD_EFFECTS`, `PER_GLYPH_EFFECTS`. |
| `frontend/app/lib/spacetype/separator.ts` | `SEPARATOR_CONTROLS`, `separatorEligible`, `withSeparatorControls`, `separatorFromParams`. |
| `frontend/app/lib/spacetype/effects/index.ts` | Registry maps every effect through `withSeparatorControls`. |
| `frontend/app/lib/spacetype/textTexture.ts` | Paints the separator into the tile. |
| `frontend/app/lib/spacetype/state.ts` | `texOptsFromState` passes `separator`; uses shared `RAW_WORD_EFFECTS`. |
| `frontend/app/lib/embed/surfaces/spacetype.ts` | `buildTexOpts` passes `separator`; uses shared `RAW_WORD_EFFECTS`. |
| `frontend/app/lib/spacetype/controlDescriptor.ts` | `shape` kind described as an enum of ids; validated. |
| `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` | Renders `shape` controls through `StudioRow`. |

---

### Task 1: SVG parser + build script + manifest

**Files:**
- Create: `frontend/scripts/shapeLibrary.mjs`
- Create: `frontend/scripts/build-shape-library.mjs`
- Create: `frontend/shared/shape-library.ts`
- Create: `frontend/app/data/shape-library.manifest.json` (generated)
- Modify: `frontend/package.json` (scripts block, after `"build:embed"`)
- Test: `frontend/tests/unit/shape-library-parser.unit.spec.ts`
- Test: `frontend/tests/unit/shape-library-manifest.unit.spec.ts`

**Interfaces:**
- Produces: `LibraryShape { id, name, d, fillRule, box: [x,y,w,h], sourceColor }`, `ShapeManifest { generatedAt, shapesRoot, shapes }` in `shared/shape-library.ts`. Parser exports `slug`, `displayName`, `parsePath`, `serializePath`, `parseTransform`, `applyMatrix`, `pathBounds`, `elementToPath`, `parseShapeSvg`.

- [ ] **Step 1: Write the failing parser test**

`frontend/tests/unit/shape-library-parser.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  slug, displayName, parsePath, serializePath, parseTransform, applyMatrix, pathBounds,
  elementToPath, parseShapeSvg,
} from '../../scripts/shapeLibrary.mjs'

describe('slug / displayName', () => {
  it('lowercases, collapses runs, strips .svg', () => {
    expect(slug('Sun Rays.svg')).toBe('sun-rays')
    expect(slug('triangle-double .svg')).toBe('triangle-double')
    expect(displayName('sun-rays')).toBe('Sun rays')
  })
})

describe('parsePath', () => {
  it('normalises relative h/v/l/c/s to absolute M L C Z', () => {
    const cmds = parsePath('M10,10h20v20h-20Z')
    expect(cmds).toEqual([
      { c: 'M', p: [10, 10] }, { c: 'L', p: [30, 10] }, { c: 'L', p: [30, 30] }, { c: 'L', p: [10, 30] }, { c: 'Z', p: [] },
    ])
  })
  it('treats numbers after M as implicit L', () => {
    expect(parsePath('M0,0 10,0 10,10Z').map(c => c.c)).toEqual(['M', 'L', 'L', 'Z'])
  })
  it('reflects the control point for S after C', () => {
    const cmds = parsePath('M0,0C0,10,10,10,10,0S20,-10,20,0')
    expect(cmds[2]).toEqual({ c: 'C', p: [10, -10, 20, -10, 20, 0] })
  })
  it('rejects arcs and quadratics', () => {
    expect(() => parsePath('M0,0A5,5 0 0 1 10,10')).toThrow(/unsupported path command "A"/)
    expect(() => parsePath('M0,0Q5,5 10,10')).toThrow(/unsupported path command "Q"/)
  })
  it('serialises with 2-decimal numbers and no separators between commands', () => {
    expect(serializePath(parsePath('M1.23456,2.5l1,1Z'))).toBe('M1.23,2.5L2.23,3.5Z')
  })
})

describe('transforms', () => {
  it('composes translate then rotate in SVG order', () => {
    const m = parseTransform('translate(10 0) rotate(90)')
    const [{ p }] = applyMatrix([{ c: 'M', p: [1, 0] }], m)
    expect(p[0]).toBeCloseTo(10, 6)
    expect(p[1]).toBeCloseTo(1, 6)
  })
  it('identity for an empty transform', () => {
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0])
  })
})

describe('pathBounds', () => {
  it('bounds a rectangle exactly', () => {
    expect(pathBounds(parsePath('M8,8h80v80h-80Z'))).toEqual([8, 8, 80, 80])
  })
  it('bounds a cubic by sampling (circle of r=44 at 48,48)', () => {
    const d = elementToPath('circle', { cx: '48', cy: '48', r: '44' })
    const [x, y, w, h] = pathBounds(parsePath(d))
    expect(x).toBeCloseTo(4, 1); expect(y).toBeCloseTo(4, 1)
    expect(w).toBeCloseTo(88, 1); expect(h).toBeCloseTo(88, 1)
  })
})

describe('elementToPath', () => {
  it('polygon → closed polyline', () => {
    expect(elementToPath('polygon', { points: '48 4 14 28 48 92' })).toBe('M48,4L14,28L48,92Z')
  })
  it('rect → four sides', () => {
    expect(elementToPath('rect', { x: '8', y: '8', width: '80', height: '80' })).toBe('M8,8h80v80h-80Z')
  })
  it('rejects unknown elements and rounded rects', () => {
    expect(() => elementToPath('g', {})).toThrow(/unsupported element <g>/)
    expect(() => elementToPath('rect', { x: '0', y: '0', width: '1', height: '1', rx: '2' })).toThrow(/rx/)
  })
})

describe('parseShapeSvg', () => {
  const svg = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><svg id="a" xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${inner}</svg>`
  it('parses a single filled path', () => {
    const s = parseShapeSvg(svg('<path d="M8,8h80v80h-80Z" fill="#9b86bd" stroke-width="0"/>'), 'square.svg')
    expect(s).toEqual({ d: 'M8,8L88,8L88,88L8,88Z', fillRule: 'nonzero', box: [8, 8, 80, 80], sourceColor: '#9b86bd' })
  })
  it('applies an element transform (the rhombus rect)', () => {
    const s = parseShapeSvg(svg('<rect x="16.8873" y="16.8873" width="62.2254" height="62.2254" transform="translate(-19.8822 48) rotate(-45)" fill="#ff7f3e"/>'), 'rhombus.svg')
    const [x, y, w, h] = s.box
    expect(x).toBeCloseTo(4, 0); expect(y).toBeCloseTo(4, 0)
    expect(w).toBeCloseTo(88, 0); expect(h).toBeCloseTo(88, 0)
  })
  it('concatenates multiple elements and keeps the first fill', () => {
    const s = parseShapeSvg(svg('<path d="M0,0h10v10Z" fill="#111"/><polygon points="20 20 30 20 30 30" fill="#222"/>'), 'two.svg')
    expect(s.d).toBe('M0,0L10,0L10,10ZM20,20L30,20L30,30Z')
    expect(s.sourceColor).toBe('#111')
  })
  it('requires the 96 box', () => {
    expect(() => parseShapeSvg('<svg viewBox="0 0 24 24"><path d="M0,0Z"/></svg>', 'x.svg')).toThrow(/viewBox/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/shape-library-parser.unit.spec.ts`
Expected: FAIL — cannot resolve `../../scripts/shapeLibrary.mjs`.

- [ ] **Step 3: Write the parser**

`frontend/scripts/shapeLibrary.mjs`:

```js
// frontend/scripts/shapeLibrary.mjs
// Pure helpers for build-shape-library.mjs. Parses the tiny SVG dialect
// Assets/Shapes uses (path/polygon/rect/circle, optional transform, only
// M L H V C S Z path commands) into ABSOLUTE `M L C Z` path data plus an ink
// bounding box. No DOM, no dependencies, so the unit test imports it directly.

/** Round to 2 decimals and kill negative zero. */
export function f(v) {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? 0 : r
}

export function slug(name) {
  return name.toLowerCase().replace(/\.svg$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function displayName(id) {
  const s = id.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Parse `key="value"` pairs off one tag's attribute text. */
export function attrs(tagText) {
  const out = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(tagText))) out[m[1]] = m[2]
  return out
}

/**
 * Tokenise + normalise a path `d` string. Returns [{ c: 'M'|'L'|'C'|'Z', p: number[] }]
 * with every coordinate absolute. H/V become L; S becomes C with the reflected
 * control point. Anything outside M L H V C S Z throws — the build script surfaces
 * the filename so a future drawing that uses arcs is caught at build time.
 */
export function parsePath(d) {
  const tokens = []
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m
  while ((m = re.exec(d))) tokens.push(m[1] ?? Number(m[2]))
  const out = []
  let cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0
  let cmd = null
  let prev = ''
  let i = 0
  const num = () => {
    const v = tokens[i++]
    if (typeof v !== 'number') throw new Error(`expected a number in path data near token ${i - 1}`)
    return v
  }
  while (i < tokens.length) {
    const t = tokens[i]
    if (typeof t === 'string') { cmd = t; i++ }
    else if (cmd === null) throw new Error('path data does not start with a command')
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    switch (cmd) {
      case 'M': case 'm': {
        let x = num(), y = num()
        if (cmd === 'm') { x += cx; y += cy }
        cx = sx = x; cy = sy = y; px = cx; py = cy
        out.push({ c: 'M', p: [x, y] }); break
      }
      case 'L': case 'l': {
        let x = num(), y = num()
        if (cmd === 'l') { x += cx; y += cy }
        cx = x; cy = y; px = cx; py = cy
        out.push({ c: 'L', p: [x, y] }); break
      }
      case 'H': case 'h': {
        let x = num()
        if (cmd === 'h') x += cx
        cx = x; px = cx; py = cy
        out.push({ c: 'L', p: [cx, cy] }); break
      }
      case 'V': case 'v': {
        let y = num()
        if (cmd === 'v') y += cy
        cy = y; px = cx; py = cy
        out.push({ c: 'L', p: [cx, cy] }); break
      }
      case 'C': case 'c': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num()
        if (cmd === 'c') { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy }
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] })
        px = x2; py = y2; cx = x; cy = y; break
      }
      case 'S': case 's': {
        let x2 = num(), y2 = num(), x = num(), y = num()
        if (cmd === 's') { x2 += cx; y2 += cy; x += cx; y += cy }
        const x1 = prev === 'C' ? 2 * cx - px : cx
        const y1 = prev === 'C' ? 2 * cy - py : cy
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] })
        px = x2; py = y2; cx = x; cy = y; break
      }
      case 'Z': case 'z': {
        out.push({ c: 'Z', p: [] })
        cx = sx; cy = sy; px = cx; py = cy; break
      }
      default:
        throw new Error(`unsupported path command "${cmd}"`)
    }
    prev = out[out.length - 1].c
  }
  return out
}

export function serializePath(cmds) {
  return cmds.map(({ c, p }) => c + p.map(f).join(',')).join('')
}

/** [a, b, c, d, e, f] in SVG matrix layout. */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** Parse an SVG `transform` list (translate / rotate / scale) into one matrix. */
export function parseTransform(s) {
  let m = [1, 0, 0, 1, 0, 0]
  const re = /(translate|rotate|scale|matrix)\s*\(([^)]*)\)/g
  let t
  while ((t = re.exec(s ?? ''))) {
    const a = t[2].trim().split(/[\s,]+/).filter(Boolean).map(Number)
    let n
    if (t[1] === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    else if (t[1] === 'scale') { const sx = a[0] ?? 1, sy = a[1] ?? sx; n = [sx, 0, 0, sy, 0, 0] }
    else if (t[1] === 'matrix') { if (a.length !== 6) throw new Error('matrix() needs 6 numbers'); n = a }
    else {
      const rad = ((a[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(rad), sin = Math.sin(rad)
      n = [cos, sin, -sin, cos, 0, 0]
      if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]])
    }
    m = mul(m, n)
  }
  return m
}

export function applyMatrix(cmds, m) {
  return cmds.map(({ c, p }) => {
    const q = []
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1]
      q.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
    }
    return { c, p: q }
  })
}

/** Ink bbox [x, y, w, h]: lines exactly, cubics sampled at 16 steps. */
export function pathBounds(cmds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let cx = 0, cy = 0
  const add = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  for (const { c, p } of cmds) {
    if (c === 'M' || c === 'L') { cx = p[0]; cy = p[1]; add(cx, cy) }
    else if (c === 'C') {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, mt = 1 - t
        const x = mt * mt * mt * cx + 3 * mt * mt * t * p[0] + 3 * mt * t * t * p[2] + t * t * t * p[4]
        const y = mt * mt * mt * cy + 3 * mt * mt * t * p[1] + 3 * mt * t * t * p[3] + t * t * t * p[5]
        add(x, y)
      }
      cx = p[4]; cy = p[5]
    }
  }
  if (!Number.isFinite(minX)) throw new Error('empty path')
  return [f(minX), f(minY), f(maxX - minX), f(maxY - minY)]
}

const KAPPA = 0.5522847498

/** One SVG element → path data (still un-normalised; parsePath runs after). */
export function elementToPath(name, a) {
  switch (name) {
    case 'path':
      if (!a.d) throw new Error('<path> without d')
      return a.d.trim()
    case 'polygon': {
      const n = (a.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (n.length < 6 || n.length % 2 || n.some(v => !Number.isFinite(v))) throw new Error('<polygon> points malformed')
      let d = `M${n[0]},${n[1]}`
      for (let i = 2; i < n.length; i += 2) d += `L${n[i]},${n[i + 1]}`
      return d + 'Z'
    }
    case 'rect': {
      if (a.rx || a.ry) throw new Error('<rect> with rx/ry is not supported — convert it to a path')
      const x = Number(a.x ?? 0), y = Number(a.y ?? 0), w = Number(a.width), h = Number(a.height)
      if (![x, y, w, h].every(Number.isFinite)) throw new Error('<rect> malformed')
      return `M${x},${y}h${w}v${h}h${-w}Z`
    }
    case 'circle': {
      const cx = Number(a.cx ?? 0), cy = Number(a.cy ?? 0), r = Number(a.r)
      if (![cx, cy, r].every(Number.isFinite)) throw new Error('<circle> malformed')
      const k = KAPPA * r
      return `M${cx + r},${cy}` +
        `C${cx + r},${cy + k},${cx + k},${cy + r},${cx},${cy + r}` +
        `C${cx - k},${cy + r},${cx - r},${cy + k},${cx - r},${cy}` +
        `C${cx - r},${cy - k},${cx - k},${cy - r},${cx},${cy - r}` +
        `C${cx + k},${cy - r},${cx + r},${cy - k},${cx + r},${cy}Z`
    }
    default:
      throw new Error(`unsupported element <${name}>`)
  }
}

/** Whole file → { d, fillRule, box, sourceColor }. Throws with the filename on anything odd. */
export function parseShapeSvg(svgText, fileName) {
  const vb = /viewBox="([^"]+)"/.exec(svgText)
  if (!vb || vb[1].trim().split(/\s+/).join(' ') !== '0 0 96 96') throw new Error(`${fileName}: viewBox must be "0 0 96 96"`)
  const body = svgText.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const tagRe = /<([a-zA-Z]+)([^>]*?)\/?>/g
  const cmds = []
  let sourceColor = null
  let fillRule = 'nonzero'
  let m
  try {
    while ((m = tagRe.exec(body))) {
      const a = attrs(m[2])
      let part = parsePath(elementToPath(m[1], a))
      if (a.transform) part = applyMatrix(part, parseTransform(a.transform))
      cmds.push(...part)
      if (sourceColor === null && a.fill && a.fill !== 'none') sourceColor = a.fill
      if (a['fill-rule'] === 'evenodd') fillRule = 'evenodd'
    }
  } catch (e) {
    throw new Error(`${fileName}: ${e.message}`)
  }
  if (!cmds.length) throw new Error(`${fileName}: no drawable elements`)
  return { d: serializePath(cmds), fillRule, box: pathBounds(cmds), sourceColor: sourceColor ?? '#000000' }
}
```

- [ ] **Step 4: Run the parser test**

Run: `cd frontend && pnpm vitest run tests/unit/shape-library-parser.unit.spec.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Add the shared types**

`frontend/shared/shape-library.ts`:

```ts
/** One entry of app/data/shape-library.manifest.json (generated by scripts/build-shape-library.mjs). */
export interface LibraryShape {
  /** Slug of the SVG filename, e.g. 'sun-rays'. Stable id for params and the agent. */
  id: string
  /** Display name, e.g. 'Sun rays'. */
  name: string
  /** Absolute path data (only M L C Z) in the 96×96 source box. */
  d: string
  fillRule: 'nonzero' | 'evenodd'
  /** Ink bounding box [x, y, w, h] in source units. Consumers fit by this, not by the 96 box. */
  box: [number, number, number, number]
  /** The SVG's fill, kept as a hint only. Never used to paint. */
  sourceColor: string
}

export interface ShapeManifest {
  generatedAt: string
  shapesRoot: string
  shapes: LibraryShape[]
}
```

- [ ] **Step 6: Write the build script and the package script**

`frontend/scripts/build-shape-library.mjs`:

```js
// frontend/scripts/build-shape-library.mjs
// Scan <repo>/Assets/Shapes/*.svg and write app/data/shape-library.manifest.json.
// Run: `node scripts/build-shape-library.mjs` (from frontend/), or `pnpm build:shapes`.
// Re-run whenever a shape is added, renamed or redrawn. Idempotent apart from
// generatedAt. Any parse error or id collision fails the whole build — a partial
// manifest is never written.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slug, displayName, parseShapeSvg } from './shapeLibrary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SHAPES_ROOT = join(REPO_ROOT, 'Assets', 'Shapes')
const OUT = join(HERE, '..', 'app', 'data', 'shape-library.manifest.json')

function main() {
  const files = readdirSync(SHAPES_ROOT).filter(n => !n.startsWith('.') && n.toLowerCase().endsWith('.svg')).sort()
  const shapes = []
  const seen = new Map()
  const errors = []
  for (const name of files) {
    const id = slug(name)
    if (!id) { errors.push(`${name}: empty id`); continue }
    if (seen.has(id)) { errors.push(`${name}: id "${id}" collides with ${seen.get(id)}`); continue }
    seen.set(id, name)
    try {
      const parsed = parseShapeSvg(readFileSync(join(SHAPES_ROOT, name), 'utf8'), name)
      shapes.push({ id, name: displayName(id), ...parsed })
    } catch (e) {
      errors.push(String(e.message))
    }
  }
  if (errors.length) {
    console.error(`build:shapes: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  const head = JSON.stringify({ generatedAt: new Date().toISOString(), shapesRoot: 'Assets/Shapes' }).slice(0, -1)
  const body = shapes.map(s => '    ' + JSON.stringify(s)).join(',\n')
  writeFileSync(OUT, `${head},\n  "shapes": [\n${body}\n  ]\n}\n`)
  console.log(`build:shapes: wrote ${shapes.length} shapes → ${OUT}`)
}

main()
```

In `frontend/package.json`, after the `"build:embed"` line add:

```json
    "build:shapes": "node scripts/build-shape-library.mjs",
```

- [ ] **Step 7: Run the build**

Run: `cd frontend && pnpm build:shapes`
Expected: `build:shapes: wrote 100 shapes → .../app/data/shape-library.manifest.json`. If it exits 1, the message names the file; fix that file's handling in `shapeLibrary.mjs` (do not hand-edit the SVG unless it is genuinely malformed), then rerun.

- [ ] **Step 8: Write the manifest test**

`frontend/tests/unit/shape-library-manifest.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/shape-library.manifest.json'
import type { ShapeManifest } from '../../shared/shape-library'

const m = manifest as unknown as ShapeManifest

describe('generated shape-library manifest', () => {
  it('has 100 shapes with unique ids', () => {
    expect(m.shapes.length).toBe(100)
    expect(new Set(m.shapes.map(s => s.id)).size).toBe(100)
  })
  it('every shape has absolute M/L/C/Z path data inside the 96 box', () => {
    for (const s of m.shapes) {
      expect(s.d, s.id).toMatch(/^M/)
      expect(s.d.replace(/[0-9.,-]/g, ''), s.id).toMatch(/^[MLCZ]+$/)
      const [x, y, w, h] = s.box
      expect(w, s.id).toBeGreaterThan(0)
      expect(h, s.id).toBeGreaterThan(0)
      expect(x, s.id).toBeGreaterThanOrEqual(-1)
      expect(y, s.id).toBeGreaterThanOrEqual(-1)
      expect(x + w, s.id).toBeLessThanOrEqual(97)
      expect(y + h, s.id).toBeLessThanOrEqual(97)
      expect(s.sourceColor, s.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(['nonzero', 'evenodd']).toContain(s.fillRule)
    }
  })
  it('numbers are rounded to at most 2 decimals', () => {
    for (const s of m.shapes) expect(s.d, s.id).not.toMatch(/\.\d{3}/)
  })
  it('includes the shapes the separator demo and the rename rely on', () => {
    const ids = new Set(m.shapes.map(s => s.id))
    for (const id of ['sparkle', 'sun-rays', 'circle', 'triangle-double', 'triangle-hourglass', 'rhombus']) expect(ids.has(id), id).toBe(true)
  })
})
```

- [ ] **Step 9: Run both tests**

Run: `cd frontend && pnpm vitest run tests/unit/shape-library-parser.unit.spec.ts tests/unit/shape-library-manifest.unit.spec.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/scripts/shapeLibrary.mjs frontend/scripts/build-shape-library.mjs frontend/shared/shape-library.ts frontend/app/data/shape-library.manifest.json frontend/package.json frontend/tests/unit/shape-library-parser.unit.spec.ts frontend/tests/unit/shape-library-manifest.unit.spec.ts
git commit -m "feat(shapes): build script + manifest for the Assets/Shapes library (100 SVGs → absolute path data)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Catalog module

**Files:**
- Create: `frontend/app/lib/shapes/catalog.ts`
- Test: `frontend/tests/unit/shapes-catalog.unit.spec.ts`

**Interfaces:**
- Consumes: `LibraryShape`, `ShapeManifest` (Task 1).
- Produces: `SHAPES: readonly LibraryShape[]`, `shapeById(id): LibraryShape | undefined`, `SHAPE_NONE = 'none'`, `isShapeId(v): v is string`, `ShapeFamily`, `SHAPE_FAMILIES`, `familyRuleFor(id): ShapeFamily | null`, `familyOf(id): ShapeFamily`, `searchShapes(query): LibraryShape[]`, `shapeOptions(allowNone): string[]`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/shapes-catalog.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  SHAPES, SHAPE_NONE, SHAPE_FAMILIES, shapeById, isShapeId, familyOf, familyRuleFor, searchShapes, shapeOptions,
} from '../../app/lib/shapes/catalog'

describe('shape catalog', () => {
  it('exposes the manifest and looks up by id', () => {
    expect(SHAPES.length).toBe(100)
    expect(shapeById('sparkle')?.name).toBe('Sparkle')
    expect(shapeById('nope')).toBeUndefined()
    expect(isShapeId('sparkle')).toBe(true)
    expect(isShapeId(SHAPE_NONE)).toBe(false)
    expect(isShapeId(42)).toBe(false)
  })
  it('every id resolves to a family by rule (no fallback)', () => {
    for (const s of SHAPES) expect(familyRuleFor(s.id), s.id).not.toBeNull()
  })
  it('places known ids', () => {
    expect(familyOf('sun-rays')).toBe('suns')
    expect(familyOf('sparkle-invert')).toBe('suns')
    expect(familyOf('leaf-grow')).toBe('botanical')
    expect(familyOf('square-strokes-diagonal')).toBe('patterns')
    expect(familyOf('corner-radius-pattern-swap')).toBe('patterns')
    expect(familyOf('corner-radius')).toBe('geometric')
    expect(familyOf('diagram-venn')).toBe('diagram')
    expect(familyOf('plus')).toBe('symbols')
    expect(familyOf('unknown-thing')).toBe('symbols')
  })
  it('every family has at least one shape and the rail lists six', () => {
    expect(SHAPE_FAMILIES.map(f => f.id)).toEqual(['geometric', 'suns', 'botanical', 'patterns', 'symbols', 'diagram'])
    for (const fam of SHAPE_FAMILIES) expect(SHAPES.some(s => familyOf(s.id) === fam.id), fam.id).toBe(true)
  })
  it('searches id and name, case-insensitive; empty query returns all', () => {
    expect(searchShapes('').length).toBe(100)
    const suns = searchShapes('SUN')
    expect(suns.length).toBeGreaterThanOrEqual(4)
    expect(suns.every(s => s.id.includes('sun') || s.name.toLowerCase().includes('sun'))).toBe(true)
    expect(searchShapes('Sun rays').map(s => s.id)).toContain('sun-rays')
  })
  it('shapeOptions leads with none unless disallowed', () => {
    expect(shapeOptions(true)[0]).toBe(SHAPE_NONE)
    expect(shapeOptions(true).length).toBe(101)
    expect(shapeOptions(false)).not.toContain(SHAPE_NONE)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-catalog.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/shapes/catalog`.

- [ ] **Step 3: Write the catalog**

`frontend/app/lib/shapes/catalog.ts`:

```ts
/**
 * The shape library — a typed, pure catalog over the committed manifest
 * (app/data/shape-library.manifest.json, generated by scripts/build-shape-library.mjs
 * from Assets/Shapes/*.svg). Every consumer — the Space Type separator, the
 * Compositor shape layer, Shape Studio, 3D Studio, the agent — reads shapes
 * through here. No DOM, no network: safe in the headless bake and the embed.
 */
import manifest from '~/data/shape-library.manifest.json'
import type { LibraryShape, ShapeManifest } from '~~/shared/shape-library'

export type { LibraryShape } from '~~/shared/shape-library'

export const SHAPE_MANIFEST = manifest as unknown as ShapeManifest
export const SHAPES: readonly LibraryShape[] = SHAPE_MANIFEST.shapes

/** The "no shape" value a `shape` control stores. */
export const SHAPE_NONE = 'none'

const byId = new Map<string, LibraryShape>(SHAPES.map(s => [s.id, s]))

export function shapeById(id: string): LibraryShape | undefined {
  return byId.get(id)
}

export function isShapeId(v: unknown): v is string {
  return typeof v === 'string' && byId.has(v)
}

export type ShapeFamily = 'geometric' | 'suns' | 'botanical' | 'patterns' | 'symbols' | 'diagram'

/** Rail order. Labels are plain words a casual user recognises. */
export const SHAPE_FAMILIES: { id: ShapeFamily; label: string }[] = [
  { id: 'geometric', label: 'Geometric' },
  { id: 'suns', label: 'Suns & sparkles' },
  { id: 'botanical', label: 'Botanical' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'diagram', label: 'Diagram' },
]

/**
 * First matching rule wins. Patterns go first so `square-strokes-*` and
 * `*-pattern-*` land there before the geometric prefixes claim them. A shape
 * that matches nothing is reported by `familyRuleFor` as null (the manifest
 * test fails on it) and shown under Symbols by `familyOf`.
 */
const FAMILY_RULES: [ShapeFamily, RegExp][] = [
  ['patterns', /pattern|strokes|repeat|-tile$/],
  ['suns', /^(sun-|sparkle|explosion$|spin$|splash$)/],
  ['botanical', /^(leaf|flower|floral|cloud$|circle-cloud$|heart$|swirl$|spiral$|wave$)/],
  ['diagram', /^(diagram-|pie-chart$|circle-network$|stairs$)/],
  ['symbols', /^(x|z|plus|badge|clover-x)$/],
  ['geometric', /^(circle|cone$|cylinder$|decagon$|dodecagon$|ellipse|half-circle|hendecagon$|heptagon$|hexagon$|nanogon$|octagon$|pentagon$|polygon$|parallelogram|rhombus|square|trapezoid$|triangle|kite$|intersect|corner-radius$|beak|gate$|umbrella-top$)/],
]

export function familyRuleFor(id: string): ShapeFamily | null {
  for (const [fam, re] of FAMILY_RULES) if (re.test(id)) return fam
  return null
}

export function familyOf(id: string): ShapeFamily {
  return familyRuleFor(id) ?? 'symbols'
}

/** Case-insensitive substring over id and name. '' ⇒ everything, manifest order. */
export function searchShapes(query: string): LibraryShape[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...SHAPES]
  const qDashed = q.replace(/\s+/g, '-')
  return SHAPES.filter(s => s.id.includes(qDashed) || s.name.toLowerCase().includes(q))
}

/** The option list a `shape` control exposes to the agent: 'none' first when allowed, then every id. */
export function shapeOptions(allowNone: boolean): string[] {
  return [...(allowNone ? [SHAPE_NONE] : []), ...SHAPES.map(s => s.id)]
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-catalog.unit.spec.ts`
Expected: PASS. If "every id resolves to a family" fails, the message names the id: extend the matching rule's regex in `FAMILY_RULES` (do not loosen the test).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/shapes/catalog.ts frontend/tests/unit/shapes-catalog.unit.spec.ts
git commit -m "feat(shapes): pure catalog — lookup, families, search, agent options

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Canvas drawing helper

**Files:**
- Create: `frontend/app/lib/shapes/path2d.ts`
- Test: `frontend/tests/unit/shapes-path2d.unit.spec.ts`

**Interfaces:**
- Consumes: `LibraryShape` (Task 1).
- Produces: `shapePath2D(shape): Path2D`, `shapeAspect(shape): number`, `DrawShapeOpts { x, y, w, h, fill?, stroke?: { color, width } }`, `drawShape(ctx, shape, opts): void`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/shapes-path2d.unit.spec.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

/** Path2D stand-in that remembers its path data — node has no canvas. */
class FakePath2D { constructor(public d: string) {} }

/** A recording 2D context: transforms and paints, in order. */
class RecCtx {
  ops: any[] = []
  fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 1; lineJoin = 'miter'
  save() { this.ops.push(['save']) }
  restore() { this.ops.push(['restore']) }
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p.d, this.strokeStyle, this.lineWidth]) }
}

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

beforeAll(() => { (globalThis as any).Path2D = FakePath2D })

describe('shapeAspect', () => {
  it('is box width over height', async () => {
    const { shapeAspect } = await import('../../app/lib/shapes/path2d')
    expect(shapeAspect(tall)).toBe(0.5)
  })
})

describe('drawShape', () => {
  it('fits the ink box into the target, keeps aspect, centres, fills with the shape rule', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 100, h: 100, fill: '#abc' })
    // scale = min(100/20, 100/40) = 2.5; drawn box 50×100, centred → left 25; minus bbox origin ×scale
    expect(ctx.ops).toEqual([
      ['save'], ['translate', 0, -25], ['scale', 2.5, 2.5], ['fill', tall.d, 'evenodd', '#abc'], ['restore'],
    ])
  })
  it('strokes before filling, with the line width divided by the scale', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 20, h: 40, fill: '#fff', stroke: { color: '#000', width: 4 } })
    expect(ctx.ops.map(o => o[0])).toEqual(['save', 'translate', 'scale', 'stroke', 'fill', 'restore'])
    expect(ctx.ops[3]).toEqual(['stroke', tall.d, '#000', 4])
  })
  it('is a no-op for an empty target box', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 0, h: 10, fill: '#fff' })
    expect(ctx.ops).toEqual([])
  })
  it('caches one Path2D per shape id', async () => {
    const { shapePath2D } = await import('../../app/lib/shapes/path2d')
    expect(shapePath2D(tall)).toBe(shapePath2D(tall))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-path2d.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/shapes/path2d`.

- [ ] **Step 3: Write the helper**

`frontend/app/lib/shapes/path2d.ts`:

```ts
/**
 * Canvas-2D side of the shape library. Every 2D consumer (the Space Type tile
 * painter today; Compositor thumbnails and picker previews later) draws a
 * library shape through `drawShape`, so "fit the ink box into a target box"
 * lives in exactly one place. Browser-only (Path2D) — never import from a
 * module the server or a node-only path reaches.
 */
import type { LibraryShape } from '~~/shared/shape-library'

const cache = new Map<string, Path2D>()

/** One Path2D per shape id, built lazily and kept for the page's life. */
export function shapePath2D(shape: LibraryShape): Path2D {
  let p = cache.get(shape.id)
  if (!p) { p = new Path2D(shape.d); cache.set(shape.id, p) }
  return p
}

/** Ink width ÷ ink height. 1 for a degenerate box. */
export function shapeAspect(shape: LibraryShape): number {
  const [, , w, h] = shape.box
  return h > 0 && w > 0 ? w / h : 1
}

export interface DrawShapeOpts {
  /** Target box, in the context's current units. The ink box is fitted inside, aspect kept, centred. */
  x: number; y: number; w: number; h: number
  fill?: string
  /** Outline in context pixels — divided by the fit scale so it matches text stroke widths. */
  stroke?: { color: string; width: number }
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: LibraryShape, o: DrawShapeOpts): void {
  if (!(o.w > 0) || !(o.h > 0)) return
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0)) return
  const s = Math.min(o.w / bw, o.h / bh)
  const dx = o.x + (o.w - bw * s) / 2 - bx * s
  const dy = o.y + (o.h - bh * s) / 2 - by * s
  const path = shapePath2D(shape)
  ctx.save()
  ctx.translate(dx, dy)
  ctx.scale(s, s)
  if (o.stroke && o.stroke.width > 0) {
    ctx.lineWidth = o.stroke.width / s
    ctx.strokeStyle = o.stroke.color
    ctx.lineJoin = 'round'
    ctx.stroke(path)
  }
  if (o.fill) {
    ctx.fillStyle = o.fill
    ctx.fill(path, shape.fillRule)
  }
  ctx.restore()
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && pnpm vitest run tests/unit/shapes-path2d.unit.spec.ts`
Expected: PASS. (The stroke test records `lineWidth` 4 because scale is 1 there.)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/shapes/path2d.ts frontend/tests/unit/shapes-path2d.unit.spec.ts
git commit -m "feat(shapes): drawShape — fit a library shape's ink box into any canvas box

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `shape` control kind + agent describer

**Files:**
- Modify: `frontend/app/lib/spacetype/effect.ts` (ControlSpec union, ~line 72–123; add exported sets after `defaultsFromControls`)
- Modify: `frontend/app/lib/spacetype/controlDescriptor.ts`
- Test: `frontend/tests/unit/control-descriptor-shape.unit.spec.ts`

**Interfaces:**
- Consumes: `shapeOptions`, `SHAPE_NONE` (Task 2).
- Produces: ControlSpec member `{ key, label, kind: 'shape', default: string, allowNone?: boolean, group }`; `RAW_WORD_EFFECTS`, `PER_GLYPH_EFFECTS` (ReadonlySet<string>) exported from `effect.ts`; `DescribedControl.kind` includes `'shape'`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/control-descriptor-shape.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeControls, validatePatch } from '../../app/lib/spacetype/controlDescriptor'
import type { ControlSpec } from '../../app/lib/spacetype/effect'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from '../../app/lib/spacetype/effect'

const shapeCtl: ControlSpec = { key: 'separator', label: 'Separator', kind: 'shape', default: 'none', group: 'Type' }
const strictCtl: ControlSpec = { key: 'base', label: 'Base shape', kind: 'shape', default: 'circle', allowNone: false, group: 'Shape' }

describe('shape control kind — agent describer', () => {
  it('is agent-editable and lists none + every shape id', () => {
    const [d] = describeControls([shapeCtl], {})
    expect(d?.kind).toBe('shape')
    expect(d?.options?.[0]).toBe('none')
    expect(d?.options?.length).toBe(101)
    expect(d?.options).toContain('sparkle')
    expect(d?.current).toBe('none')
    expect(d?.hint).toMatch(/shape library/i)
  })
  it('omits none when allowNone is false', () => {
    const [d] = describeControls([strictCtl], {})
    expect(d?.options).not.toContain('none')
    expect(d?.options?.length).toBe(100)
  })
  it('validatePatch keeps known ids and none, drops anything else', () => {
    const described = describeControls([shapeCtl], {})
    expect(validatePatch({ separator: 'sparkle' }, described)).toEqual({ separator: 'sparkle' })
    expect(validatePatch({ separator: 'none' }, described)).toEqual({ separator: 'none' })
    expect(validatePatch({ separator: 'unicorn' }, described)).toEqual({})
    expect(validatePatch({ separator: 3 }, described)).toEqual({})
  })
})

describe('effect family sets', () => {
  it('name the raw-word and per-glyph effects', () => {
    expect([...RAW_WORD_EFFECTS].sort()).toEqual(['coil', 'echo', 'elastic'])
    expect([...PER_GLYPH_EFFECTS].sort()).toEqual(['blend', 'cascade', 'cylinder', 'onionburst', 'ring', 'slot'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/control-descriptor-shape.unit.spec.ts`
Expected: FAIL — `RAW_WORD_EFFECTS` is not exported; described kind is not `shape` (control filtered out as non-editable).

- [ ] **Step 3: Extend ControlSpec and export the sets**

In `frontend/app/lib/spacetype/effect.ts`, inside the `ControlSpec` union, directly after the `font` member line

```ts
  | { key: string; label: string; kind: 'font'; default: string; group: string }
```

add:

```ts
  // A shape from the shape library (~/lib/shapes/catalog). Stores a shape id or
  // 'none'. `allowNone: false` for consumers that always need a shape (a base
  // shape); the default (true) offers a None tile and lists 'none' to the agent.
  | { key: string; label: string; kind: 'shape'; default: string; allowNone?: boolean; group: string }
```

After the `defaultsFromControls` function add:

```ts
/**
 * Effects that render the bare word, not the tiled ribbon label — no trailing
 * gap, no separator. ONE definition: state.ts's texOptsFromState and the embed's
 * buildTexOpts both read this (they used to carry private copies).
 */
export const RAW_WORD_EFFECTS: ReadonlySet<string> = new Set(['coil', 'elastic', 'echo'])

/**
 * Effects that lay out individual letters via layoutChars and never sample the
 * tile texture as a whole — a separator painted into the tile would never show,
 * so they are excluded from separator controls until the per-glyph follow-up.
 */
export const PER_GLYPH_EFFECTS: ReadonlySet<string> = new Set(['blend', 'cascade', 'cylinder', 'onionburst', 'ring', 'slot'])
```

- [ ] **Step 4: Teach the describer**

In `frontend/app/lib/spacetype/controlDescriptor.ts`:

Add the import after the existing two:

```ts
import { shapeOptions } from '~/lib/shapes/catalog'
```

Change the `kind` line of `DescribedControl` to:

```ts
  kind: 'slider' | 'select' | 'color' | 'font' | 'gradientStops' | 'switch' | 'text' | 'shape'
```

Change `AI_EDITABLE_KINDS` to:

```ts
const AI_EDITABLE_KINDS = new Set(['slider', 'select', 'color', 'font', 'gradientStops', 'switch', 'shape'])
```

In `describeControls`, after the `if (c.kind === 'select') d.options = c.options` line add:

```ts
    if (c.kind === 'shape') {
      d.options = shapeOptions(c.allowNone !== false)
      d.hint = c.hint ?? 'A shape id from the shape library, or none.'
    }
```

In `validatePatch`, after the `select` branch add:

```ts
    else if (d.kind === 'shape') {
      if (typeof raw === 'string' && d.options!.includes(raw)) out[key] = raw
    }
```

- [ ] **Step 5: Run the test and the existing descriptor suites**

Run: `cd frontend && pnpm vitest run tests/unit/control-descriptor-shape.unit.spec.ts tests/unit/spacetype-sections.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/spacetype/effect.ts frontend/app/lib/spacetype/controlDescriptor.ts frontend/tests/unit/control-descriptor-shape.unit.spec.ts
git commit -m "feat(spacetype): 'shape' control kind — described to the agent as an enum of library ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Separator controls, eligibility, and the shared resolver

**Files:**
- Create: `frontend/app/lib/spacetype/separator.ts`
- Modify: `frontend/app/lib/spacetype/effects/index.ts` (the `SPACE_TYPE_EFFECTS` array)
- Modify: `frontend/app/lib/spacetype/state.ts` (imports; `RAW_WORD_EFFECTS` const at line 96; `defaultSpaceTypeState`; `texOptsFromState` return)
- Modify: `frontend/app/lib/embed/surfaces/spacetype.ts` (imports; local `RAW_WORD_EFFECTS` at line 59; `buildTexOpts` return)
- Test: `frontend/tests/unit/spacetype-separator-controls.unit.spec.ts`

**Interfaces:**
- Consumes: `RAW_WORD_EFFECTS`, `PER_GLYPH_EFFECTS`, `ControlSpec` (Task 4); `shapeById`, `SHAPE_NONE` (Task 2).
- Produces: `SEPARATOR_CONTROLS: ControlSpec[]`, `separatorEligible(effectId): boolean`, `withSeparatorControls(effect): SpaceTypeEffect`, `SeparatorSpec { shape: LibraryShape; size: number; gap: number }`, `separatorFromParams(effectId, params): SeparatorSpec | undefined`. Both tile-option builders return `separator?: SeparatorSpec` (Task 6 reads it).

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/spacetype-separator-controls.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SPACE_TYPE_EFFECTS, getEffect } from '../../app/lib/spacetype/effects'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from '../../app/lib/spacetype/effect'
import { SEPARATOR_CONTROLS, separatorEligible, separatorFromParams, withSeparatorControls } from '../../app/lib/spacetype/separator'
import { showIfVisible } from '../../app/lib/studio/sections'
import { texOptsFromState, defaultSpaceTypeState } from '../../app/lib/spacetype/state'
import { buildTexOpts } from '~/lib/embed/surfaces/spacetype'
import { ribbonEffect } from '../../app/lib/spacetype/effects/ribbon'

const KEYS = ['separator', 'separatorSize', 'separatorGap']

describe('separator controls are injected once at registration', () => {
  for (const e of SPACE_TYPE_EFFECTS) {
    const eligible = !RAW_WORD_EFFECTS.has(e.id) && !PER_GLYPH_EFFECTS.has(e.id)
    it(`${e.id}: ${eligible ? 'has' : 'lacks'} the three Type controls`, () => {
      const keys = e.controls.filter(c => KEYS.includes(c.key)).map(c => c.key)
      expect(keys).toEqual(eligible ? KEYS : [])
      expect(separatorEligible(e.id)).toBe(eligible)
      for (const c of e.controls.filter(c => KEYS.includes(c.key))) expect(c.group).toBe('Type')
    })
  }
  it('is idempotent and does not touch ineligible effects', () => {
    const twice = withSeparatorControls(withSeparatorControls(ribbonEffect))
    expect(twice.controls.filter(c => c.key === 'separator').length).toBe(1)
    expect(withSeparatorControls(getEffect('coil'))).toBe(getEffect('coil'))
  })
  it('size and gap hide while separator is none', () => {
    const size = SEPARATOR_CONTROLS.find(c => c.key === 'separatorSize')!
    expect(showIfVisible(size, () => 'none')).toBe(false)
    expect(showIfVisible(size, () => 'sparkle')).toBe(true)
  })
  it('getEffect returns the injected effect; defaults include separator: none', () => {
    const ribbon = getEffect('ribbon')
    expect(ribbon.controls.some(c => c.key === 'separator')).toBe(true)
    expect(defaultSpaceTypeState().params.separator).toBe('none')
  })
})

describe('separatorFromParams', () => {
  it('resolves a valid id with size/gap and their defaults', () => {
    const s = separatorFromParams('ribbon', { separator: 'sparkle', separatorSize: 1.2, separatorGap: 0.5 })
    expect(s?.shape.id).toBe('sparkle'); expect(s?.size).toBe(1.2); expect(s?.gap).toBe(0.5)
    const d = separatorFromParams('ribbon', { separator: 'sparkle' })
    expect(d?.size).toBe(0.7); expect(d?.gap).toBe(1)
  })
  it('is undefined for none, unknown ids, and ineligible effects', () => {
    expect(separatorFromParams('ribbon', { separator: 'none' })).toBeUndefined()
    expect(separatorFromParams('ribbon', {})).toBeUndefined()
    expect(separatorFromParams('ribbon', { separator: 'unicorn' })).toBeUndefined()
    expect(separatorFromParams('coil', { separator: 'sparkle' })).toBeUndefined()
    expect(separatorFromParams('ring', { separator: 'sparkle' })).toBeUndefined()
  })
})

describe('both tile-option builders carry the separator', () => {
  it('texOptsFromState', () => {
    const st = defaultSpaceTypeState()
    expect(texOptsFromState(st).separator).toBeUndefined()
    st.params.separator = 'sun-rays'
    expect(texOptsFromState(st).separator?.shape.id).toBe('sun-rays')
  })
  it('embed buildTexOpts', () => {
    const p = { ...defaultSpaceTypeState().params, separator: 'sun-rays' }
    expect(buildTexOpts(ribbonEffect, p, null, []).separator?.shape.id).toBe('sun-rays')
    expect(buildTexOpts(ribbonEffect, { ...p, separator: 'none' }, null, []).separator).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/spacetype-separator-controls.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/spacetype/separator`.

- [ ] **Step 3: Write `separator.ts`**

`frontend/app/lib/spacetype/separator.ts`:

```ts
/**
 * The separator: a library shape painted between word repeats in the tile
 * texture, so "SAILOR ✦ SAILOR ✦" rides every tile-based effect.
 *
 * Three pieces, one file: the controls (appended once, at registration, to
 * every eligible effect — never pasted into 22 effect modules), the eligibility
 * rule, and the resolver both tile-option builders call so the modal, the node
 * card, the clip renderer, the headless bake and the embed cannot disagree.
 */
import type { ControlSpec, Params, SpaceTypeEffect } from './effect'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from './effect'
import { shapeById, SHAPE_NONE, type LibraryShape } from '~/lib/shapes/catalog'

export const SEPARATOR_DEFAULT_SIZE = 0.7
export const SEPARATOR_DEFAULT_GAP = 1

/** Size is a fraction of cap height; spacing is quarter-ems on each side of the shape. */
export const SEPARATOR_CONTROLS: ControlSpec[] = [
  { key: 'separator', label: 'Separator', kind: 'shape', default: SHAPE_NONE, group: 'Type',
    hint: 'A shape drawn between repeats of the text, or none.' },
  { key: 'separatorSize', label: 'Separator size', kind: 'slider', min: 0.3, max: 1.5, step: 0.05, default: SEPARATOR_DEFAULT_SIZE,
    group: 'Type', showIf: { key: 'separator', notEquals: SHAPE_NONE } },
  { key: 'separatorGap', label: 'Separator spacing', kind: 'slider', min: 0, max: 3, step: 0.05, default: SEPARATOR_DEFAULT_GAP,
    group: 'Type', showIf: { key: 'separator', notEquals: SHAPE_NONE } },
]

/** Tile-based effects only: raw-word effects have no tile gap, per-glyph effects never sample the tile. */
export function separatorEligible(effectId: string): boolean {
  return !RAW_WORD_EFFECTS.has(effectId) && !PER_GLYPH_EFFECTS.has(effectId)
}

/**
 * A NEW effect object with the controls appended (no mutation, so module
 * evaluation order cannot matter — see memory "eager module const + init
 * order"). Ineligible effects and already-injected ones are returned as-is.
 */
export function withSeparatorControls(effect: SpaceTypeEffect): SpaceTypeEffect {
  if (!separatorEligible(effect.id)) return effect
  if (effect.controls.some(c => c.key === 'separator')) return effect
  return { ...effect, controls: [...effect.controls, ...SEPARATOR_CONTROLS] }
}

export interface SeparatorSpec {
  shape: LibraryShape
  /** Fraction of cap height. */
  size: number
  /** Quarter-ems on each side of the shape. */
  gap: number
}

/** Undefined for none, an unknown id (catalog churn degrades to no separator), or an ineligible effect. */
export function separatorFromParams(effectId: string, p: Params): SeparatorSpec | undefined {
  if (!separatorEligible(effectId)) return undefined
  const id = String(p.separator ?? SHAPE_NONE)
  if (id === SHAPE_NONE) return undefined
  const shape = shapeById(id)
  if (!shape) return undefined
  const size = Number(p.separatorSize)
  const gap = Number(p.separatorGap)
  return {
    shape,
    size: Number.isFinite(size) ? size : SEPARATOR_DEFAULT_SIZE,
    gap: Number.isFinite(gap) ? gap : SEPARATOR_DEFAULT_GAP,
  }
}
```

- [ ] **Step 4: Inject at registration**

In `frontend/app/lib/spacetype/effects/index.ts`, add after the last effect import:

```ts
import { withSeparatorControls } from '../separator'
```

Change the array declaration so it maps every effect (keep the list exactly as it is; only the wrapper changes):

```ts
/** All registered Space Type effects, in picker order. Add new effect modules here.
 *  Every entry passes through withSeparatorControls, which appends the shared
 *  separator controls to tile-based effects — declare the controls ONCE there,
 *  not per effect. */
export const SPACE_TYPE_EFFECTS: SpaceTypeEffect[] = [
  ribbonEffect,
  // … existing entries unchanged …
  slotEffect,
].map(withSeparatorControls)
```

- [ ] **Step 5: Wire `texOptsFromState`**

In `frontend/app/lib/spacetype/state.ts`:

Replace the import line `import { defaultsFromControls } from './effect'` with:

```ts
import { defaultsFromControls, RAW_WORD_EFFECTS } from './effect'
import { separatorFromParams } from './separator'
```

Delete the local line `const RAW_WORD_EFFECTS = new Set(['coil', 'elastic', 'echo'])` (line 96).

In `defaultSpaceTypeState`, change `params: defaultsFromControls(ribbonEffect.controls),` to:

```ts
    params: defaultsFromControls(getEffect('ribbon').controls),
```

(so defaults include `separator: 'none'`; `ribbonEffect` may now be unused in this file — remove it from the `./effects/ribbon` import if nothing else references it, keeping `buildRibbonLabel`).

In the object `texOptsFromState` returns, add after `uRepeat: Number(p.textRepeat),`:

```ts
    separator: separatorFromParams(effect.id, p),
```

- [ ] **Step 6: Wire the embed builder**

In `frontend/app/lib/embed/surfaces/spacetype.ts`:

Change `import type { SpaceTypeEffect, Params } from '~/lib/spacetype/effect'` to:

```ts
import { RAW_WORD_EFFECTS, type SpaceTypeEffect, type Params } from '~/lib/spacetype/effect'
import { separatorFromParams } from '~/lib/spacetype/separator'
```

Delete the local `const RAW_WORD_EFFECTS = new Set(['coil', 'elastic', 'echo'])` (line 59) and trim its comment to point at `effect.ts`.

In `buildTexOpts`'s returned object add after `uRepeat: Number(params.textRepeat),`:

```ts
    separator: separatorFromParams(effect.id, params),
```

`TextTextureOptions` does not have `separator` yet — Task 6 adds it. To keep this task green on its own, add the field to `frontend/app/lib/spacetype/textTexture.ts` now (Task 6 implements the painting):

```ts
import type { SeparatorSpec } from './separator'
// …inside TextTextureOptions, after uRepeat?: number
  /** Shape painted between word repeats — see separator.ts. Undefined ⇒ byte-identical tile to before. */
  separator?: SeparatorSpec
```

- [ ] **Step 7: Run the new test plus the suites that touch these files**

Run: `cd frontend && pnpm vitest run tests/unit/spacetype-separator-controls.unit.spec.ts tests/unit/spacetype-sections.unit.spec.ts tests/unit/embed-spacetype.unit.spec.ts tests/unit/run-state.unit.spec.ts`
Expected: PASS. The sections test still passes because `Type` is a listed group.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/lib/spacetype/separator.ts frontend/app/lib/spacetype/effects/index.ts frontend/app/lib/spacetype/state.ts frontend/app/lib/embed/surfaces/spacetype.ts frontend/app/lib/spacetype/textTexture.ts frontend/tests/unit/spacetype-separator-controls.unit.spec.ts
git commit -m "feat(spacetype): separator controls injected once at registration; one resolver feeds both tile builders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Paint the separator into the tile

**Files:**
- Modify: `frontend/app/lib/spacetype/textTexture.ts` (`makeTextTexture`)
- Test: `frontend/tests/unit/spacetype-separator-tile.unit.spec.ts`

**Interfaces:**
- Consumes: `TextTextureOptions.separator?: SeparatorSpec` (Task 5), `drawShape`, `shapeAspect` (Task 3).
- Produces: tile layout `[text][gap][shape][gap]`; `userData.wordFracs` / `wordInkFracs` computed over the full tile.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/spacetype-separator-tile.unit.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

// makeTextTexture draws to document.createElement('canvas'); node has no canvas,
// so a recording fake stands in. Text measures 10px per character, cap height 50.
class FakeCtx {
  ops: any[] = []
  font = ''; fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 0; lineJoin = 'miter'
  textBaseline = 'alphabetic'; textAlign = 'left'; letterSpacing = '0px'
  measureText(t: string) { return { width: t.length * 10, actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 10 } }
  fillText(t: string, x: number, y: number) { this.ops.push(['fillText', t, x, y]) }
  strokeText(t: string, x: number, y: number) { this.ops.push(['strokeText', t, x, y]) }
  setTransform() {}
  clearRect() {}
  save() {} restore() {}
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p?.d, this.strokeStyle]) }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }

const shape: LibraryShape = { id: 'half', name: 'Half', d: 'M0,0L50,0L50,100L0,100Z', fillRule: 'nonzero', box: [0, 0, 50, 100], sourceColor: '#000' }

let last: FakeCanvas
beforeAll(() => {
  ;(globalThis as any).Path2D = FakePath2D
  vi.stubGlobal('document', { createElement: () => (last = new FakeCanvas()) })
})
afterAll(() => vi.unstubAllGlobals())

const base = {
  label: 'SAILOR   ', fontFamily: 'Inter', fontWeight: 700, axes: {}, typeColor: '#ff0000', heightPx: 256, fontSizePx: 100,
}

describe('makeTextTexture without a separator', () => {
  it('is the old tile: width = label width, no path fill', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    const tex = makeTextTexture({ ...base })
    expect(last.width).toBe(90)                       // 'SAILOR   ' = 9 chars × 10
    expect(tex.userData.wordFracs).toEqual([1])
    expect(tex.userData.wordInkFracs[0]).toBeCloseTo(60 / 90, 6)
    expect(last.ctx.ops.some(o => o[0] === 'fill')).toBe(false)
    expect(last.ctx.ops.find(o => o[0] === 'fillText')?.[1]).toBe('SAILOR   ')
  })
})

describe('makeTextTexture with a separator', () => {
  it('lays the tile out as text, gap, shape, gap', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    // size 1 ⇒ shapeH = cap 50, aspect 0.5 ⇒ shapeW 25; gap 1 ⇒ 0.25 × fontSizePx 100 = 25 each side
    const tex = makeTextTexture({ ...base, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(60 + 25 + 25 + 25)        // 135
    expect(tex.userData.wordFracs).toEqual([1])
    expect(tex.userData.wordInkFracs[0]).toBeCloseTo((60 + 25 + 25) / 135, 6)
    const fill = last.ctx.ops.find(o => o[0] === 'fill')
    expect(fill).toEqual(['fill', shape.d, 'nonzero', '#ff0000'])
    // the text is drawn trimmed so the old trailing gap cannot double the spacing
    expect(last.ctx.ops.find(o => o[0] === 'fillText')?.[1]).toBe('SAILOR')
    // the shape's target box starts after text + gap; translate x = 85 - box.x×scale (box.x is 0)
    const tr = last.ctx.ops.find(o => o[0] === 'translate')
    expect(tr?.[1]).toBeCloseTo(85, 6)
  })
  it('strokes the shape when the type has a stroke', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, strokeWidth: 3, strokeColor: '#000000', separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.some(o => o[0] === 'stroke' && o[1] === shape.d)).toBe(true)
  })
  it('paints one shape per row of a multi-text atlas', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, labels: ['SAILOR   ', 'SEA   '], separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.filter(o => o[0] === 'fill').length).toBe(2)
    expect(last.width).toBe(135)                      // widest row wins
  })
  it('scaleX widens the canvas for the whole tile', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, scaleX: 2, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(270)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/spacetype-separator-tile.unit.spec.ts`
Expected: the "without" block passes; the "with" block FAILS (width 90, no fill op).

- [ ] **Step 3: Implement the painting**

In `frontend/app/lib/spacetype/textTexture.ts`:

Add the import:

```ts
import { drawShape, shapeAspect } from '~/lib/shapes/path2d'
```

Replace the block from `applyFont()` / `const widths = …` through the `wordInkFracs` computation with:

```ts
  applyFont()
  const sep = opts.separator
  // Per-row TEXT width. With a separator the trailing gap that buildRibbonLabel
  // appends is discarded — the tile becomes [text][gap][shape][gap] and the gap
  // is the separator's own. Without one, the label (gap included) is measured
  // exactly as before, so the old tile is byte-identical.
  const textWidths = labels.map(l => Math.max(1, ctx.measureText(sep ? l.trimEnd() : l).width))
  let shapeW = 0, shapeH = 0, gapPx = 0
  if (sep) {
    const m = ctx.measureText((labels[0] ?? ' ').trimEnd())
    const cap = (m as TextMetrics).actualBoundingBoxAscent || fontPx * 0.72
    shapeH = cap * sep.size
    shapeW = shapeH * shapeAspect(sep.shape)
    gapPx = sep.gap * fontPx * 0.25
  }
  const sepExtra = sep ? gapPx * 2 + shapeW : 0
  const widths = textWidths.map(w => w + sepExtra)
  const maxLabelW = Math.max(...widths, 1)
```

Keep the existing `naturalWidthFrac` block unchanged (it measures `labels[0]` tracked vs untracked; with a separator use `textWidths[0]` in place of `widths[0]` for the divisor):

```ts
    naturalWidthFrac = untracked / (sep ? textWidths[0]! : widths[0]!)
```

Keep `measured`, `w`, `wordFracs` as they are. Replace the `wordInkFracs` line with:

```ts
  // Word INK fraction: visible content ÷ its tile. With a separator the ink runs
  // from the first letter through the shape (one leading gap included, the
  // trailing one excluded) so an effect that centres a repeat centres the unit.
  const wordInkFracs = labels.map((l, k) => {
    const ink = sep ? textWidths[k]! + gapPx + shapeW : Math.max(1, ctx.measureText(l.trimEnd()).width)
    return Math.min(1, ink / widths[k]!)
  })
```

In the draw loop, replace the body of `labels.forEach((label, k) => { … })` with:

```ts
  labels.forEach((label, k) => {
    const cy = (n - 1 - k) * rowH + rowH / 2
    const drawn = sep ? label.trimEnd() : label
    ctx.setTransform(scaleX, 0, 0, 1, 0, 0)
    applyFont()
    if ((opts.strokeWidth ?? 0) > 0) {
      ctx.lineWidth = opts.strokeWidth as number
      ctx.strokeStyle = opts.strokeColor ?? '#000000'
      ctx.lineJoin = 'round'
      ctx.strokeText(drawn, 0, cy)
    }
    ctx.fillText(drawn, 0, cy)
    if (sep) {
      // Centre the shape on the text's ink midline (baseline 'middle' puts the em
      // box centre at cy; the measured cap/descender pair shifts it to the letters).
      const mid = cy + (desc0 - asc0) / 2
      drawShape(ctx, sep.shape, {
        x: textWidths[k]! + gapPx, y: mid - shapeH / 2, w: shapeW, h: shapeH,
        fill: opts.typeColor,
        stroke: (opts.strokeWidth ?? 0) > 0 ? { color: opts.strokeColor ?? '#000000', width: opts.strokeWidth as number } : undefined,
      })
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  })
```

`asc0` / `desc0` are already computed above the canvas sizing from `labels[0]`; they stay as they are.

- [ ] **Step 4: Run the tile test and the ribbon-math suite**

Run: `cd frontend && pnpm vitest run tests/unit/spacetype-separator-tile.unit.spec.ts tests/unit/spacetype-ribbon-math.unit.spec.ts`
Expected: PASS. If `translate` x is off, check that `drawShape` receives `x = textWidths[k] + gapPx` (85) and `box[0] = 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/spacetype/textTexture.ts frontend/tests/unit/spacetype-separator-tile.unit.spec.ts
git commit -m "feat(spacetype): paint the separator shape into the tile — text, gap, shape, gap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: ShapePicker, RowShape, and the Space Type panel branch

**Files:**
- Create: `frontend/app/components/vue-canvas/studio/ShapePicker.vue`
- Create: `frontend/app/components/vue-canvas/studio/rows/RowShape.vue`
- Modify: `frontend/app/components/vue-canvas/studio/rows/registry.ts`
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` (label exclusion at line ~1911; new branch next to the `text` StudioRow branch at ~1934)
- Test: `frontend/tests/unit/shape-picker.unit.spec.ts`

**Interfaces:**
- Consumes: catalog (Task 2), `ControlSpec` `shape` member (Task 4).
- Produces: `ShapePicker` props `{ modelValue: string; allowNone?: boolean; anchor: { x: number; y: number } }`, emits `update:modelValue(string)`, `close()`. `RowShape` follows the registry contract `{ value, spec, step, editing }` → `update:value`.

- [ ] **Step 1: Write the failing component test**

`frontend/tests/unit/shape-picker.unit.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ShapePicker from '../../app/components/vue-canvas/studio/ShapePicker.vue'

const mountPicker = (props: Partial<{ modelValue: string; allowNone: boolean }> = {}) =>
  mount(ShapePicker, {
    props: { modelValue: 'none', anchor: { x: 10, y: 10 }, ...props },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  })

describe('ShapePicker', () => {
  it('shows a None tile, all 100 shapes, and marks the current one', () => {
    const w = mountPicker({ modelValue: 'sparkle' })
    expect(w.find('[data-shape="none"]').exists()).toBe(true)
    expect(w.findAll('[data-shape]').length).toBe(101)
    expect(w.find('[data-shape="sparkle"]').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })
  it('hides None when allowNone is false', () => {
    const w = mountPicker({ allowNone: false })
    expect(w.find('[data-shape="none"]').exists()).toBe(false)
    expect(w.findAll('[data-shape]').length).toBe(100)
    w.unmount()
  })
  it('filters by search and by family', async () => {
    const w = mountPicker()
    await w.find('input[type="search"]').setValue('sun')
    const ids = w.findAll('[data-shape]').map(b => b.attributes('data-shape'))
    expect(ids).toContain('sun-rays')
    expect(ids).not.toContain('circle')
    await w.find('input[type="search"]').setValue('')
    await w.find('[data-family="diagram"]').trigger('click')
    expect(w.findAll('[data-shape]').map(b => b.attributes('data-shape'))).toEqual(['none', 'circle-network', 'diagram-venn', 'pie-chart', 'stairs'])
    w.unmount()
  })
  it('emits the picked id and closes', async () => {
    const w = mountPicker()
    await w.find('[data-shape="sparkle"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['sparkle']])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
  it('closes on Escape', async () => {
    const w = mountPicker()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/shape-picker.unit.spec.ts`
Expected: FAIL — cannot resolve `ShapePicker.vue`.

- [ ] **Step 3: Write the picker**

`frontend/app/components/vue-canvas/studio/ShapePicker.vue`:

```vue
<script setup lang="ts">
/**
 * The shape library picker — ONE component for every `shape` control (Space
 * Type's separator today; Compositor, Shape Studio and 3D Studio next). A
 * teleported, viewport-clamped floating panel anchored to its row, closed by
 * Escape or a click outside (the SweepPopover / CanvasContextMenu conventions).
 *
 * Thumbnails are inline SVG in `currentColor`: the shape's source colour is a
 * hint in the manifest, never something the picker shows.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { SHAPE_FAMILIES, SHAPE_NONE, familyOf, searchShapes, type ShapeFamily } from '~/lib/shapes/catalog'

const props = withDefaults(defineProps<{
  modelValue: string
  allowNone?: boolean
  anchor: { x: number; y: number }
}>(), { allowNone: true })
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'close'): void }>()

const query = ref('')
const family = ref<ShapeFamily | 'all'>('all')
const rail = computed(() => [{ id: 'all' as const, label: 'All' }, ...SHAPE_FAMILIES])
const visible = computed(() =>
  searchShapes(query.value).filter(s => family.value === 'all' || familyOf(s.id) === family.value),
)

function pick(id: string) {
  emit('update:modelValue', id)
  emit('close')
}

const rootRef = ref<HTMLDivElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const pos = ref({ x: props.anchor.x, y: props.anchor.y })
onMounted(() => {
  nextTick(() => {
    const el = rootRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = props.anchor.x, y = props.anchor.y
    if (x + r.width + 8 > window.innerWidth) x = Math.max(8, window.innerWidth - r.width - 8)
    if (y + r.height + 8 > window.innerHeight) y = Math.max(8, window.innerHeight - r.height - 8)
    pos.value = { x, y }
    searchRef.value?.focus()
  })
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); emit('close') }
}
function onOutside(e: MouseEvent) {
  if (rootRef.value?.contains(e.target as Node)) return
  emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onOutside, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onOutside, true)
})

const tile = 'flex h-9 w-9 items-center justify-center rounded-md transition-colors'
const tileIdle = 'text-white/70 hover:bg-white/10 hover:text-white'
const tileOn = 'bg-white text-neutral-900'
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootRef"
      class="fixed z-[210] w-[360px] rounded-lg border border-white/10 bg-[#141414] p-2 text-[12px] text-white/90 shadow-2xl"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      role="dialog"
      aria-label="Choose a shape"
    >
      <input
        ref="searchRef"
        v-model="query"
        type="search"
        placeholder="Search shapes"
        spellcheck="false"
        class="mb-2 h-7 w-full rounded-[6px] bg-white/[0.06] px-2 text-[11px] text-white/90 outline-none placeholder:text-white/30 focus:bg-white/[0.10]"
      />
      <div class="flex gap-2">
        <div class="flex w-24 shrink-0 flex-col gap-0.5">
          <button
            v-for="f in rail" :key="f.id" type="button"
            :data-family="f.id"
            class="rounded px-2 py-1 text-left text-[11px] transition-colors"
            :class="family === f.id ? 'bg-white text-neutral-900' : 'text-white/55 hover:bg-white/10 hover:text-white/90'"
            @click="family = f.id"
          >{{ f.label }}</button>
        </div>
        <div class="grid max-h-64 flex-1 grid-cols-5 content-start gap-1 overflow-y-auto pr-1">
          <button
            v-if="allowNone" type="button" data-shape="none" title="None"
            :aria-pressed="modelValue === SHAPE_NONE ? 'true' : 'false'"
            :class="[tile, modelValue === SHAPE_NONE ? tileOn : tileIdle]"
            @click="pick(SHAPE_NONE)"
          ><span class="text-[11px]">None</span></button>
          <button
            v-for="s in visible" :key="s.id" type="button" :data-shape="s.id" :title="s.name"
            :aria-pressed="modelValue === s.id ? 'true' : 'false'"
            :class="[tile, modelValue === s.id ? tileOn : tileIdle]"
            @click="pick(s.id)"
          >
            <svg viewBox="0 0 96 96" width="26" height="26" fill="currentColor" aria-hidden="true">
              <path :d="s.d" :fill-rule="s.fillRule" />
            </svg>
          </button>
          <p v-if="!visible.length" class="col-span-5 py-4 text-center text-[11px] text-white/40">No shapes match.</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 4: Write the row renderer and register it**

`frontend/app/components/vue-canvas/studio/rows/RowShape.vue`:

```vue
<script setup lang="ts">
// Value side of a `shape` row: the current shape as a 16px glyph plus its name
// (or "None"), which opens the shared ShapePicker under the row. The row shell
// (StudioRow) draws the label; this renders only the value, like every renderer.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { shapeById } from '~/lib/shapes/catalog'
import ShapePicker from '../ShapePicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const current = computed(() => shapeById(String(props.value)))
const allowNone = computed(() => (props.spec as { allowNone?: boolean }).allowNone !== false)
const open = ref(false)
const anchor = ref({ x: 0, y: 0 })

function openPicker(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  anchor.value = { x: r.right - 360, y: r.bottom + 4 }
  open.value = true
}
</script>

<template>
  <button
    type="button"
    :aria-label="spec.label"
    class="flex h-6 items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] text-white/90 transition-colors hover:bg-white/[0.06]"
    @pointerdown.stop
    @click="openPicker"
  >
    <svg v-if="current" viewBox="0 0 96 96" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path :d="current.d" :fill-rule="current.fillRule" />
    </svg>
    <span>{{ current ? current.name : 'None' }}</span>
  </button>
  <ShapePicker
    v-if="open"
    :model-value="String(value)"
    :allow-none="allowNone"
    :anchor="anchor"
    @update:model-value="(v: string) => emit('update:value', v)"
    @close="open = false"
  />
</template>
```

In `frontend/app/components/vue-canvas/studio/rows/registry.ts` add the import and the entry:

```ts
import RowShape from './RowShape.vue'
// …
export const rowRenderers: Record<string, Component> = {
  slider: RowSlider,
  select: RowSelect,
  switch: RowSwitch,
  color: RowColor,
  text: RowText,
  shape: RowShape,
}
```

and update the doc comment on `resolveRowRenderer` from "covers five" to "covers six" and drop nothing else.

- [ ] **Step 5: Add the panel branch in SpaceTypeSurface**

In `frontend/app/components/vue-canvas/SpaceTypeSurface.vue`:

Change the caption exclusion (line ~1911) from

```vue
<label v-if="!['slider', 'font', 'text'].includes(c.kind)" …
```

to

```vue
<label v-if="!['slider', 'font', 'text', 'shape'].includes(c.kind)" …
```

Directly after the `text` `StudioRow` block (the one ending with `@go-to-collection="goToCollection" />`) add:

```vue
              <!-- Shape (library picker): a self-labelled StudioRow whose value side is
                   RowShape. Not bindable to collections in v1 (controlKindToVariableType
                   returns null for 'shape'). -->
              <StudioRow
                v-else-if="c.kind === 'shape'"
                :spec="c"
                :model-value="String(params[c.key] ?? c.default)"
                :bindable="false"
                @update:model-value="(v) => { params[c.key] = String(v); rebuild(); onEdit(c.key, String(v)) }"
              />
```

- [ ] **Step 6: Run the picker test and typecheck the touched files**

Run: `cd frontend && pnpm vitest run tests/unit/shape-picker.unit.spec.ts`
Expected: PASS.

Run: `cd frontend && pnpm nuxt typecheck 2>&1 | grep -E "ShapePicker|RowShape|registry.ts|SpaceTypeSurface|separator.ts|textTexture.ts|catalog.ts|path2d.ts|controlDescriptor" || echo "no new errors in touched files"`
Expected: `no new errors in touched files`.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/components/vue-canvas/studio/ShapePicker.vue frontend/app/components/vue-canvas/studio/rows/RowShape.vue frontend/app/components/vue-canvas/studio/rows/registry.ts frontend/app/components/vue-canvas/SpaceTypeSurface.vue frontend/tests/unit/shape-picker.unit.spec.ts
git commit -m "feat(studio): ShapePicker + RowShape — the shape control kind gets a row and a popover

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Embed size gate, full unit run, live verification

**Files:**
- No source changes expected. Possibly `frontend/public/embed/*` regenerated (not committed if gitignored; check `git status`).

- [ ] **Step 1: Rebuild the embed bundles and run the size gate**

Run: `cd frontend && pnpm build:embed && pnpm vitest run tests/unit/embed-build-output.unit.spec.ts`
Expected: PASS. Report the new size of `public/embed/spacetype-boost.js` (largest) and `spacetype-ribbon.js`; both must be under 1,750,000 bytes. If boost trips the ceiling, the manifest is the only new weight: confirm the numbers are 2-decimal (Task 1) and report — do not raise the ceiling.

- [ ] **Step 2: Run the whole unit suite**

Run: `cd frontend && pnpm vitest run 2>&1 | tail -15`
Expected: all green. Check `uptime` load first if counts look off (memory: vitest counts lie under load).

- [ ] **Step 3: Live check in the browser pane**

Start the dev server via the Browser pane (`preview_start` with the `frontend` launch config; server on `http://127.0.0.1:3000`, never `localhost`). Open a project, add a Space Type node, open it in the studio with the Ribbon effect.

1. In the Type section, confirm a **Separator** row reading "None" and no Size/Spacing rows.
2. Click it, search "spark", pick **Sparkle**. Confirm the ribbon now reads word, shape, word; Size and Spacing rows appear.
3. Change **Type colour**: the shape follows.
4. Turn the gradient on: the shape is banded like the letters.
5. Set **Type stroke** to 4: the shape gets the outline.
6. Set Separator back to None: the three-space gap returns, Size/Spacing hide.
7. Switch to **Coil**: no Separator row. Switch to **Ring**: no Separator row. Switch to **Ticker**: Separator row present and the shape rides the band.
8. Take a screenshot at step 2 and at step 7 (Ticker) and send them with `SendUserFile`.

- [ ] **Step 4: Headless parity**

With the ribbon + sparkle document from step 2, trigger the node's render / bake (the Space Type node's Render footer) and open the produced PNG. The separator must be present. If the bake path is unclear, run the export from the studio's Output section and check the first exported frame.

- [ ] **Step 5: Commit anything the run produced that belongs in git**

Run: `git status --short` and stage only files this plan created or modified (embed outputs under `public/embed` are build products; leave them unless already tracked and changed by design). If nothing is left to commit, say so.

---

## Self-review

**Spec coverage.** A1 build script → Task 1. A2 catalog → Task 2. A3 canvas helper → Task 3. A4 picker + row + registry → Task 7. A5 control kind + describer + panel branch → Tasks 4 and 7. B1 controls injected once + showIf → Task 5. B2 tile painter → Task 6. B3 one builder (and the embed's mirror) → Task 5. B4 agent path → Task 4 (no new capability entry needed). "What stays identical" → Task 6 test block one + Task 5 `separator` undefined at defaults. Error handling: build failures (Task 1), unknown id degrades (Task 5), zero box no-op (Task 3). Testing section → every listed spec test has a task; live check and headless parity → Task 8.

**Deviations from the spec, deliberate:** types live in `shared/shape-library.ts` (mirrors `shared/library-fonts.ts`) and are re-exported from the catalog; the selected picker tile uses the existing white `StudioSegmented` chip rather than a new blue treatment, keeping one selection idiom in the studio panel; `withSeparatorControls` returns a new object instead of mutating, so import order can never matter.

**Type consistency.** `SeparatorSpec { shape, size, gap }` is produced by `separatorFromParams` (Task 5), carried on `TextTextureOptions.separator` (Task 5 adds the field, Task 6 reads it), and consumed by `drawShape(ctx, shape, { x, y, w, h, fill, stroke })` (Task 3). `shapeOptions(allowNone)` (Task 2) is what `describeControls` (Task 4) calls. `RAW_WORD_EFFECTS` / `PER_GLYPH_EFFECTS` are exported from `effect.ts` (Task 4) and imported by `separator.ts`, `state.ts` and the embed (Task 5).
