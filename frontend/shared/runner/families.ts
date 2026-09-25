/**
 * Runner families: groups of node classes the runner takes on, each behind
 * its own switch. The switch is a comma list, one per side:
 *   NUXT_RUNNER_FAMILIES=fal-edit,replicate-image          server (the authority)
 *   NUXT_PUBLIC_RUNNER_FAMILIES=fal-edit,replicate-image   browser routing
 * A family works only when the runner itself is switched on. Every family is
 * off by default: with none on, the runner takes exactly what it took before.
 */
export type RunnerFamily =
  | 'fal-edit'
  | 'replicate-image'
  | 'replicate-video'
  | 'nano-actions'
  | 'ref-edits'
  | 'restyle'
  /** The Frame render (Compositor), computed by the runner itself: no provider, no charge. */
  | 'frame'

export const RUNNER_FAMILIES: readonly RunnerFamily[] = [
  'fal-edit', 'replicate-image', 'replicate-video', 'nano-actions', 'ref-edits', 'restyle', 'frame',
]

const KNOWN: ReadonlySet<string> = new Set(RUNNER_FAMILIES)

/** No family switched on. */
export const NO_FAMILIES: ReadonlySet<RunnerFamily> = new Set()

/**
 * A comma list of family names → the set. Unknown names are dropped; anything
 * unreadable (not a string or a list of strings) is no families at all.
 */
export function parseFamilies(raw: unknown): ReadonlySet<RunnerFamily> {
  let parts: unknown[]
  if (typeof raw === 'string') parts = raw.split(',')
  else if (Array.isArray(raw)) parts = raw
  else return NO_FAMILIES
  const out = new Set<RunnerFamily>()
  for (const p of parts) {
    if (typeof p !== 'string') continue
    const name = p.trim().toLowerCase()
    if (KNOWN.has(name)) out.add(name as RunnerFamily)
  }
  return out
}

/**
 * How a model sits in Sailor's menus (the image and video catalogues and the
 * plain model dropdowns, app/data/edit-model-options.ts). Pure data; the
 * rules that read it are in ./modelMenus.ts and ./blockedModels.ts.
 *   hidden        left out of the menus; still runs, prices and remaps
 *   discontinued  the ISO date its service stopped it: hidden, and a run using it is refused
 *   runnerOnly    no engine (ComfyUI) builder: runs only in Sailor's runner
 *   family        the runner switch that turns a runner-only model on
 */
export interface ModelFlags {
  hidden?: true
  discontinued?: string
  runnerOnly?: true
  family?: RunnerFamily
}
