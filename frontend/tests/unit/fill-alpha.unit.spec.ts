import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fillPrimary, fillAlpha, fillTextColor, fillTextAlpha } from '~/lib/spacetype/fills'
import { hexBytes, DEFAULT_FILL, type Fill } from '~/lib/spacetype/fillTile'

const solid = (a: string): Fill => ({ ...DEFAULT_FILL, type: 'solid', a })

describe('fillAlpha', () => {
  it('is 1 for a legacy 6-digit fill', () => {
    expect(fillAlpha(solid('#ff0000'))).toBe(1)
  })
  it('reads alpha from an 8-digit fill', () => {
    expect(fillAlpha(solid('#ff000000'))).toBe(0)
    expect(fillAlpha(solid('#ff000080'))).toBeCloseTo(0.502, 3)
  })
})

describe('fillPrimary', () => {
  it('ignores alpha and returns the rgb — THREE.Color renders 8-digit hex as white', () => {
    const withA = fillPrimary(THREE, solid('#ff000080'))
    const without = fillPrimary(THREE, solid('#ff0000'))
    expect(withA.getHex()).toBe(without.getHex())
    expect(withA.getHex()).toBe(0xff0000)
  })
})

describe('hexBytes', () => {
  it('returns rgb bytes for 8-digit input rather than falling back to black', () => {
    expect(Array.from(hexBytes('#ff000080')).slice(0, 3)).toEqual([255, 0, 0])
  })
})

describe('fillTextColor', () => {
  it('ignores alpha and returns the rgb — THREE.Color renders 8-digit hex as white', () => {
    const withA = fillTextColor(THREE, { ...DEFAULT_FILL, textColor: '#ff000080' })
    const without = fillTextColor(THREE, { ...DEFAULT_FILL, textColor: '#ff0000' })
    expect(withA.getHex()).toBe(without.getHex())
    expect(withA.getHex()).toBe(0xff0000)
  })
})

describe('fillTextAlpha', () => {
  it('is 1 for a legacy 6-digit textColor', () => {
    expect(fillTextAlpha({ ...DEFAULT_FILL, textColor: '#ff0000' })).toBe(1)
  })
  it('reads alpha from an 8-digit textColor', () => {
    expect(fillTextAlpha({ ...DEFAULT_FILL, textColor: '#ff000080' })).toBeCloseTo(0.502, 3)
  })
})

// ── Static invariant: no THREE.Color ever built/mutated from an unstripped params colour ──────
//
// THREE.Color has no alpha channel and cannot parse 8-digit hex — given one it does NOT throw, it
// warns to the console and silently resolves to white. 8-digit hex (#rrggbbaa) is the storage
// format for Space Type colours once alpha is involved, so every `kind: 'color'` ControlSpec param
// can carry one. A control whose effect doesn't implement transparency must still render OPAQUE
// (correct RGB, alpha dropped) — never white. `stripAlpha` (~/lib/color/convert) is the fix; this
// test locks the invariant structurally instead of enumerating today's call sites, so a future
// effect (or a future edit to an existing one) can't reintroduce the bug unnoticed.
//
// This is a source-text scan (deliberately regex-based, not a full AST parse), so it cannot know
// which identifiers actually hold an unstripped colour. That makes the DEFAULT the whole design
// question, and this scan FAILS CLOSED: a site is an offender unless it can be shown safe. See
// isSafeColorArg below for why — two earlier prove-it's-tainted versions both shipped real bugs.
//
// It still runs a local taint propagation per file, but only to widen what counts as SAFE:
//   - an identifier is SAFE if its `const`/`let` initializer routes through `stripAlpha`/
//     `fillPrimary`/`fillTextColor`, so `const c = stripAlpha(params.x); ... .set(c)` passes.
//   - TAINTED is retained for diagnostics and alias tracking, but no longer gates the verdict:
//     an argument the scan cannot positively clear is flagged regardless.
function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const COLOR_SAFE = /stripAlpha|fillPrimary|fillTextColor/
const COLOR_TRIGGER = /params\.|\bp\.|Color\b/
const HEX_LITERAL = /['"`]#[0-9a-fA-F]{3,8}['"`]/
// `const`/`let` NAME [: Type] = INIT — INIT stops at `;`/newline. A deliberately simple,
// single-line binding shape; multi-line initializers or destructuring fall outside it, which is
// fine for a heuristic that just needs a couple of fixed-point passes over real-world code.
const DECL_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g
// Every lib tree whose colours are edited through StudioColor. Scoping this to spacetype alone is
// what let the 3D Studio / Shape Studio white-render bug ship: the sweep was spacetype-only while
// the alpha picker went to all 11 surfaces that use StudioColor. Add a directory here whenever a
// new studio starts taking colours from a picker.
const SCANNED_DIRS = ['spacetype', 'scene3d', 'shapefx']
  .map(d => new URL(`../../app/lib/${d}/`, import.meta.url).pathname)
const LIB_ROOT = new URL('../../app/lib/', import.meta.url).pathname

function refsIdent(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text)
}

