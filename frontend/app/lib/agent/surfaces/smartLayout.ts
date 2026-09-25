/**
 * Smart Layout agent surface (F1). Wraps the pure `shared/template-grid`
 * functions so an agent can read a layout and change it through named,
 * invertible commands. Pure: every function takes a template and returns data
 * or a fresh template — no Vue, no editor state.
 */
import type { ElementV2, FormatSpec, Region, TemplateV2, TemplateV3 } from '~~/shared/template-grid/types'
import { ARCHETYPES, applyArchetype as applyArchetypePure } from '~~/shared/template-grid/archetypes'
import { allElements, groupIntoSection, ungroupSection } from '~~/shared/template-grid/sections'
import { fineGridDims, formatDims, remapRegion } from '~~/shared/template-grid/grid'
import { FORMAT_PRESETS } from '~~/shared/template-grid/starter'
import type { Command, CommandResult, CommandSpec, SurfaceSnapshot } from '~/lib/agent/commandSurface'

/** Friendly names → preset keys, so "wide"/"landscape" resolve to '16x9' etc. */
const FORMAT_ALIASES: Record<string, string> = {
  square: '1x1', '1x1': '1x1', '1:1': '1x1',
  portrait: '4x5', 'feed portrait': '4x5', feed: '4x5', '4x5': '4x5', '4:5': '4x5',
  story: '9x16', vertical: '9x16', '9x16': '9x16', '9:16': '9x16',
  wide: '16x9', landscape: '16x9', horizontal: '16x9', '16x9': '16x9', '16:9': '16x9',
}

/** Resolve a format reference (alias, preset key, an existing format key, or a
 *  custom {w,h} spec) to a concrete {key, spec}. Returns null if unresolvable. */
function resolveFormatRef(t: TemplateV3, args?: Record<string, unknown>): { key: string; spec: FormatSpec } | null {
  const raw = String(args?.format ?? args?.key ?? args?.name ?? '').trim().toLowerCase()
  const aliased = FORMAT_ALIASES[raw]
  if (aliased && FORMAT_PRESETS[aliased]) return { key: aliased, spec: { ...FORMAT_PRESETS[aliased]! } }
  if (FORMAT_PRESETS[raw]) return { key: raw, spec: { ...FORMAT_PRESETS[raw]! } }
  if (t.formats[raw]) return { key: raw, spec: t.formats[raw]! }
  const spec = args?.spec as FormatSpec | undefined
  if (spec && typeof spec.w === 'number' && typeof spec.h === 'number') {
    return { key: String(args?.key ?? `${spec.w}x${spec.h}`), spec }
  }
  return null
}

// JSON clone — templates are plain JSON; guards undefined (JSON.parse(undefined) throws).
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** Deep-clone the named template fields — used to capture an inverse snapshot
 *  for the generic `restore` command. */
function pick(t: TemplateV3, keys: (keyof TemplateV3)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k as string] = clone(t[k])
  return out
}

/** Document fields the internal `restore` op may overwrite — never structural
 *  fields like version/id/master (defence against a malformed restore). */
const RESTORABLE = new Set(['elements', 'sections', 'background', 'brand', 'formats', 'outputs', 'grid', 'typeScale'])

/** Find any element by id — loose (ungrouped) or nested in a section. The agent
 *  reaches both (a superset of the inspector, which today only edits loose). */
function findElement(t: TemplateV3, id?: string): ElementV2 | undefined {
  return t.elements.find(e => e.id === id)
    ?? t.sections.flatMap(s => s.children).find(e => e.id === id)
}

function isRegion(v: unknown): v is Region {
  const r = v as Region | undefined
  return !!r && typeof r === 'object'
    && typeof r.col === 'number' && typeof r.colSpan === 'number'
    && typeof r.row === 'number' && typeof r.rowSpan === 'number'
}

/** Whitelisted `style` keys per element type — exactly what the inspector edits
 *  via patchStyle. Anything outside is rejected (no silent drops). */
const STYLE_KEYS: Record<ElementV2['type'], Set<string>> = {
  text: new Set(['fontFamily', 'fontWeight', 'fontSize', 'color', 'align', 'valign', 'lineHeight', 'letterSpacing', 'transform', 'panel', 'opacity', 'orientation']),
  image: new Set(['fit', 'borderRadius']),
  shape: new Set(['fill', 'borderRadius', 'borderColor', 'borderWidth']),
}

