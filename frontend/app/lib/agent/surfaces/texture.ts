/**
 * Texture studio agent surface (F1 / T1 — "unhide + describe Texture fills").
 *
 * The Texture studio has two layers of state: flat tunable params (driven by
 * TEXTURE_CONTROLS — palette, lattice, motif, …) AND per-ROLE fills
 * (params.fills: solid / gradient / image / pattern / link) that the tune path
 * could never see. This surface exposes BOTH through named, invertible commands
 * so one structural agent can say "make role A red", "give the ground a sunset
 * gradient", or "tighten the cells" in the same breath.
 *
 * State = the whole Params object (it carries `.fills` at runtime). Pure: every
 * function takes Params and returns data or a fresh Params.
 */
import type { Params, ParamValue } from '~/lib/spacetype/effect'
import type { Fill, FillsByRole, GradientStop } from '~/lib/texturefx/types'
import type { Command, CommandResult, CommandSpec, SurfaceSnapshot } from '~/lib/agent/commandSurface'
import { TEXTURE_CONTROLS, type TextureControl } from '~/lib/texturefx/controls'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'
import { activeFamily, rolesFor } from '~/lib/texturefx/roles'
import { fillForRole } from '~/lib/texturefx/fills'
import { applyGridTemplate } from '~/lib/texturefx/templates'
import { contrastRatio, parseColor, type LayoutIssue } from '~/lib/agent/verify'
import { SWISS_LIMITS } from '~/lib/agent/designPrinciples'

export interface TextureState { params: Params }

const HEX6 = /^#[0-9a-fA-F]{6}$/

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** The controls visible for the current params (mode/family gating). */
function activeControls(p: Params): TextureControl[] {
  return TEXTURE_CONTROLS.filter(c => !c.when || c.when(p))
}

function fillsOf(p: Params): FillsByRole {
  return ((p as unknown as { fills?: FillsByRole }).fills) ?? {}
}

/** A short, human-readable rendering of a resolved fill. */
function fillLabel(f: Fill): string {
  if (f.type === 'solid') return f.color
  if (f.type === 'gradient') return `${f.kind} gradient`
  if (f.type === 'image') return 'image'
  if (f.type === 'pattern') return 'pattern'
  return 'fill'
}

const TEXTURE_COMMANDS: CommandSpec[] = [
  { op: 'setFillColor', hint: 'Paint a ROLE a solid colour. target = role key (see the roles list); args: { color: "#RRGGBB", opacity? }. This is what "make role A red", "the ground should be cream" mean.' },
  { op: 'setFillGradient', hint: 'Give a ROLE a gradient. target = role key; args: { stops: [{color:"#RRGGBB", offset:0..1}, …], kind?: "linear"|"radial", angle?: deg, frame?: "cell"|"tile", opacity? }. Use for "fade the stripes from pink to orange".' },
  { op: 'setFill', hint: 'Set a ROLE\'s fill to a full Fill object (advanced). target = role key; args: { fill } where fill is a valid texture Fill (solid/gradient/pattern/link).' },
  { op: 'linkFill', hint: 'Make one ROLE reuse another role\'s fill. target = role key; args: { to: otherRoleKey }. Use for "make A and B the same".' },
  { op: 'setFillOpacity', hint: 'Set a ROLE fill\'s opacity. target = role key; args: { opacity: 0..1 }.' },
  { op: 'clearFill', hint: 'Reset a ROLE to its default colour (removes any custom fill). target = role key.' },
  { op: 'setParam', hint: 'Tune a flat control (palette/lattice/motif/cells/…). target = control key (see settings); args: { value }. Value is clamped to the control\'s range / options. Use for "tighter cells", "warmer palette" (colorA/colorB/background), "more jitter". In the dealt-grid mode, target "dgTemplate" with a value of "modular"/"oddgrid"/"parcel"/"mosh"/"static" applies a whole preset at once (cells + density + size variance + colours), and "dgVocab" ("brand"/"mono"/"warm"/"cool") recolours it.' },
  { op: 'restore', hint: 'internal — undo support.' },
]

