/**
 * Sailor's own model menus (model line-up spec, Ruling 1): which model each
 * node offers, which it leaves out, and which it starts with. The lists are
 * the frontend catalogues, never Python's:
 *   - the gallery nodes ("Generate an image", "Generate a video", "Film a
 *     shot"): app/data/image-models.ts and video-models.ts;
 *   - the plain dropdowns (Edit image, Blend scene, Restyle, Generate from
 *     references, Upscale): app/data/edit-model-options.ts.
 *
 * `applyModelOverlay` adjusts every `/object_info` body Sailor serves
 * (server/native/objectInfo.ts, server/utils/engineGate.ts) from them. The
 * galleries filter with `galleryEntries`; the combo widget with `comboMenu`.
 *
 * One rule decides what a menu offers and what a new node starts with
 * (`offerable`): not hidden, not discontinued, and a runner-only model only
 * while its family is switched on AND on a node class the runner takes.
 *
 * Pure; relative imports only (Nitro, the app and vitest all load it).
 */
import { IMAGE_MODELS, IMAGE_MODEL_PREFERENCE } from '../../app/data/image-models'
import { FILM_SHOT_MODEL_PREFERENCE, VIDEO_MODELS, VIDEO_MODEL_PREFERENCE } from '../../app/data/video-models'
import { EDIT_MODEL_MENUS } from '../../app/data/edit-model-options'
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, resolveVideoModelId } from './eligibility'
import type { ModelFlags, RunnerFamily } from './families'

/** One value of a model menu: what the node stores, what the menu shows, and its flags. */
export interface MenuEntry extends ModelFlags {
  value: string
  label: string
}

export interface ModelMenu {
  classType: string
  input: string
  /** A gallery button (only the default is served) or a plain dropdown (options, hidden list and default). */
  kind: 'gallery' | 'dropdown'
  entries: readonly MenuEntry[]
  /** The default is the first of these that can run now. */
  preference: readonly string[]
}

function flagsOf(m: ModelFlags): ModelFlags {
  const out: ModelFlags = {}
  if (m.hidden) out.hidden = true
  if (m.discontinued) out.discontinued = m.discontinued
  if (m.runnerOnly) out.runnerOnly = true
  if (m.family) out.family = m.family
  return out
}

// Built on first use, never at import: the catalogues are other modules'
// consts, and a top-level read breaks on import reorder.
let menusMemo: readonly ModelMenu[] | null = null

/** Every model menu Sailor decides. */
export function modelMenus(): readonly ModelMenu[] {
  if (menusMemo) return menusMemo
  const images = IMAGE_MODELS.map(m => ({ value: m.id, label: m.label, ...flagsOf(m) }))
  const videos = VIDEO_MODELS.map(m => ({ value: m.id, label: m.label, ...flagsOf(m) }))
  const menus: ModelMenu[] = [
    { classType: 'GenerateImageNode', input: 'model', kind: 'gallery', entries: images, preference: IMAGE_MODEL_PREFERENCE },
    { classType: 'GenerateVideoNode', input: 'model', kind: 'gallery', entries: videos, preference: VIDEO_MODEL_PREFERENCE },
    { classType: 'FilmShotNode', input: 'model', kind: 'gallery', entries: videos, preference: FILM_SHOT_MODEL_PREFERENCE },
  ]
  for (const [key, menu] of Object.entries(EDIT_MODEL_MENUS)) {
    const dot = key.indexOf('.')
    menus.push({
      classType: key.slice(0, dot),
      input: key.slice(dot + 1),
      kind: 'dropdown',
      entries: menu.options.map(o => ({ ...o })),
      preference: menu.preference,
    })
  }
  menusMemo = menus
  return menus
}

/** Tests: rebuild the menus from the catalogues on next use (after a test flags an entry). */
export function __resetModelMenusForTests(): void { menusMemo = null }