/** Whitelisted top-level (non-style) element fields per type — what the
 *  inspector edits via patchElement. `id`/`type`/`role` are intentionally
 *  excluded (renaming an id breaks targets, inverses and brand bindings). */
const PROP_KEYS: Record<ElementV2['type'], Set<string>> = {
  text: new Set(['region', 'priority', 'bleed', 'hidden', 'locked', 'level', 'overflow', 'maxLines', 'overhang']),
  image: new Set(['region', 'priority', 'bleed', 'hidden', 'locked', 'content', 'focal', 'collapse']),
  shape: new Set(['region', 'priority', 'bleed', 'hidden', 'locked', 'shape']),
}

/** Next free priority — mirrors useGridEditor.nextPriority but across sections too. */
function nextPriority(t: TemplateV3): number {
  const all = [...t.elements, ...t.sections.flatMap(s => s.children)]
  return Math.max(0, ...all.map(e => e.priority)) + 1
}

/** The {{ props.* }} variable slots the template is wired to — so the agent knows
 *  which variables exist (e.g. to bind text/image content to them). */
function propSlots(t: TemplateV3): string[] {
  const found = new Set<string>()
  const scan = (v: unknown) => {
    if (typeof v !== 'string') return
    for (const m of v.matchAll(/\{\{\s*props\.([\w-]+)\s*\}\}/g)) found.add(m[1]!)
  }
  for (const e of allElements(t)) if ('content' in e) scan((e as { content?: unknown }).content)
  scan(t.background?.image)
  return [...found]
}

/** The agent-facing command menu (F3 hints map qualitative intent → command).
 *  `restore` is intentionally omitted — it's the internal inverse mechanism. */
