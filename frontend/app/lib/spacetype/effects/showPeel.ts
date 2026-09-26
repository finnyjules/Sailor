import { makeShowcaseEffect } from './showcase'
import { peelLayout } from '../layouts/peel'

/** Peel — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showPeelEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showpeel', layout: peelLayout })
