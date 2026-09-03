// frontend/app/components/vue-canvas/motion/moves/moveCardLabel.ts
/**
 * Pure label text for `MoveCard.vue`'s collapsed row. PURE — no Vue import,
 * no `lib/vectortype` import, so it is cheaply unit-testable on its own (see
 * `tests/unit/studio-moves-movecardlabel.unit.spec.ts`), same pattern as
 * `easePickerLogic.ts` beside it.
 *
 * A `'tracks'` move with no real preset (`presetId` absent or `'custom'` —
 * the shape a hand-picked Custom dial always gets, see
 * `MoveGallery.vue`'s `dialCandidate`) has no catalog label anywhere, so it
 * is named after the dial it actually drives: `Custom · <last path
 * segment>`. Every other move — a kind the adapter declares (Vector Type's
 * `preset`/`blink`/`scatter`) or a `'tracks'` move built from a named track
 * preset (`presetId` a real id) — is named from the adapter (`kinds[kind
 * ].label`) or, failing that, its own `presetId`/`kind`, exactly the
 * fallback chain `MovesAdapter.kinds[k].cardBody`'s sibling `label` field
 * exists for.
 */
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move } from '~/lib/studio/moves/types'

/** The last `.`-separated segment of a config path (`'motion.blink.amount'` → `'amount'`). */
export function lastPathSegment(path: string): string {
  const parts = path.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function moveCardLabel(move: Move, adapter: MovesAdapter<any>): string {
  if (move.kind === 'tracks' && (!move.presetId || move.presetId === 'custom')) {
    const path = move.tracks?.[0]?.path
    return path ? `Custom · ${lastPathSegment(path)}` : 'Custom'
  }
  return adapter.kinds[move.kind]?.label ?? move.presetId ?? move.kind
}