const SMART_LAYOUT_COMMANDS: CommandSpec[] = [
  { op: 'setSectionRegion', hint: 'Move or resize a section: set its grid region {col,colSpan,row,rowSpan} (1-based, inclusive) on the master FINE grid — see the document object\'s grid {cols,rows} for the size. e.g. "put the title in the top third" → rows 1..rows/3.' },
  { op: 'setText', hint: 'Change the copy of a text element. target = element id; args: { text }. The text may be literal or model-written (e.g. "make the headline punchier" → set the rewritten string). Note: content can be a {{ props.* }} token bound to a variable — setting literal text replaces that binding.' },
  { op: 'setTextColor', hint: 'Set the COLOUR of a specific text element. target = element id; args: { color } — a hex "#RRGGBB" OR a brand token like "{{ brand.foreground }}" / "{{ brand.primary }}" to bind it to the kit. If the user names a brand palette colour (the brand context lists palette.<name> entries, e.g. "viridian"), bind "{{ brand.palette.<name> }}". Use for "make the text yellow" / "the headline red" / "use the brand colour" — NOT setBrand (which retints the whole kit).' },
  { op: 'setElementStyle', hint: 'Change the VISUAL STYLE of any element via its style object. target = element id; args: { patch }. Valid keys by type — text: fontFamily, fontWeight (400|700), fontSize (px), color, align (left|center|right), valign (top|middle|bottom), lineHeight, letterSpacing, transform (none|uppercase), panel, opacity (0-1, whole-element fade), orientation (horizontal|up|down — a vertical title running along the region\'s edge); image: fit (cover|contain|stretch), borderRadius; shape: fill, borderColor, borderWidth, borderRadius. shape.fill accepts a solid colour OR a CSS gradient e.g. "linear-gradient(135deg,#FF6EB4,#FF8C42)". Any colour or font value may instead be a BRAND TOKEN bound to the kit — colours: "{{ brand.primary|secondary|accent|accent2|foreground|background }}", fonts: "{{ brand.fontDisplay|fontBody }}". Named palette colours bind as "{{ brand.palette.<name> }}" (see palette.* entries in the brand context). (For a plain text colour, setTextColor is simpler.)' },
  { op: 'setElementProps', hint: 'Change non-style PROPERTIES of any element. target = element id; args: { patch }. Valid keys — all: region ({col,colSpan,row,rowSpan}, 1-based on the master fine grid — see document.grid {cols,rows}; full-canvas = col 1..cols, row 1..rows — moves/resizes), priority (1=most important), bleed (bool), hidden (bool — show/hide), locked (bool); text also: level (caption|body|subhead|headline|display), overflow (shrink|shrink-then-truncate|grow), maxLines, overhang (bool — place with RAW unclamped region math, letting it crop off the canvas edge instead of being clamped in-grid); image also: content (URL or {{ props.* }}), focal, collapse; shape also: shape (rect|circle). To change text COPY use setText.' },
  { op: 'addElement', hint: 'Add a NEW loose element to the canvas. args: { element }. element needs: id (unique), type (text|image|shape), region {col,colSpan,row,rowSpan} on the master FINE grid (see the document object\'s grid {cols,rows}) — a FULL-CANVAS element spans col 1 colSpan=cols, row 1 rowSpan=rows; size the region to how big it should look (text auto-fits its region). text also needs content + level; image needs content; shape needs shape (rect|circle). To add INTO a section use addChildToSection.' },
  { op: 'removeElement', hint: 'Delete an element by id (loose or a section child). target = element id.' },
  { op: 'reorderElement', hint: 'Change front/back stacking of a LOOSE element. target = element id; args: { direction: "up" | "down" } (up = toward the front). Ungrouped elements only.' },
  { op: 'group', hint: 'Group existing ungrouped elements into a new named section (a lockup/block). args: { name, elementIds }.' },
  { op: 'ungroup', hint: 'Dissolve a section back into ungrouped elements. args: { sectionId }.' },
  { op: 'applyArchetype', hint: 'Replace the WHOLE composition with a built-in PLACEHOLDER template — this WIPES the current elements and uses {{ props.* }} placeholders. args.id ∈ hero-band | split | type-poster | editorial. Use this ONLY for a fresh/blank starting layout. If the user wants to REARRANGE their existing content into a new layout (keeping their actual text/images), do NOT use this — instead reposition the current elements with setElementProps (new regions) so their content is preserved.' },
  { op: 'setBackground', hint: 'Set the CANVAS / artboard background. args: { fill } — a solid colour ("#RRGGBB") OR a full CSS gradient string, e.g. "linear-gradient(135deg, #FF6EB4, #FF8C42, #FFD36E)". This is what "make the background blue", "a pink-orange sunset gradient", "warm gradient background" mean. ALWAYS prefer this over generateImage for colours and gradients; do NOT generate a photo for a gradient. fill may also be a brand token like "{{ brand.background }}". Or a named palette colour: "{{ brand.palette.<name> }}" when the user says e.g. "make the background viridian". (Not setBrand.)' },
  { op: 'setSectionProps', hint: 'Show/hide or rename a section. target = section id; args: { patch: { hidden?: boolean, name?: string } }. Use for "hide the footer section".' },
  { op: 'setGrid', hint: 'Adjust the document GRID spacing (applies to every format). args: { patch: { gutter?: number, margin?: number, baseline?: number } } in master px. Use for "tighten the grid", "more breathing room / bigger margins".' },
  { op: 'setTypeScale', hint: 'Adjust the TYPE SCALE that drives text sizes per level. args: { patch: { base?: number (caption px), ratio?: number — ~1.2 subtle, ~1.5 dramatic } }. Use for "bigger type hierarchy", "more dramatic type contrast".' },
  { op: 'setBrand', hint: 'Apply BRAND palette tokens/fonts (primary, secondary, accent, accent2, foreground, background, fontDisplay, fontBody, logo). This ONLY affects elements bound to a {{ brand.* }} token — it does NOT touch an element with a literal value. To recolour the canvas use setBackground; one specific text element, setTextColor. args: { patch }.' },
  { op: 'addChildToSection', hint: 'Add a text/image/shape element into an existing section, e.g. "put the product photo in the hero section". args: { sectionId, element }.' },
  { op: 'generateImage', hint: 'Generate a PHOTOGRAPHIC or illustrative AI image from a text prompt — for "a picture of a dog", "a photo of a city skyline". Do NOT use this for plain colours or gradients (use setBackground for those). args: { prompt (vivid, detailed), aspectRatio? ("1:1"|"16:9"|"9:16"|"4:5"), region? ({col,colSpan,row,rowSpan} on the master fine grid — see document.grid {cols,rows}) }. To fill the WHOLE canvas as a background set target = "background"; to fill an existing image element set target = its id; otherwise it is placed at the given region.' },
  { op: 'removeImageBackground', hint: 'Cut out the subject of an existing image element, leaving a transparent background — "remove the background", "cut out the subject". target = the image element id.' },
  { op: 'editImage', hint: 'Retouch/edit an existing image element from an instruction (Flux 2 Pro) — "make it brighter", "change the sky to a sunset", "make it black and white", "remove the person". target = image element id; args: { instruction }. For removing the background specifically, use removeImageBackground.' },
  { op: 'addFormat', hint: 'Add a new output FORMAT / aspect ratio (a deliverable size, like the FORMATS panel) — this is what "add a wide format" / "make a story version" means, NOT adding text. args: { format }. Accepts: square (1x1), portrait (4x5), story (9x16), wide (16x9), a preset key, or a custom { spec: { w, h, label } }.' },
  { op: 'removeFormat', hint: 'Remove an output format / aspect ratio. args: { format } (alias or key). Cannot remove the master/design format.' },
]

