import type { LayoutDef } from '../kit/types'
import { runoff } from './swissCore'

// The layout catalog on the kit. ORDER MATTERS: a layout's index seeds its random choices
// (`rngFor(7000 + index·97 + 13 + arr·7919)`, as in the prototype), so new layouts are
// appended in the prototype's own order and existing ones never move.
export const LAYOUTS: LayoutDef[] = [runoff]

export function layoutById(id: string): LayoutDef | undefined {
  return LAYOUTS.find(l => l.id === id)
}

/** Tests only: add a layout to the catalog. Returns a function that removes it again. */
export function __registerLayoutForTest(def: LayoutDef): () => void {
  LAYOUTS.push(def)
  return () => {
    const i = LAYOUTS.indexOf(def)
    if (i >= 0) LAYOUTS.splice(i, 1)
  }
}
