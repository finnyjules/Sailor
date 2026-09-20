import { makeShowcaseEffect } from './showcase'
import { domeLayout } from '../layouts/dome'

/** Curved wall — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showDomeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showdome', layout: domeLayout })