/** Read the Texture studio as an agent snapshot: each role's resolved fill, a
 *  settings object listing tunable controls, and a document object. */
export function describeTexture(state: TextureState): SurfaceSnapshot {
  const p = state.params
  const roles = rolesFor(p)
  const objects: SurfaceSnapshot['objects'] = roles.map((rk, i) => {
    const raw = fillsOf(p)[rk]
    const resolved = fillForRole(p, rk, i)
    const cur: Record<string, unknown> = { fill: fillLabel(resolved), type: resolved.type }
    if (resolved.type === 'solid') cur.color = resolved.color
    if (raw?.type === 'link') cur.linkedTo = (raw as { to: string }).to
    if ('opacity' in resolved && resolved.opacity != null) cur.opacity = resolved.opacity
    return { id: rk, label: `role “${rk}”`, type: 'role', current: cur }
  })

  // Settings: the currently-tunable controls + their values (for setParam).
  const described = describeControls(activeControls(p), p)
  objects.push({
    id: 'settings',
    label: 'Tunable settings',
    type: 'settings',
    current: {
      controls: described.map(d => ({
        key: d.path, label: d.label, kind: d.kind, value: d.current,
        ...(d.min != null ? { min: d.min, max: d.max, step: d.step } : {}),
        ...(d.options ? { options: d.options } : {}),
      })),
    },
  })

  objects.push({
    id: 'document', label: 'Texture', type: 'document',
    current: { mode: p.mode, family: activeFamily(p), roles, palette: { colorA: p.colorA, colorB: p.colorB, background: p.background } },
  })
  return { surface: 'texture', objects, commands: TEXTURE_COMMANDS }
}

function setFills(p: Params, fills: FillsByRole): Params {
  return { ...p, fills } as unknown as Params
}

/** Inverse that restores the whole fills map (fill ops are easier to revert as a
 *  set than per-key, because of links + legacy fallbacks). */
function fillsSnapshot(input: Params): Command {
  return { op: 'restore', args: { fills: clone(fillsOf(input)) } }
}

function isValidFill(f: unknown): f is Fill {
  if (!f || typeof f !== 'object') return false
  const t = (f as { type?: string }).type
  return t === 'solid' || t === 'gradient' || t === 'image' || t === 'pattern' || t === 'link'
}

/** Apply one command to the Texture studio, returning new params + an inverse.
 *  Pure — the input is never mutated. */
