import { makeShowcaseEffect } from './showcase'
import { ringLayout } from '../layouts/ring'
import { getLayout, SHOWCASE_LAYOUTS } from '../layouts/index'

/**
 * RING — the Kinetic Studio keystone effect: photos and words ride one arrangement,
 * spinning on a circle. The first Showcase layout, and the only one whose id is not
 * `show…`: scenes have been saved under `ring` since before layouts existed.
 *
 * For a while every layout lived under this one id, chosen by a `layout` param. Each is now
 * its own effect (./showCoverflow.ts, …), but a scene saved in between still says
 * `effectId: 'ring', params.layout: 'sphere'` — `legacyLayout` keeps it drawing as a sphere
 * wall everywhere, and the editor re-homes it to `showsphere` when it is next opened.
 */
// /* @__PURE__ */ is load-bearing: effects/index.ts imports every effect module, and without
// it Rollup must keep this call (and the whole Showcase host + layout behind it) in EVERY
// per-effect embed bundle — see the same note on SPACE_TYPE_EFFECTS in ./index.ts.
export const ringEffect = /* @__PURE__ */ makeShowcaseEffect({
  id: 'ring',
  layout: ringLayout,
  legacyLayout: saved => (SHOWCASE_LAYOUTS.some(l => l.id === saved.toLowerCase()) ? getLayout(saved) : undefined),
})
