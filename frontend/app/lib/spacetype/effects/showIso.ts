import { makeShowcaseEffect } from './showcase'
import { isoLayout } from '../layouts/iso'

/** Iso cascade — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showIsoEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showiso', layout: isoLayout })
