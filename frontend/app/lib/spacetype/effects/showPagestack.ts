import { makeShowcaseEffect } from './showcase'
import { pagestackLayout } from '../layouts/pagestack'

/** Page stack — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showPagestackEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showpagestack', layout: pagestackLayout })
