// The 3D object's add menu, shared by the Objects-tree plus and the inspector's "Add an effect"
// button so the two can never offer different lists.
import type { SceneObject } from '~/lib/scene3d/config'
import { TREATMENT_MENU_GROUPS, TREATMENT_LABELS, isFinishKind, canTakeFinish, type TreatmentKind } from '~/lib/scene3d/treatments'
import { MODIFIER_KINDS, MODIFIER_LABELS, modifierStackOf, isPinnedModifier, type ModifierKind } from '~/lib/scene3d/modifierStack'
import { TREATMENT_ICONS } from './Scene3DTreatmentRow.vue'
import { MODIFIER_ICONS } from './Scene3DModifierRow.vue'
import type { AddMenuGroup } from './GroupedAddMenu.vue'

/** Treatment families under plain names, then Modifiers (primitives only). A finish can never
 *  sit on a GLB, so it is left out there rather than greyed; a second one-per-object modifier
 *  is greyed with its reason. Modifier ids are prefixed so they never collide with a treatment. */
export function scene3dAddMenuGroups(object: SceneObject): AddMenuGroup[] {
  const groups: AddMenuGroup[] = TREATMENT_MENU_GROUPS.map(g => ({
    label: g.label,
    items: g.kinds.filter(k => !(isFinishKind(k) && !canTakeFinish(object))).map(k => ({
      id: k, kind: k, label: TREATMENT_LABELS[k], icon: TREATMENT_ICONS[k], testid: 'add-treatment-item',
    })),
  })).filter(g => g.items.length)
  if (object.kind === 'primitive') {
    const stack = modifierStackOf(object)
    const pinned = (k: ModifierKind) => isPinnedModifier(k) && stack.some(m => m.kind === k)
    groups.push({
      label: 'Modifiers',
      items: MODIFIER_KINDS.map(k => ({
        id: `mod:${k}`, kind: k, label: MODIFIER_LABELS[k], icon: MODIFIER_ICONS[k], testid: 'add-modifier-item',
        disabled: pinned(k) || undefined, title: pinned(k) ? 'Already added — only one is allowed' : undefined,
      })),
    })
  }
  return groups
}

export type Scene3DAddPick = { type: 'treatment'; kind: TreatmentKind } | { type: 'modifier'; kind: ModifierKind }
export function parseScene3dAddPick(id: string): Scene3DAddPick {
  return id.startsWith('mod:')
    ? { type: 'modifier', kind: id.slice(4) as ModifierKind }
    : { type: 'treatment', kind: id as TreatmentKind }
}
