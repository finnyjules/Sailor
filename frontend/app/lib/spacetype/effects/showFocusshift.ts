import { makeShowcaseEffect } from './showcase'
import { focusshiftLayout } from '../layouts/focusshift'

/** Focus shift — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showFocusshiftEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showfocusshift', layout: focusshiftLayout })
