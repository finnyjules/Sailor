// The effect a canvas Shader effect node shows, read from its own `effect` widget and named
// through the live catalog (a My effect's own name, never an id). Pure: the caller passes the
// catalog's effects, so a new My effect or a rename names the node at once.
import { resolveEffectId } from '~/lib/shaderfx/catalogStore'
import type { EffectDef } from '~/lib/shaderfx/types'

type NodeData = { widgetDefs?: { name?: string }[]; widgetsValues?: unknown[] } | null | undefined

/** The node's saved effect id ('' when none is picked). */
export function nodeEffectId(data: NodeData): string {
  const i = data?.widgetDefs?.findIndex(w => w?.name === 'effect') ?? -1
  const v = i >= 0 ? data?.widgetsValues?.[i] : null
  return v == null ? '' : String(v)
}

/** The node's effect, when one is picked and the catalog knows it. */
export function nodeEffectDef(data: NodeData, effects: readonly EffectDef[] | null | undefined): EffectDef | null {
  const id = nodeEffectId(data)
  if (!id || !effects) return null
  const want = resolveEffectId(id)
  return effects.find(e => e.id === want) ?? null
}