/** True when `argsText` (the raw text between a call's parens) is a SINGLE top-level
 *  argument — no comma outside any nested (), [], {}. `THREE.Color.prototype.set` takes
 *  exactly one argument (a Color/hex/string); it is `setRGB`/the constructor that take
 *  r,g,b separately. So on the SAME receiver shapes this scan matches (`.value.set(...)`,
 *  `.color.set(...)`) a Vector2/Vector3/Euler `.set(x, y[, z])` or a `Map.set(key, val)`
 *  is structurally distinguishable from a Color mutation by argument COUNT alone, with no
 *  need to know what the receiver actually is — narrower than excluding a receiver name or
 *  file, and it stays correct for any future non-Color `.set()` sharing this shape, not
 *  just today's. (`new THREE.Color(r, g, b)` IS a valid 3-argument Color constructor call,
 *  so this narrowing is intentionally NOT applied to the constructor scan below.) */
function isSingleArgCall(argsText: string): boolean {
  let depth = 0
  for (const ch of argsText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) return false
  }
  return true
}

/** Local taint propagation for one file's source: which locals hold an unstripped colour
 *  (TAINTED) vs. which locals already had alpha stripped (SAFE). */
function scanLocals(src: string): { tainted: Set<string>; safe: Set<string> } {
  const decls: Array<{ name: string; init: string }> = []
  const re = new RegExp(DECL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) decls.push({ name: m[1]!, init: m[2]!.trim() })

  const tainted = new Set<string>()
  const safe = new Set<string>()
  // Fixed point over alias chains (a → b → c). Real code is a handful of hops deep at most.
  for (let pass = 0; pass < 5; pass++) {
    for (const { name, init } of decls) {
      if (safe.has(name) || tainted.has(name)) continue
      if (COLOR_SAFE.test(init)) { safe.add(name); continue }
      const fromParams = /params\.|\bp\./.test(init)
      const fromHexLiteral = HEX_LITERAL.test(init)
      const fromTainted = [...tainted].some(t => refsIdent(init, t))
      if (fromParams || fromHexLiteral || fromTainted) tainted.add(name)
    }
  }
  return { tainted, safe }
}

/** A THREE.Color argument is allowed ONLY if it is demonstrably safe.
 *
 *  Deliberately inverted from the obvious design. The previous version asked "does this argument
 *  look tainted?" and flagged only what matched — which let three real bugs ship (`strokeCol` in
 *  contour.ts and tunnel.ts, `tc` in streamer.ts), and a later review proved two more shapes walk
 *  straight past it:
 *      function faceMat(three, tint: string) { new three.Color(tint) }     // param-passed
 *      function buildC(three, opts: FaceOpts) { m.color.set(opts.tint) }   // param-passed
 *  Both are the existing house style (spiral.ts, streamer.ts), so an author copying local
 *  convention would reintroduce the bug invisibly. A guard whose default is "allow" fails OPEN,
 *  which is the wrong direction for a bug class that renders silently wrong instead of throwing.
 *
 *  So: every site is an offender unless it is a literal, an explicitly stripped expression, a
 *  local proven safe, or a reviewed ALLOWLIST entry. */