/** Read a Smart Layout template as an agent-readable snapshot: each section
 *  becomes an addressable object carrying its current grid region. `brand`, when
 *  given, is the caller's EFFECTIVE brand context (e.g. the active kit's palette
 *  merged with the template's own overrides) — it takes priority over
 *  `template.brand` so the agent sees the palette tokens actually in effect. */
export function describeSmartLayout(template: TemplateV3, brand?: Record<string, unknown>): SurfaceSnapshot {
  const masterFmt = template.formats[template.master]
  const gridSize = masterFmt ? fineGridDims(template, masterFmt) : { cols: 0, rows: 0 }
  return {
    surface: 'smart-layout',
    objects: [
      ...template.sections.map(s => ({
        id: s.id,
        label: s.name,
        type: 'section',
        current: clone(s.region),
      })),
      // Elements (ungrouped + section children) so the agent can see and target
      // them: content (the copy), region (for moves/resizes), and current colour.
      ...allElements(template).map((e) => {
        const cur: Record<string, unknown> = { region: clone(e.region) }
        if ('content' in e) cur.content = clone((e as { content: unknown }).content)
        if (e.type === 'text' && e.style?.color) cur.color = e.style.color
        if (e.type === 'shape' && e.style?.fill) cur.fill = e.style.fill
        if (e.hidden) cur.hidden = true
        return { id: e.id, label: e.role ?? e.id, type: e.type, current: cur }
      }),
      // The document itself — so the agent knows the current background, the
      // formats that exist (to add/remove without duplicating), and the master.
      {
        id: 'document',
        label: 'Canvas / document',
        type: 'document',
        current: {
          background: template.background?.fill ?? null,
          formats: template.outputs?.length
            ? [...new Set(template.outputs.map(o => o.format))]
            : Object.keys(template.formats),
          master: template.master,
          // The master FINE grid size. All regions are in this grid, so a
          // full-canvas element spans col 1..cols, row 1..rows.
          grid: gridSize,
          // The brand kit's actual values (so the agent knows what {{ brand.* }}
          // resolves to) and the variable slots the template is wired to.
          brand: brand ?? template.brand ?? {},
          props: propSlots(template),
        },
      },
    ],
    commands: SMART_LAYOUT_COMMANDS,
  }
}

/** Apply one command to a Smart Layout template, returning the new template and
 *  an inverse command. Pure — the input is never mutated. */
