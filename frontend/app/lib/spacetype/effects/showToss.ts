import { makeShowcaseEffect } from './showcase'
import { tossLayout } from '../layouts/toss'

/** Card toss — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTossEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showtoss', layout: tossLayout })
