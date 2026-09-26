import { makeShowcaseEffect } from './showcase'
import { wipeLayout } from '../layouts/wipe'

/** Wipe reveal — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showWipeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showwipe', layout: wipeLayout })
