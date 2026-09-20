import { makeShowcaseEffect } from './showcase'
import { coverringLayout } from '../layouts/coverring'

/** Cover ring — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCoverringEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcoverring', layout: coverringLayout })