/** The menu for `Class.input`, or undefined when Sailor doesn't decide it. */
export function modelMenu(classType: string, input = 'model'): ModelMenu | undefined {
  return modelMenus().find(m => m.classType === classType && m.input === input)
}

/**
 * A node value as the menu looks it up: GenerateVideoNode's legacy labels
 * ('Veo 3' → veo-3.1) are followed first, as the node itself does
 * (`_LEGACY_MODEL_REMAP`).
 */
export function menuKey(classType: string, value: string): string {
  return classType === 'GenerateVideoNode' ? resolveVideoModelId(value) : value
}

/** The catalogue entry a node's value names (after the legacy remap), or undefined. */
export function modelEntryFor(classType: string, value: unknown, input = 'model'): MenuEntry | undefined {
  if (typeof value !== 'string') return undefined
  const menu = modelMenu(classType, input)
  if (!menu) return undefined
  const key = menuKey(classType, value)
  return menu.entries.find(e => e.value === key)
}

/** Whether the runner takes this node class at all (a runner node type, or a class a family's row adds). */
export function runnerTakesClass(classType: string): boolean {
  return RUNNER_NODE_TYPES.has(classType) || Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType)
}

/** Hidden from the menus by its flags alone: hidden, or discontinued. */
export function hiddenByFlag(e: ModelFlags): boolean {
  return !!e.hidden || !!e.discontinued
}

/**
 * Whether a menu on `classType` offers this model, and so whether it can be a
 * new node's default: it can run now. Not hidden, not discontinued; a
 * runner-only model only while its family is on and on a class the runner takes.
 */
export function offerable(e: ModelFlags, classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  if (hiddenByFlag(e)) return false
  if (e.runnerOnly) return !!e.family && families.has(e.family) && runnerTakesClass(classType)
  return true
}

/** The values a dropdown leaves out (every value that is not offerable), in menu order. */
export function menuHiddenValues(menu: ModelMenu, families: ReadonlySet<RunnerFamily>): string[] {
  return menu.entries.filter(e => !offerable(e, menu.classType, families)).map(e => e.value)
}

/**
 * The default a new node gets: the first preference that can run now; else
 * the current default, while it can; else the first value that can; else the
 * current default unchanged.
 */
export function menuDefault(menu: ModelMenu, families: ReadonlySet<RunnerFamily>, current?: unknown): string | undefined {
  const byValue = new Map(menu.entries.map(e => [e.value, e]))
  const runs = (v: string) => {
    const e = byValue.get(v)
    return e ? offerable(e, menu.classType, families) : false
  }
  const preferred = menu.preference.find(runs)
  if (preferred !== undefined) return preferred
  if (typeof current === 'string' && (!byValue.has(current) || runs(current))) return current
  const first = menu.entries.find(e => offerable(e, menu.classType, families))
  if (first) return first.value
  return typeof current === 'string' ? current : undefined
}

type Catalog = Record<string, any>

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/**
 * One combo spec, adjusted: a new array, the input left untouched. Legacy
 * `[[...options], {config}]` and v2 `["COMBO", {options, ...}]` shapes both.
 * Null when the spec is not a combo.
 */
function patchSpec(spec: unknown, menu: ModelMenu, families: ReadonlySet<RunnerFamily>): unknown[] | null {
  if (!Array.isArray(spec)) return null
  const legacy = Array.isArray(spec[0])
  const config = { ...(plainObject(spec[1]) ?? {}) }
  const existing: unknown[] | null = legacy ? spec[0] as unknown[] : spec[0] === 'COMBO' && Array.isArray(config.options) ? config.options as unknown[] : null
  if (!existing) return null
  const def = menuDefault(menu, families, config.default)
  if (def !== undefined) config.default = def
  if (menu.kind === 'gallery') return legacy ? [existing, config, ...spec.slice(2)] : ['COMBO', config, ...spec.slice(2)]
  // Every value stays valid, hidden or not; a value only the engine lists is kept too.
  const values = menu.entries.map(e => e.value)
  const known = new Set(values)
  const options = [...values, ...existing.filter(v => typeof v !== 'string' || !known.has(v))]
  config.hidden_options = menuHiddenValues(menu, families)
  if (legacy) return [options, config, ...spec.slice(2)]
  config.options = options
  return ['COMBO', config, ...spec.slice(2)]
}

