import { makeShowcaseEffect } from './showcase'
import { danceLayout } from '../layouts/dance'

/** Position dance — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showDanceEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showdance', layout: danceLayout })