export function applyTextureCommand(input: TextureState, cmd: Command): CommandResult<TextureState> {
  const p = input.params
  const roles = rolesFor(p)
  const requireRole = (): string | null => (typeof cmd.target === 'string' && roles.includes(cmd.target) ? cmd.target : null)
  const writeFill = (rk: string, fill: Fill): CommandResult<TextureState> => {
    const fills = { ...fillsOf(p), [rk]: clone(fill) }
    return { ok: true, template: { params: setFills(p, fills) }, inverse: fillsSnapshot(p) }
  }

  switch (cmd.op) {
    case 'setFillColor': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}' (roles: ${roles.join(', ')})` }
      const color = cmd.args?.color
      if (typeof color !== 'string' || !HEX6.test(color)) return { ok: false, reason: 'invalid', detail: 'args.color must be "#RRGGBB"' }
      const fill: Fill = { type: 'solid', color }
      if (typeof cmd.args?.opacity === 'number') fill.opacity = Math.min(1, Math.max(0, cmd.args.opacity))
      return writeFill(rk, fill)
    }
    case 'setFillGradient': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}'` }
      const rawStops = cmd.args?.stops as { color?: string; offset?: number }[] | undefined
      if (!Array.isArray(rawStops) || rawStops.length < 2) return { ok: false, reason: 'invalid', detail: 'args.stops needs ≥2 {color,offset}' }
      const stops: GradientStop[] = []
      for (const s of rawStops) {
        if (typeof s?.color !== 'string' || !HEX6.test(s.color)) return { ok: false, reason: 'invalid', detail: `bad stop colour ${String(s?.color)}` }
        stops.push({ c: s.color, p: Math.min(1, Math.max(0, Number(s.offset ?? 0))) })
      }
      const kind = cmd.args?.kind === 'radial' ? 'radial' : 'linear'
      const frame = cmd.args?.frame === 'tile' ? 'tile' : 'cell'
      const fill: Fill = { type: 'gradient', frame, kind, angle: Number(cmd.args?.angle ?? 0), stops }
      if (typeof cmd.args?.opacity === 'number') fill.opacity = Math.min(1, Math.max(0, cmd.args.opacity))
      return writeFill(rk, fill)
    }
    case 'setFill': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}'` }
      const fill = cmd.args?.fill
      if (!isValidFill(fill)) return { ok: false, reason: 'invalid', detail: 'args.fill is not a valid Fill' }
      if (fill.type === 'link' && !roles.includes((fill as { to: string }).to)) return { ok: false, reason: 'invalid', detail: `link target '${(fill as { to: string }).to}' is not a role` }
      return writeFill(rk, fill)
    }
    case 'linkFill': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}'` }
      const to = cmd.args?.to
      if (typeof to !== 'string' || !roles.includes(to)) return { ok: false, reason: 'invalid', detail: `args.to must be a role (${roles.join(', ')})` }
      if (to === rk) return { ok: false, reason: 'invalid', detail: 'cannot link a role to itself' }
      return writeFill(rk, { type: 'link', to } as Fill)
    }
    case 'setFillOpacity': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}'` }
      const opacity = cmd.args?.opacity
      if (typeof opacity !== 'number') return { ok: false, reason: 'invalid', detail: 'args.opacity must be a number 0..1' }
      const cur = fillForRole(p, rk, roles.indexOf(rk))
      if (cur.type === 'link') return { ok: false, reason: 'invalid', detail: 'cannot set opacity on a linked role' }
      return writeFill(rk, { ...cur, opacity: Math.min(1, Math.max(0, opacity)) } as Fill)
    }
    case 'clearFill': {
      const rk = requireRole(); if (!rk) return { ok: false, reason: 'invalid', detail: `no role '${String(cmd.target)}'` }
      const fills = { ...fillsOf(p) }
      if (!(rk in fills)) return { ok: false, reason: 'invalid', detail: `role '${rk}' has no custom fill` }
      delete fills[rk]
      return { ok: true, template: { params: setFills(p, fills) }, inverse: fillsSnapshot(p) }
    }
    case 'setParam': {
      const key = cmd.target
      if (typeof key !== 'string') return { ok: false, reason: 'invalid', detail: 'missing target (control key)' }
      const described = describeControls(activeControls(p), p)
      const value = cmd.args?.value as ParamValue | undefined
      if (value === undefined) return { ok: false, reason: 'invalid', detail: 'missing args.value' }
      const valid = validatePatch({ [key]: value }, described)
      if (!(key in valid)) return { ok: false, reason: 'invalid', detail: `'${key}' is not a tunable control here, or the value is out of range` }
      // The dealt-grid Template select expands into several dials — apply it rather
      // than store a lone selector value (which would be a no-op on the render). The
      // inverse restores every key the expansion touched, so undo is exact.
      if (key === 'dgTemplate') {
        const touched = ['dgTemplate', 'dgCells', 'dgDensity', 'dgSizeVar', 'dgVocab']
        const before: Record<string, ParamValue> = {}
        for (const k of touched) before[k] = p[k] as ParamValue
        const next = applyGridTemplate({ ...p }, String(valid[key]))
        return { ok: true, template: { params: next }, inverse: { op: 'restore', args: { params: before } } }
      }
      const old = p[key]
      return { ok: true, template: { params: { ...p, [key]: valid[key]! } }, inverse: { op: 'setParam', target: key, args: { value: old as ParamValue } } }
    }
    case 'restore': {
      if (cmd.args && 'fills' in cmd.args) return { ok: true, template: { params: setFills(p, clone(cmd.args.fills as FillsByRole)) }, inverse: fillsSnapshot(p) }
      // Multi-key param restore — the inverse of a template expansion (which changes
      // several dials at once). Merges the saved key/values back over the params.
      if (cmd.args && 'params' in cmd.args) {
        const patch = clone(cmd.args.params as Record<string, ParamValue>)
        const before: Record<string, ParamValue> = {}
        for (const k of Object.keys(patch)) before[k] = p[k] as ParamValue
        return { ok: true, template: { params: { ...p, ...patch } }, inverse: { op: 'restore', args: { params: before } } }
      }
      return { ok: false, reason: 'invalid', detail: 'restore needs args.fills or args.params' }
    }
    default:
      return { ok: false, reason: 'out-of-vocabulary', detail: `unknown op '${cmd.op}'` }
  }
}