export function applySmartLayoutCommand(
  input: TemplateV3, cmd: Command,
): CommandResult<TemplateV3> {
  // Operate on a deep clone: the input is never mutated, and every returned
  // template is fully independent of it (so callers can't corrupt the original
  // by mutating the result). Mirrors the shared/template-grid pure-function
  // convention, and de-proxies a Vue-reactive input.
  const template = clone(input)
  switch (cmd.op) {
    case 'setSectionRegion': {
      const section = template.sections.find(s => s.id === cmd.target)
      if (!section) return { ok: false, reason: 'invalid', detail: `no section '${cmd.target}'` }
      const region = cmd.args?.region as Region | undefined
      if (!region) return { ok: false, reason: 'invalid', detail: 'missing args.region' }
      const before = section.region
      const next: TemplateV3 = {
        ...template,
        sections: template.sections.map(s => (s.id === cmd.target ? { ...s, region } : s)),
      }
      return {
        ok: true,
        template: next,
        inverse: { op: 'setSectionRegion', target: cmd.target, args: { region: before } },
      }
    }
    case 'setText': {
      const text = cmd.args?.text
      if (typeof text !== 'string') return { ok: false, reason: 'invalid', detail: 'missing args.text (string)' }
      const el = template.elements.find(e => e.id === cmd.target)
        ?? template.sections.flatMap(s => s.children).find(e => e.id === cmd.target)
      if (!el) return { ok: false, reason: 'invalid', detail: `no element '${String(cmd.target)}'` }
      if (el.type !== 'text') return { ok: false, reason: 'invalid', detail: `element '${String(cmd.target)}' is not a text element` }
      const before = el.content
      el.content = text // safe: `template` is a deep clone of the input
      return { ok: true, template, inverse: { op: 'setText', target: cmd.target, args: { text: before } } }
    }
    case 'setTextColor': {
      const color = cmd.args?.color
      if (typeof color !== 'string') return { ok: false, reason: 'invalid', detail: 'missing args.color (#RRGGBB)' }
      const el = template.elements.find(e => e.id === cmd.target)
        ?? template.sections.flatMap(s => s.children).find(e => e.id === cmd.target)
      if (!el) return { ok: false, reason: 'invalid', detail: `no element '${String(cmd.target)}'` }
      if (el.type !== 'text') return { ok: false, reason: 'invalid', detail: `element '${String(cmd.target)}' is not a text element` }
      // Capture the inverse before mutating; the colour may have been unset, so
      // restore the whole elements/sections snapshot (handles undefined → undefined).
      const before = pick(template, ['elements', 'sections'])
      el.style = { ...el.style, color } // safe: `template` is a deep clone of the input
      return { ok: true, template, inverse: { op: 'restore', args: before } }
    }
    case 'setElementStyle': {
      const patch = cmd.args?.patch
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const el = findElement(template, cmd.target)
      if (!el) return { ok: false, reason: 'invalid', detail: `no element '${String(cmd.target)}'` }
      const allowed = STYLE_KEYS[el.type]
      const bad = Object.keys(patch).filter(k => !allowed.has(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `style key(s) not valid for ${el.type}: ${bad.join(', ')}` }
      const before = pick(template, ['elements', 'sections'])
      const styled = el as { style?: Record<string, unknown> }
      styled.style = { ...styled.style, ...clone(patch as Record<string, unknown>) } // clone: no shared ref with the command
      return { ok: true, template, inverse: { op: 'restore', args: before } }
    }
    case 'setElementProps': {
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const el = findElement(template, cmd.target)
      if (!el) return { ok: false, reason: 'invalid', detail: `no element '${String(cmd.target)}'` }
      const allowed = PROP_KEYS[el.type]
      const bad = Object.keys(patch).filter(k => !allowed.has(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `prop(s) not valid for ${el.type}: ${bad.join(', ')}` }
      if ('region' in patch && !isRegion(patch.region)) return { ok: false, reason: 'invalid', detail: 'region must be {col,colSpan,row,rowSpan}' }
      const before = pick(template, ['elements', 'sections'])
      Object.assign(el, clone(patch)) // clone: no shared ref with the command; keys whitelisted
      return { ok: true, template, inverse: { op: 'restore', args: before } }
    }
    case 'addElement': {
      const element = cmd.args?.element as ElementV2 | undefined
      if (!element || typeof element.id !== 'string' || !element.type || !isRegion(element.region))
        return { ok: false, reason: 'invalid', detail: 'element needs id, type and a valid region' }
      if (findElement(template, element.id)) return { ok: false, reason: 'invalid', detail: `element id '${element.id}' already exists` }
      if (element.type === 'text' && typeof (element as { content?: unknown }).content !== 'string')
        return { ok: false, reason: 'invalid', detail: 'text element needs content (string)' }
      if (element.type === 'image' && typeof (element as { content?: unknown }).content !== 'string')
        return { ok: false, reason: 'invalid', detail: 'image element needs content (string)' }
      if (element.type === 'shape' && element.shape !== 'rect' && element.shape !== 'circle')
        return { ok: false, reason: 'invalid', detail: "shape element needs shape 'rect' or 'circle'" }
      const el = clone(element)
      if (typeof el.priority !== 'number') el.priority = nextPriority(template)
      if (el.type === 'text' && !el.level) el.level = 'body'
      const before = pick(template, ['elements'])
      const next: TemplateV3 = { ...template, elements: [...template.elements, el] }
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'removeElement': {
      const id = cmd.target
      const present = template.elements.some(e => e.id === id)
        || template.sections.some(s => s.children.some(c => c.id === id))
      if (!present) return { ok: false, reason: 'invalid', detail: `no element '${String(id)}'` }
      const before = pick(template, ['elements', 'sections'])
      const next: TemplateV3 = {
        ...template,
        elements: template.elements.filter(e => e.id !== id),
        sections: template.sections.map(s => ({ ...s, children: s.children.filter(c => c.id !== id) })),
      }
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'reorderElement': {
      const id = cmd.target
      const dir = cmd.args?.direction
      if (dir !== 'up' && dir !== 'down') return { ok: false, reason: 'invalid', detail: "direction must be 'up' or 'down'" }
      const idx = template.elements.findIndex(e => e.id === id)
      if (idx < 0) return { ok: false, reason: 'invalid', detail: `no loose element '${String(id)}' (reorder is for ungrouped elements)` }
      const swap = dir === 'up' ? idx + 1 : idx - 1 // array order is z-order: later = on top
      if (swap < 0 || swap >= template.elements.length) return { ok: false, reason: 'invalid', detail: `'${String(id)}' is already at the ${dir === 'up' ? 'front' : 'back'}` }
      const before = pick(template, ['elements'])
      const arr = [...template.elements]
      const tmp = arr[idx]!; arr[idx] = arr[swap]!; arr[swap] = tmp
      const next: TemplateV3 = { ...template, elements: arr }
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'addFormat': {
      const ref = resolveFormatRef(template, cmd.args)
      if (!ref) return { ok: false, reason: 'invalid', detail: 'unknown format — use square|portrait|story|wide, a preset key, or a custom { spec: {w,h} }' }
      const before = pick(template, ['formats', 'outputs'])
      const formats = { ...template.formats, [ref.key]: clone(ref.spec) }
      const existing = template.outputs ?? []
      let id = ref.key, n = 1
      while (existing.some(o => o.id === id)) id = `${ref.key}-${n++}`
      const outputs = [...existing, { id, format: ref.key, label: ref.spec.label }]
      return { ok: true, template: { ...template, formats, outputs }, inverse: { op: 'restore', args: before } }
    }
    case 'removeFormat': {
      const ref = resolveFormatRef(template, cmd.args)
      if (!ref || !template.formats[ref.key]) return { ok: false, reason: 'invalid', detail: `no format '${ref?.key ?? String(cmd.args?.format)}'` }
      if (ref.key === template.master) return { ok: false, reason: 'invalid', detail: 'cannot remove the master/design format' }
      const remaining = (template.outputs ?? []).filter(o => o.format !== ref.key)
      if (!remaining.length) return { ok: false, reason: 'invalid', detail: 'cannot remove the only format' }
      const before = pick(template, ['formats', 'outputs'])
      const formats = { ...template.formats }
      delete formats[ref.key]
      return { ok: true, template: { ...template, formats, outputs: remaining }, inverse: { op: 'restore', args: before } }
    }
    case 'group': {
      const elementIds = cmd.args?.elementIds
      const name = (cmd.args?.name as string | undefined)?.trim() || 'Section'
      if (!Array.isArray(elementIds) || elementIds.length === 0
        || !elementIds.every(id => template.elements.some(e => e.id === id)))
        return { ok: false, reason: 'invalid', detail: 'group requires a non-empty list of existing element ids' }
      const before = pick(template, ['elements', 'sections'])
      const next = groupIntoSection(template, elementIds as string[], name)
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'ungroup': {
      const sectionId = cmd.args?.sectionId as string | undefined
      const section = template.sections.find(s => s.id === sectionId)
      if (!section || section.children.length === 0)
        return { ok: false, reason: 'invalid', detail: `section '${String(sectionId)}' is missing or empty` }
      const before = pick(template, ['elements', 'sections'])
      const next = ungroupSection(template, sectionId!)
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'applyArchetype': {
      const arch = ARCHETYPES.find(a => a.id === cmd.args?.id)
      if (!arch) return { ok: false, reason: 'invalid', detail: `no archetype '${String(cmd.args?.id)}'` }
      const before = pick(template, ['elements', 'background', 'brand'])
      // applyArchetype spreads the input, preserving version:3 + sections, and
      // only overwrites elements/background/brand. The casts bridge its
      // V2-typed signature — safe as long as that preservation holds.
      const applied = applyArchetypePure(template as unknown as TemplateV2, arch) as unknown as TemplateV3
      // Archetype regions are on the COARSE format grid; v3 uses the FINE grid, so
      // remap them (same as toV3) or the whole composition lands tiny in a corner.
      const masterFmt = template.formats[template.master]
      if (masterFmt) {
        const coarse = formatDims(masterFmt)
        const fine = fineGridDims(template, masterFmt)
        applied.elements = applied.elements.map(el => ({ ...el, region: remapRegion(el.region, coarse, fine) }))
      }
      return { ok: true, template: applied, inverse: { op: 'restore', args: before } }
    }
    case 'setSectionProps': {
      const section = template.sections.find(s => s.id === cmd.target)
      if (!section) return { ok: false, reason: 'invalid', detail: `no section '${String(cmd.target)}'` }
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const bad = Object.keys(patch).filter(k => k !== 'hidden' && k !== 'name')
      if (bad.length) return { ok: false, reason: 'invalid', detail: `section prop(s) not valid: ${bad.join(', ')}` }
      const before = pick(template, ['sections'])
      const next = { ...template, sections: template.sections.map(s => (s.id === cmd.target ? { ...s, ...clone(patch) } : s)) } as TemplateV3
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'setGrid': {
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const bad = Object.keys(patch).filter(k => !['gutter', 'margin', 'baseline'].includes(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `grid key(s) not valid: ${bad.join(', ')}` }
      if (Object.values(patch).some(v => typeof v !== 'number')) return { ok: false, reason: 'invalid', detail: 'grid values must be numbers (px)' }
      const before = pick(template, ['grid'])
      const next = { ...template, grid: { ...template.grid, ...clone(patch) } } as TemplateV3
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'setTypeScale': {
      const patch = cmd.args?.patch as Record<string, unknown> | undefined
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const bad = Object.keys(patch).filter(k => !['base', 'ratio'].includes(k))
      if (bad.length) return { ok: false, reason: 'invalid', detail: `typeScale key(s) not valid: ${bad.join(', ')}` }
      if (Object.values(patch).some(v => typeof v !== 'number')) return { ok: false, reason: 'invalid', detail: 'typeScale values must be numbers' }
      const before = pick(template, ['typeScale'])
      const next = { ...template, typeScale: { ...template.typeScale, ...clone(patch) } } as TemplateV3
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'setBrand': {
      const patch = cmd.args?.patch
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid', detail: 'missing args.patch' }
      const before = pick(template, ['brand'])
      const next = { ...template, brand: { ...(template.brand ?? {}), ...(patch as Record<string, unknown>) } } as TemplateV3
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'setBackground': {
      const fill = cmd.args?.fill
      const image = cmd.args?.image
      if (typeof fill !== 'string' && typeof image !== 'string') return { ok: false, reason: 'invalid', detail: 'setBackground needs args.fill (colour or CSS gradient) or args.image' }
      const before = pick(template, ['background'])
      const bg = { ...(template.background ?? {}) }
      if (typeof fill === 'string') { bg.fill = fill; delete bg.image } // a fill (colour/gradient) replaces any image bg
      if (typeof image === 'string') bg.image = image
      const next = { ...template, background: bg } as TemplateV3
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'addChildToSection': {
      const sectionId = cmd.args?.sectionId as string | undefined
      const element = cmd.args?.element as ElementV2 | undefined
      if (!element || !element.id || !element.type || !element.region)
        return { ok: false, reason: 'invalid', detail: 'element missing required fields (id, type, region)' }
      if (!template.sections.some(s => s.id === sectionId))
        return { ok: false, reason: 'invalid', detail: `no section '${String(sectionId)}'` }
      const before = pick(template, ['sections'])
      const next: TemplateV3 = {
        ...template,
        sections: template.sections.map(s =>
          (s.id === sectionId ? { ...s, children: [...s.children, clone(element)] } : s)),
      }
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    case 'restore': {
      const args = cmd.args ?? {}
      const keys = (Object.keys(args) as (keyof TemplateV3)[]).filter(k => RESTORABLE.has(k as string))
      const before = pick(template, keys)
      const next = { ...template } as TemplateV3
      const sink = next as unknown as Record<string, unknown>
      for (const k of keys) sink[k as string] = (args as Record<string, unknown>)[k as string]
      return { ok: true, template: next, inverse: { op: 'restore', args: before } }
    }
    default:
      return { ok: false, reason: 'out-of-vocabulary', detail: `unknown op '${cmd.op}'` }
  }
}

/** Human-readable summary of a command for the proposal UI: a label and a
 *  before→after pair. Display-only; reads the pre-state from `template`. */
export function summarizeSmartLayoutChange(
  template: TemplateV3, cmd: Command,
): { label: string; before: string; after: string } | null {
  switch (cmd.op) {
    case 'setText': {
      const el = template.elements.find(e => e.id === cmd.target)
        ?? template.sections.flatMap(s => s.children).find(e => e.id === cmd.target)
      const before = el && 'content' in el ? String((el as { content: unknown }).content) : ''
      const role = el && 'role' in el ? (el as { role?: string }).role : undefined
      return { label: role ?? 'Copy', before, after: String(cmd.args?.text ?? '') }
    }
    case 'setTextColor': {
      const el = findElement(template, cmd.target)
      const before = el && el.type === 'text' ? (el.style?.color ?? '') : ''
      const role = el?.role
      return { label: role ? `${role} colour` : 'Text colour', before, after: String(cmd.args?.color ?? '') }
    }
    case 'setElementStyle': {
      const el = findElement(template, cmd.target)
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      return { label: el?.role ? `${el.role} style` : 'Style', before: '', after: Object.keys(patch).map(k => `${k}: ${String(patch[k])}`).join(', ') }
    }
    case 'setElementProps': {
      const el = findElement(template, cmd.target)
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      const fmt = (k: string) => k === 'region' && isRegion(patch.region) ? `region: row ${patch.region.row}, col ${patch.region.col}` : `${k}: ${String(patch[k])}`
      return { label: el?.role ?? (el?.type ? `${el.type} element` : 'Element'), before: '', after: Object.keys(patch).map(fmt).join(', ') }
    }
    case 'addElement': {
      const el = cmd.args?.element as { type?: string; content?: unknown } | undefined
      return { label: 'Add element', before: '', after: el?.type === 'text' ? `text "${String(el.content ?? '')}"` : `${el?.type ?? 'element'}` }
    }
    case 'removeElement': {
      const el = findElement(template, cmd.target)
      return { label: 'Remove element', before: el?.role ?? String(cmd.target), after: 'deleted' }
    }
    case 'reorderElement':
      return { label: 'Stacking', before: '', after: cmd.args?.direction === 'up' ? 'bring forward' : 'send back' }
    case 'setSectionProps': {
      const sec = template.sections.find(s => s.id === cmd.target)
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      const after = 'hidden' in patch ? (patch.hidden ? 'hidden' : 'shown') : Object.keys(patch).map(k => `${k}: ${String(patch[k])}`).join(', ')
      return { label: sec ? `${sec.name} section` : 'Section', before: '', after }
    }
    case 'setGrid': {
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      return { label: 'Grid', before: '', after: Object.keys(patch).map(k => `${k}: ${String(patch[k])}`).join(', ') }
    }
    case 'setTypeScale': {
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      return { label: 'Type scale', before: '', after: Object.keys(patch).map(k => `${k}: ${String(patch[k])}`).join(', ') }
    }
    case 'addFormat': {
      const ref = resolveFormatRef(template, cmd.args)
      return { label: 'Add format', before: '', after: ref ? `${ref.spec.label ?? ref.key} (${ref.spec.w}×${ref.spec.h})` : String(cmd.args?.format ?? '') }
    }
    case 'removeFormat': {
      const ref = resolveFormatRef(template, cmd.args)
      return { label: 'Remove format', before: ref?.spec.label ?? ref?.key ?? String(cmd.args?.format ?? ''), after: 'removed' }
    }
    case 'setSectionRegion': {
      const sec = template.sections.find(s => s.id === cmd.target)
      const r = cmd.args?.region as Region | undefined
      return { label: sec ? `${sec.name} section` : 'Section', before: sec ? `row ${sec.region.row}` : '', after: r ? `row ${r.row}` : '' }
    }
    case 'setBrand': {
      const patch = (cmd.args?.patch ?? {}) as Record<string, unknown>
      return { label: 'Brand', before: '', after: Object.keys(patch).map(k => `${k}: ${String(patch[k])}`).join(', ') }
    }
    case 'setBackground': {
      const short = (v: unknown) => typeof v !== 'string' ? '' : v.includes('gradient') ? 'gradient' : v
      const after = cmd.args?.image ? 'image' : short(cmd.args?.fill)
      return { label: 'Canvas background', before: short(template.background?.fill), after }
    }
    case 'applyArchetype':
      return { label: 'Layout', before: 'current', after: String(cmd.args?.id ?? '') }
    case 'group':
      return { label: 'Group', before: '', after: String(cmd.args?.name ?? 'Section') }
    case 'ungroup': {
      const sec = template.sections.find(s => s.id === cmd.target)
      return { label: 'Ungroup', before: sec?.name ?? String(cmd.target), after: 'ungrouped' }
    }
    case 'addChildToSection': {
      const sec = template.sections.find(s => s.id === cmd.target)
      const el = cmd.args?.element as { type?: string } | undefined
      return { label: sec ? `${sec.name} section` : 'Section', before: '', after: `+ ${el?.type ?? 'element'}` }
    }
    default:
      return { label: cmd.op, before: '', after: cmd.args ? JSON.stringify(cmd.args) : '' }
  }
}
