// Hue-arc direction, in ONE place. Pure — no Vue, no DOM.
//
// Two modules already walk a hue angle from one colour to another and each grew
// its own copy of "which way round the wheel": `mix.ts` (shortest arc, for a
// mix) and `composed.ts` (line 67, the long-way flip, for a palette arc). This
// is the shared primitive so a third copy — and a third chance to get the
// wrap/sign wrong — is not created. `hueWalk.ts` builds on it.
//
//   hueDelta — signed degrees h0→h1 along the chosen arc
//   walkHue  — the hue `t` of the way along that arc, wrapped to [0,360)

/** Normalise any angle to [0, 360). */
const norm = (h: number) => ((h % 360) + 360) % 360

/**
 * Signed degrees from `h0` to `h1`.
 *
 * `long === false` takes the SHORT arc — the smaller rotation, in (−180, 180].
 * `long === true` takes the complementary LONG arc — the same endpoints the
 * other way round the wheel, so its sign is opposite the short arc's.
 *
 * The 180° antipode is the deterministic seam: the short arc is exactly −180
 * (a defined choice, not a coin toss) and the long arc is therefore +180, so
 * the two stay opposite there too. When the hues are equal the short arc is 0
 * and the long arc is a full +360 loop.
 */
export function hueDelta(h0: number, h1: number, long: boolean): number {
  // Shortest signed arc in (−180, 180]; the antipode lands on −180.
  const short = norm(h1 - h0 + 180) - 180
  if (!long) return short
  // The complementary arc: same endpoints, opposite way. short>0 → go negative;
  // short<=0 (including the −180 antipode and the 0 same-hue case) → go positive.
  return short > 0 ? short - 360 : short + 360
}

/** The hue `t` of the way from `h0` to `h1` along the chosen arc, wrapped to
 *  [0, 360). Exact at the ends: t=0 → norm(h0), t=1 → norm(h1). */
export function walkHue(h0: number, h1: number, t: number, long: boolean): number {
  return norm(h0 + t * hueDelta(h0, h1, long))
}
