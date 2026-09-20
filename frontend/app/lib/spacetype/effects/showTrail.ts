import { makeShowcaseEffect } from './showcase'
import { trailLayout } from '../layouts/trail'

/** Image trail — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTrailEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showtrail', layout: trailLayout })
