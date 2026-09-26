import { makeShowcaseEffect } from './showcase'
import { splitcolumnsLayout } from '../layouts/splitcolumns'

/** Split columns — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showSplitcolumnsEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showsplitcolumns', layout: splitcolumnsLayout })
