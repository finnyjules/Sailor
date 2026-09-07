import { describe, it, expect } from 'vitest'
import { PANEL_EFFECT_KINDS } from '~/components/vue-canvas/PostEffectsControls.vue'
import { EFFECT_ORDER, isPinnedKind, type EffectKind } from '~/lib/compositor/effectStack'

/**
 * The Compositor's effect inspector asks `isPanelKind(kind)` to decide whether
 * `PostEffectsControls` can draw the selected effect. That question used to be answered by
 * a hand-kept literal list in the modal, which is one place for the truth too many: add a
 * section to the panel and the modal would keep routing that kind to its own empty branch,
 * or worse, route a kind the panel does not draw into a blank body.
 *
 * So the modal now reads the panel's own exported section list, and this pins that list to
 * the stack's vocabulary.
 */
describe('PANEL_EFFECT_KINDS', () => {
  it('only names kinds the effect stack knows', () => {
    for (const k of PANEL_EFFECT_KINDS) {
      expect(EFFECT_ORDER as readonly string[]).toContain(k)
    }
  })

  it('is exactly the seven kinds the panel draws', () => {
    expect([...PANEL_EFFECT_KINDS].sort()).toEqual(
      ['adjust', 'bloom', 'dof', 'duotone', 'gradientMap', 'grain', 'vignette'],
    )
  })

  it('has no duplicates', () => {
    expect(new Set(PANEL_EFFECT_KINDS).size).toBe(PANEL_EFFECT_KINDS.length)
  })

  // Depth of field is pinned (it runs before the layer is placed) yet the panel still
  // draws its dials — pinning constrains ORDER, not who owns the controls. The other six
  // are orderable chain kinds. If that ever inverts, the inspector's routing needs a look.
  it('draws exactly one pinned kind, depth of field', () => {
    const pinned = PANEL_EFFECT_KINDS.filter(k => isPinnedKind(k as EffectKind))
    expect(pinned).toEqual(['dof'])
  })
})
