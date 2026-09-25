// While an effect-take set is open on a Shader studio layer, that layer is read-only
// (stage 5 Task 9): × and Stop put back the layer as it was when the set opened, so an
// edit made meanwhile would be lost. Derived from the session each time, so a set that
// closes by any path (Keep, ×, Stop, a new request, unmount) can never leave it stuck.
// Pure.

/** The layer the open set previews on is locked; other layers stay editable. */
export function takeLayerLocked(o: { setOpen: boolean; activeLayerId: string | null | undefined; takeLayerId: string | null }): boolean {
  return o.setOpen && !!o.takeLayerId && o.activeLayerId === o.takeLayerId
}

/** Adding, removing, duplicating or reordering layers moves the layer the set restores
 *  (it is addressed by index), so the stack's shape holds still while any set is open. */
export function takeStackLocked(o: { setOpen: boolean }): boolean {
  return o.setOpen
}

/** The footer's exports and outputs (Download PNG/video, Export embed, As image/video) wait
 *  while any set is open: they render what is on screen, and a previewed take is a draft that
 *  must never be delivered or put on the canvas unkept. */
export function takeOutputsLocked(o: { setOpen: boolean }): boolean {
  return o.setOpen
}
