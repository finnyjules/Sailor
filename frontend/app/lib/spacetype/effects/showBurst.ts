import { makeShowcaseEffect } from './showcase'
import { burstLayout } from '../layouts/burst'

/** Poster burst — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showBurstEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showburst', layout: burstLayout })
