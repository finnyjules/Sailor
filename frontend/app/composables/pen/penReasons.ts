// app/composables/pen/penReasons.ts
// Pen stage 6: whether an action can run now, and — when it can't — why, in
// plain words (shown in the menu item's card, the wheel's note and the
// Properties + list). Copy rules as PEN_TIPS: sentence case, typographic ’.
export type ActionState = { ok: true } | { ok: false; reason: string }
export const OK: ActionState = { ok: true }
export const no = (reason: string): ActionState => ({ ok: false, reason })

export const REASON = {
  already: 'Already true',
  conflict: 'Conflicts with another rule',
  notHere: 'Doesn’t apply to this selection',
  nothing: 'Select something first',
  shape: 'Select a shape first',
  point: 'Select a point first',
  onePoint: 'Select one point first',
  notBetween: 'This point isn’t between two pieces',
  noMerge: 'These two sides don’t line up, so they can’t merge',
  emptyClip: 'Nothing to paste',
  openOnly: 'Only open lines can go here',
  noPieces: 'Nothing to select',
  // Mirror copies across a line: a line (or only lines) is the axis, not a copy
  mirrorLine: 'Select something to mirror besides the line',
  // Flip and Make guide work on whole pieces; an Option-picked segment is part of one
  wholePath: 'Select the whole path, not one segment',
} as const
