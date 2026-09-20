import { makeShowcaseEffect } from './showcase'
import { totemLayout } from '../layouts/totem'

/** Card totem — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTotemEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showtotem', layout: totemLayout })
