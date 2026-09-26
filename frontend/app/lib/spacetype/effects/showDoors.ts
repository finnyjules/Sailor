import { makeShowcaseEffect } from './showcase'
import { doorsLayout } from '../layouts/doors'

/** Through the doors — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showDoorsEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showdoors', layout: doorsLayout })
