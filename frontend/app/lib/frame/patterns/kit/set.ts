import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { applyFramePreset } from '~/lib/frame/frameSize'
import { clearGroupPinsOfMoved, clearPinsOfMoved } from '../pins'
import { layoutById, layoutsForStyle } from '../layouts/catalog'
import { candidatesForFrame, planLayout } from './plan'
import type { LayoutPlan, LayoutPlanArgs } from './plan'
import { closestFirst } from './vary'
import type { Candidate, Choice } from './vary'

// ═══════════════════════ a set (Stage 5 — Make a set) ═══════════════════════
// The Frame's layout, recomposed at each picked format. Per format, exactly what the user would get
// by sizing the Frame to that format's preset and applying the layout there — planned purely, on a
// copy: the source Frame is never written.
//   - The size write first (`applyFramePreset` on a copy): the preset is stored so `formatFor`
//     finds THIS format (two formats can share a size), and the lines the source's format hid come
//     back where the new one carries them (`restoreFormatHiddenLines`), as a real resize does.
//   - The same layout, at the stored choice, else the closest (`closestFirst`, the order a tag
//     re-apply uses), else the first — any variation the planner's check refuses is passed over,
//     as an apply refuses it.
//   - Not offered there: the first layout of the same style's library order that is (`swapped`),
//     at its first variation (what picking it in the library applies).
//   - Nothing offered: nulls.
// `layers` / `groups` are what the apply would commit (`applyLayoutToFrame`: pins of the layers
// the layout moved cleared, on the layers and on their groups).

export interface PlanSetArgs extends Omit<LayoutPlanArgs, 'layoutId' | 'choice'> {
  /** The Frame's layout (`sailor_posterState.patternId`) and its variation. */
  layoutId: string
  choice: Choice
  /** `FRAME_FORMATS` ids, in the order the set shows them. An unknown id is left out. */
  formats: readonly string[]
}

export interface SetEntry {
  formatId: string
  /** The format's own label (`FRAME_FORMATS`). */
  label: string
  /** The format's own pixel size — what the entry was planned at. */
  w: number
  h: number
  layoutId: string | null
  layoutName: string | null
  /** The Frame's own layout is not offered at this format: another of its style is used. */
  swapped: boolean
  choice: Choice | null
  plan: LayoutPlan | null
  /** The layers an apply at this size would commit. Null: nothing fits this format. */
  layers: LocalLayer[] | null
  /** The Frame's layer groups as that apply leaves them (pins of moved groups cleared). */
  groups: LayerGroup[] | null
}

/** A deep copy of the props a set writes to (layers, groups, the size record); everything else is
 *  shared, read-only — the planner never writes props. */
function copyProps(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(props ?? {}) }
  for (const k of ['sailor_localLayers', 'sailor_localGroups', 'sailor_frame', 'sailor_posterState']) {
    if (out[k] !== undefined) out[k] = structuredClone(out[k])
  }
  return out
}

/** The Frame sized to `formatId`'s preset, the way the Size menu sizes it (on a copy). */
function resized(a: PlanSetArgs, formatId: string): Record<string, unknown> {
  const data = {
    widgetDefs: [{ name: 'width' }, { name: 'height' }],
    widgetsValues: [a.frameW, a.frameH] as unknown[],
    properties: copyProps(a.props) as Record<string, any>,
  }
  applyFramePreset(data, formatId)
  return data.properties
}

/** The first of `order` whose plan passes (an apply refuses one with issues). */
function firstPassing(args: Omit<LayoutPlanArgs, 'choice'>, order: Candidate[]): { choice: Choice; plan: LayoutPlan } | null {
  for (const c of order) {
    const plan = planLayout({ ...args, choice: c.choice })
    if (plan && !plan.issues.length) return { choice: { ...c.choice }, plan }
  }
  return null
}

/** The Frame's layout planned at each format (see the header). Pure and deterministic. */
export function planSet(a: PlanSetArgs): SetEntry[] {
  const { formats, layoutId, choice, ...rest } = a
  const def = layoutById(layoutId)
  const style = def ? (def.style ?? 'swiss') : (a.style ?? 'swiss')
  const out: SetEntry[] = []
  for (const id of formats) {
    const fmt = FRAME_FORMATS.find(f => f.id === id)
    if (!fmt) continue
    const props = resized(a, fmt.id)
    const base: Omit<LayoutPlanArgs, 'choice' | 'layoutId'> = { ...rest, props, frameW: fmt.w, frameH: fmt.h, style }
    const entry: SetEntry = {
      formatId: fmt.id, label: fmt.label, w: fmt.w, h: fmt.h,
      layoutId: null, layoutName: null, swapped: false, choice: null, plan: null, layers: null, groups: null,
    }
    let got: { id: string; choice: Choice; plan: LayoutPlan } | null = null
    if (def) {
      const own = candidatesForFrame({ ...base, layoutId })
      const hit = firstPassing({ ...base, layoutId }, closestFirst(own, choice).map(o => o.c))
      if (hit) got = { id: layoutId, ...hit }
    }
    if (!got) {
      for (const d of layoutsForStyle(style)) {
        if (d.id === layoutId) continue
        const hit = firstPassing({ ...base, layoutId: d.id }, candidatesForFrame({ ...base, layoutId: d.id }))
        if (hit) { got = { id: d.id, ...hit }; entry.swapped = true; break }
      }
    }
    if (got) {
      const before = (props.sailor_localLayers as LocalLayer[] | undefined) ?? []
      const groups = (props.sailor_localGroups as LayerGroup[] | undefined) ?? []
      entry.layoutId = got.id
      entry.layoutName = layoutById(got.id)?.name ?? null
      entry.choice = got.choice
      entry.plan = got.plan
      entry.layers = clearPinsOfMoved(before, got.plan.layers)
      entry.groups = clearGroupPinsOfMoved(before, got.plan.layers, groups) ?? groups
    }
    out.push(entry)
  }
  return out
}