function isSafeColorArg(arg: string, locals: { tainted: Set<string>; safe: Set<string> }): boolean {
  const a = arg.trim()
  if (!a) return true                                            // new THREE.Color() — no colour
  if (COLOR_SAFE.test(a)) return true                            // stripAlpha/fillPrimary/fillTextColor
  if (/^0x[0-9a-fA-F]+$/.test(a)) return true                    // numeric literal, no alpha possible
  // r, g, b triple. Any 3-argument `new THREE.Color(r, g, b)` is the numeric RGB constructor —
  // an unstripped 8-digit hex is a single quoted string and can never appear as three channels,
  // so each channel may be a simple numeric-arithmetic expression (numbers, identifiers, + - * /,
  // parens, spaces). Quotes and `#` stay out of the channel class, and a single arg (no top-level
  // comma) still can't satisfy the three-part shape, so identifiers/hex aren't matched here.
  const CH = String.raw`[\w.$\s*/+()\-]+`
  if (new RegExp(`^${CH},${CH},${CH}$`).test(a)) return true
  if (/^['"`]#[0-9a-fA-F]{3,6}['"`]$/.test(a)) return true       // 6-digit hex literal
  if ([...locals.safe].some(s => refsIdent(a, s))) return true
  return false
}

// Reviewed exceptions, matched as a substring of "<relpath>: <arg>". Keep this SHORT — each entry
// is a site the guard cannot prove safe, so each is a standing promise that no picker colour
// reaches it. Past ~15 entries, real bugs are being allowlisted instead of fixed.
const ALLOWLIST: Array<{ match: string; why: string }> = [
  { match: 'shapefx/color.ts', why: 'ramp/palette hexes are generated by oklchToHex + harmonize from OKLCH sliders — no hex picker feeds them' },
  { match: 'shapefx/ombre.ts', why: 'consumes the same generated ramp hexes as shapefx/color.ts' },
  { match: 'materials.ts: .set(...gradientDirection', why: 'uDir is a direction Vector3, not a Colour — the .value.set() receiver shape cannot distinguish them' },
]
function allowed(entry: string): boolean { return ALLOWLIST.some(a => entry.includes(a.match)) }

describe('THREE.Color alpha safety (static scan)', () => {
  const files = SCANNED_DIRS.flatMap(walkTsFiles)
  // Guards against the scan passing vacuously (e.g. a directory-walk regression that silently
  // returns nothing, or a rename that moves the scanned tree out from under SPACETYPE_DIR). Floors
  // are well below the current real counts (59 files / 36 ctor sites / 15 .set() sites) — only a
  // broken walk trips them.
  const FILE_FLOOR = 20
  const SITE_FLOOR = 10

  it('scanned a non-trivial number of spacetype source files', () => {
    expect(files.length).toBeGreaterThan(FILE_FLOOR)
  })

  it('never constructs a THREE.Color from an unstripped params colour', () => {
    const offenders: string[] = []
    let sites = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const locals = scanLocals(src)
      const re = /new\s+(?:three|THREE)\.Color\(\s*([^)]*)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        sites++
        const arg = m[1]!
        const entry = `${f.replace(LIB_ROOT, '')}: new Color(${arg.trim()})`
        if (!isSafeColorArg(arg, locals) && !allowed(entry)) offenders.push(entry)
      }
    }
    expect(sites).toBeGreaterThan(SITE_FLOOR)
    expect(offenders).toEqual([])
  })

  it('never .set()s a THREE.Color uniform/material colour from an unstripped params colour', () => {
    const offenders: string[] = []
    let sites = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const locals = scanLocals(src)
      // Scoped to the three receiver shapes this codebase uses for a THREE.Color mutation: a
      // shader uniform's `.value`, a value already narrowed `as THREE.Color`/`as three.Color`, or
      // a material's `.color`. Deliberately NOT a bare `.set(` — that also matches Vector2/3,
      // Euler and Map (position.set(x,y,z), cache.set(key, val)), which would make this vacuous.
      const re = /(?:\.value|value\s+as\s+(?:THREE|three)\.Color\)|\.color)\.set(?:Style)?\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        // Balanced scan for the real argument list. A `([^)]*)` capture stops at the FIRST
        // `)`, so a nested call like `.set(Math.max(a, 1e-4), b)` came back as the single
        // pseudo-argument `Math.max(a, 1e-4` — no top-level comma left in it, so it read as
        // single-arg and was flagged as a Color mutation when it is a Vector2.set(x, y).
        const argStart = m.index + m[0].length
        let depth = 1, i = argStart
        for (; i < src.length && depth > 0; i++) {
          const ch = src[i]
          if (ch === '(') depth++
          else if (ch === ')') depth--
        }
        if (depth !== 0) continue // unterminated call — not parseable, not a colour site
        const arg = src.slice(argStart, i - 1)
        // A multi-argument `.set(...)` on this receiver shape is a Vector2/3/Euler `.set(x,y[,z])`
        // or a `Map.set(key, val)`, never `THREE.Color.prototype.set` (single-argument only) — see
        // isSingleArgCall's doc. Not a Color-mutation site at all, so it isn't counted or checked.
        if (!isSingleArgCall(arg)) continue
        sites++
        const entry = `${f.replace(LIB_ROOT, '')}: .set(${arg.trim()})`
        if (!isSafeColorArg(arg, locals) && !allowed(entry)) offenders.push(entry)
      }
    }
    expect(sites).toBeGreaterThan(SITE_FLOOR)
    expect(offenders).toEqual([])
  })
})
