import { makeShowcaseEffect } from './showcase'
import { medleyLayout } from '../layouts/medley'

/** Triple scene — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showMedleyEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showmedley', layout: medleyLayout })
