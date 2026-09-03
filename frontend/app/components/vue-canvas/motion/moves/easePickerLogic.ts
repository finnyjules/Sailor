// frontend/app/components/vue-canvas/motion/moves/easePickerLogic.ts
/**
 * Pure curve-string <-> `MoveEase` conversion for `EasePicker.vue`'s
 * "Custom curve" toggle. `CurveEditor.vue`'s `modelValue` is a
 * `[x1,y1,x2,y2]` JSON string (see its `apply`/`emit('update:modelValue', …)`
 * calls); `MoveEase`'s bezier variant (`~/lib/studio/moves/types`) carries
 * the SAME four numbers as `cps`, so this is a direct map, not a
 * transformation. PURE — no Vue import, no `lib/vectortype` import, so it is
 * cheaply unit-testable on its own (see
 * `tests/unit/studio-moves-easepicker.unit.spec.ts`).
 */
import type { MoveEase } from '~/lib/studio/moves/types'

/** CurveEditor's own default curve (see its `p = ref([0.42,0,0.58,1])`) —
 *  used both as the parse fallback and as what a NAMED ease (which has no
 *  `cps` of its own) shows while "Custom curve" is toggled on. */
const FALLBACK_CPS: readonly [number, number, number, number] = [0.42, 0, 0.58, 1]

/** Parse a `CurveEditor` modelValue string into a bezier `MoveEase`. Any
 *  string that isn't valid JSON, or doesn't decode to exactly four finite
 *  numbers, falls back to `FALLBACK_CPS` rather than throwing — a picker
 *  must never crash on a stray value. */
export function easeFromCurveString(s: string): MoveEase {
  try {
    const parsed = JSON.parse(s) as unknown
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      const [x1, y1, x2, y2] = parsed as number[]
      return { kind: 'bezier', cps: [x1!, y1!, x2!, y2!] }
    }
  } catch {
    // fall through to the default curve below
  }
  return { kind: 'bezier', cps: [...FALLBACK_CPS] }
}

/** The inverse: a `MoveEase` into the string `CurveEditor` wants. A bezier
 *  ease round-trips its own `cps`; a named ease (which has no curve of its
 *  own) reports `FALLBACK_CPS` so the editor has something sane to show the
 *  moment "Custom curve" is toggled on. */
export function easeToCurveString(ease: MoveEase): string {
  if (ease.kind === 'bezier') return JSON.stringify(ease.cps)
  return JSON.stringify(FALLBACK_CPS)
}