/**
 * Sailor's menus laid over a `/object_info` body (the full catalog or one
 * node's). For each dropdown it covers: `options` = every value (hidden and
 * runner-only ones too, so a saved value stays valid), `hidden_options` = the
 * values the menu leaves out, `default` = the first preference that can run
 * now. For each gallery: the `default` only.
 *
 * Copy on write: the classes it changes are new objects; the rest of the
 * body, and the body passed in, are untouched.
 */
export function applyModelOverlay<T extends Catalog>(catalog: T, families: ReadonlySet<RunnerFamily>): T {
  if (!plainObject(catalog)) return catalog
  let out: Catalog = catalog
  for (const menu of modelMenus()) {
    const node = plainObject(out[menu.classType])
    const sections = plainObject(node?.input)
    if (!node || !sections) continue
    for (const [name, section] of Object.entries(sections)) {
      const inputs = plainObject(section)
      if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, menu.input)) continue
      const patched = patchSpec(inputs[menu.input], menu, families)
      if (!patched) break
      if (out === catalog) out = { ...catalog }
      const current = out[menu.classType] as Record<string, unknown>
      out[menu.classType] = {
        ...current,
        input: { ...(current.input as object), [name]: { ...inputs, [menu.input]: patched } },
      }
      break
    }
  }
  return out as T
}

/**
 * The options a plain dropdown shows: the served options less the hidden
 * ones, except the node's current value, which stays (labelled "(hidden)")
 * so the node shows what it holds. `labels` is given only when some option
 * needs one: the menu's own label for a class Sailor decides, the value itself
 * otherwise.
 */
export function comboMenu(
  options: readonly string[],
  hidden: readonly string[] | undefined,
  current: unknown,
  labelOf?: (value: string) => string | undefined,
): { options: string[], labels?: string[] } {
  const hide = new Set(hidden ?? [])
  const shown = options.filter(v => !hide.has(v) || v === current)
  const anyHidden = shown.some(v => hide.has(v))
  if (!labelOf && !anyHidden) return { options: shown }
  const labels = shown.map((v) => {
    const label = labelOf?.(v) ?? v
    return hide.has(v) ? `${label} (hidden)` : label
  })
  return { options: shown, labels }
}

/** The tag a gallery puts on a model it would otherwise leave out: sentence case. */
export type GalleryTag = 'Hidden' | 'Discontinued'

/**
 * The models a gallery shows on a node of `classType`, in catalogue order:
 * the offerable ones, plus the node's current model whatever its flags,
 * tagged when the menu would otherwise leave it out (`hiddenTag`), with
 * `tag` saying why: "Discontinued" for a discontinued model, else "Hidden".
 */
export function galleryEntries<M extends ModelFlags & { id: string }>(
  models: readonly M[],
  opts: { classType: string, families: ReadonlySet<RunnerFamily>, current: string | null | undefined },
): { model: M, hiddenTag: boolean, tag: GalleryTag | null }[] {
  const current = typeof opts.current === 'string' ? menuKey(opts.classType, opts.current) : null
  const out: { model: M, hiddenTag: boolean, tag: GalleryTag | null }[] = []
  for (const m of models) {
    const shown = offerable(m, opts.classType, opts.families)
    if (shown) out.push({ model: m, hiddenTag: false, tag: null })
    else if (m.id === current) out.push({ model: m, hiddenTag: true, tag: m.discontinued ? 'Discontinued' : 'Hidden' })
  }
  return out
}