/** Postcondition checks: roles whose fills are too close to read against each
 *  other, or a palette busier than Swiss restraint allows. Pure; warnings only. */
export function verifyTexture(state: TextureState): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const p = state.params
  const roles = rolesFor(p)
  const solids: { rk: string; c: { r: number; g: number; b: number } }[] = []
  for (let i = 0; i < roles.length; i++) {
    const f = fillForRole(p, roles[i]!, i)
    if (f.type === 'solid') { const c = parseColor(f.color); if (c) solids.push({ rk: roles[i]!, c }) }
  }
  // Two solid roles nearly identical → the pattern won't read.
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const ratio = contrastRatio(solids[i]!.c, solids[j]!.c)
      if (ratio < 1.15) issues.push({ level: 'warn', message: `roles “${solids[i]!.rk}” and “${solids[j]!.rk}” are nearly the same colour — the pattern may not be visible` })
    }
  }
  const distinct = new Set(solids.map(s => `${s.c.r},${s.c.g},${s.c.b}`))
  if (distinct.size > SWISS_LIMITS.maxColours) issues.push({ level: 'warn', message: `${distinct.size} fill colours in use — Swiss style favours restraint` })
  return issues
}

/** Human-readable summary of a command for the proposal UI. */
export function summarizeTextureChange(state: TextureState, cmd: Command): { label: string; before: string; after: string } | null {
  const p = state.params
  const roles = rolesFor(p)
  const roleIdx = (rk?: string) => (rk ? roles.indexOf(rk) : -1)
  const a = cmd.args ?? {}
  switch (cmd.op) {
    case 'setFillColor': return { label: `role ${cmd.target}`, before: roleIdx(cmd.target) >= 0 ? fillLabel(fillForRole(p, cmd.target!, roleIdx(cmd.target))) : '', after: String(a.color ?? '') }
    case 'setFillGradient': return { label: `role ${cmd.target}`, before: roleIdx(cmd.target) >= 0 ? fillLabel(fillForRole(p, cmd.target!, roleIdx(cmd.target))) : '', after: `${a.kind === 'radial' ? 'radial' : 'linear'} gradient` }
    case 'setFill': return { label: `role ${cmd.target}`, before: '', after: isValidFill(a.fill) ? fillLabel(a.fill) : 'fill' }
    case 'linkFill': return { label: `role ${cmd.target}`, before: '', after: `→ ${String(a.to ?? '')}` }
    case 'setFillOpacity': return { label: `role ${cmd.target} opacity`, before: '', after: String(a.opacity ?? '') }
    case 'clearFill': return { label: `role ${cmd.target}`, before: '', after: 'default colour' }
    case 'setParam': return { label: String(cmd.target ?? 'setting'), before: String(p[cmd.target as string] ?? ''), after: String(a.value ?? '') }
    default: return { label: cmd.op, before: '', after: a ? JSON.stringify(a) : '' }
  }
}
