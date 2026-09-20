import type { ControlSpec, ParamValue } from '~/lib/spacetype/effect'

/**
 * Evaluate a control's `showIf` — it appears only while another param matches.
 *
 * Shared because it was copy-pasted into SpaceTypeSurface and GradientStudioSurface
 * with identical bodies, and NOT into TextureStudioSurface or ShapeStudioSurface,
 * whose predicates checked only their own `when`. Those two therefore showed all 21
 * post-effect param sliders permanently, regardless of the effect's own switch —
 * a control declaring `showIf` was silently always-visible in exactly the studios
 * that had just been given a stack full of them.
 *
 * `read` is a getter rather than a params object because the surfaces differ:
 * Texture holds a flat record, Gradient and Shape a dotted proxy.
 */
export function showIfVisible(c: ControlSpec, read: (key: string) => ParamValue | undefined): boolean {
  if (!c.showIf) return true
  const v = read(c.showIf.key)
  if (c.showIf.equals !== undefined) return v === c.showIf.equals
  if (c.showIf.notEquals !== undefined) return v !== c.showIf.notEquals
  if (c.showIf.in !== undefined) return c.showIf.in.includes(v as ParamValue)
  if (c.showIf.notIn !== undefined) return !c.showIf.notIn.includes(v as ParamValue)
  if (c.showIf.matches !== undefined) return new RegExp(c.showIf.matches).test(String(v ?? ''))
  return true
}

/**
 * Group a studio's controls into ordered inspector sections.
 *
 * The `order` array is BOTH the ordering and the allow-list: a control whose group
 * is not listed is dropped, matching texturefx/sections.ts's documented contract
 * ("any control whose group is not listed here is silently dropped"). Sections that
 * end up empty are omitted, so a studio never renders a blank card.
 *
 * A group may be a PATH — 'Canvas/Shadow' puts Shadow inside Canvas. A parent named
 * only implicitly (its own path absent from `order`) is still created, holding no
 * controls of its own. Orders without slashes behave exactly as they did before
 * nesting existed.
 */
export interface Section<T> {
  title: string
  controls: T[]
  sections: Section<T>[]
}

export function groupIntoSections<T extends { group?: string }>(
  controls: T[],
  order: readonly string[],
  visible?: (c: T) => boolean,
): Section<T>[] {
  const byGroup = new Map<string, T[]>()
  for (const c of controls) {
    if (visible && !visible(c)) continue
    const g = String(c.group ?? '')
    if (!order.includes(g)) continue
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(c)
  }

  // Build every listed path as a tree node first, in `order`, so declaration order
  // still decides sibling order at every depth.
  const roots: Section<T>[] = []
  const index = new Map<string, Section<T>>()
  for (const path of order) {
    let full = ''
    let siblings = roots
    for (const part of path.split('/')) {
      full = full ? `${full}/${part}` : part
      let node = index.get(full)
      if (!node) {
        node = { title: part, controls: [], sections: [] }
        index.set(full, node)
        siblings.push(node)
      }
      siblings = node.sections
    }
    index.get(path)!.controls = byGroup.get(path) ?? []
  }

  // Then prune bottom-up: a node survives if it holds controls or a surviving child.
  const prune = (nodes: Section<T>[]): Section<T>[] =>
    nodes
      .map((n) => ({ ...n, sections: prune(n.sections) }))
      .filter((n) => n.controls.length > 0 || n.sections.length > 0)
  return prune(roots)
}
