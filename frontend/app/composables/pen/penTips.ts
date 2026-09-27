// app/composables/pen/penTips.ts
// What the pen toolbar's hover cards say (PenTipCard.vue): a name, the key
// badge when there is a shortcut, and a one-line caption — keyed by button id
// (tool ids, the fixed toolbar buttons, every rule kind availableConstraints
// can offer, and the rules row's own verbs). The nine drawing and editing
// tools also name a scripted demo in penTipDemos.ts.
//
// Copy rules: sentence case, no identifiers, say exactly what the button does
// in this pen (read the tool before changing a caption). Tool keys must match
// penKeys.ts TOOL_KEYS.

export interface PenTip {
  name: string
  /** shortcut as shown on a Mac (⌘ ⇧ glyphs); tipKeyLabel spells it for others */
  key?: string
  caption: string
  /** PEN_TIP_DEMOS key — only the drawing and editing tools */
  demo?: string
}

export const PEN_TIPS: Record<string, PenTip> = {
  // ── tools ──
  select: { name: 'Select', key: 'V', demo: 'select',
    caption: 'The resting tool. Click a shape to select it, drag a point to move it.' },
  path: { name: 'Pen', key: 'P', demo: 'path',
    caption: 'The path tool, a point at a time. Click to place a point, press on it and drag to bend the last piece into an arc.' },
  curve: { name: 'Bézier curve', key: 'B', demo: 'curve',
    caption: 'The smooth path tool. Click for a sharp point, drag to pull out handles and curve the piece into it.' },
  line: { name: 'Line', key: 'L', demo: 'line',
    caption: 'A single straight line. Click where it starts, then click where it ends.' },
  circle: { name: 'Circle', key: 'O', demo: 'circle',
    caption: 'A whole circle. Click the centre, then click again to set the size.' },
  point: { name: 'Point', key: 'N', demo: 'point',
    caption: 'A lone point to build from. Click to place it; near a shape it snaps on and stays there.' },
  trim: { name: 'Trim', key: 'T', demo: 'trim',
    caption: 'Removes a piece between crossings. Point to see the piece, click to remove it, or press and sweep across several.' },
  cut: { name: 'Cut', key: 'C', demo: 'cut',
    caption: 'A new point on a line or arc, splitting it in two. Click where the cut goes.' },
  dissolve: { name: 'Dissolve', key: 'D', demo: 'dissolve',
    caption: 'Cut’s inverse: a point healed back into one piece, where the two sides line up. Click the point.' },

  // ── toggles, history, path and session buttons ──
  guide: { name: 'Guide',
    caption: 'While on, new shapes are guides: they shape the drawing but aren’t drawn.' },
  labels: { name: 'Labels',
    caption: 'Shows the rules and sizes on the drawing.' },
  undo: { name: 'Undo', key: '⌘Z', caption: 'Takes back the last step.' },
  redo: { name: 'Redo', key: '⇧⌘Z', caption: 'Puts back the step you took back.' },
  close: { name: 'Close',
    caption: 'Joins the path back to its first point and finishes it.' },
  finish: { name: 'Finish', key: '↵',
    caption: 'Ends the path at its last point, left open.' },
  done: { name: 'Done', key: '↵',
    caption: 'Keeps the drawing and puts the pen away.' },
  cancel: { name: 'Cancel', key: 'Esc',
    caption: 'Puts the pen away without keeping this session’s changes.' },

  // ── rules (keyed by the rule kind availableConstraints offers, or its
  //    `tip` where the kind alone would name another card) ──
  coincident: { name: 'Coincident',
    caption: 'Joins two points into one. The first one you picked stays put, unless only the other one is fixed.' },
  onCurve: { name: 'On curve',
    caption: 'Keeps a point on the chosen line or arc piece; it can still slide along it.' },
  tangent: { name: 'Tangent',
    caption: 'Makes two pieces touch at one point without crossing. Pieces that already meet turn smoothly through the join.' },
  equalArcs: { name: 'Equal',
    caption: 'Makes two arcs the same radius.' },
  distance: { name: 'Distance',
    caption: 'Holds two points a set distance apart. Type the distance.' },
  concentric: { name: 'Concentric',
    caption: 'Gives two circles the same centre.' },
  tangentCircleCircle: { name: 'Tangent',
    caption: 'Makes two circles touch at one point without crossing.' },
  equalRadius: { name: 'Equal',
    caption: 'Makes two circles the same size.' },
  tangentLineCircle: { name: 'Tangent',
    caption: 'Makes a line touch a circle at one point without crossing.' },
  pointOnLine: { name: 'Point on line',
    caption: 'Keeps a point on a line; it can still slide along it.' },
  midpoint: { name: 'Midpoint',
    caption: 'Pins a point to the middle of a line or straight piece.' },
  pointOnCircle: { name: 'Point on circle',
    caption: 'Keeps a point on a circle’s edge; it can still slide around it.' },
  horizontal: { name: 'Horizontal',
    caption: 'Lays a line or segment flat.' },
  vertical: { name: 'Vertical',
    caption: 'Stands a line or segment straight up.' },
  radius: { name: 'Radius',
    caption: 'Holds a circle at a set size. Type the radius.' },
  perpendicular: { name: 'Perpendicular',
    caption: 'Sets two lines at a right angle, or squares off a corner.' },
  parallel: { name: 'Parallel',
    caption: 'Makes two lines run the same way.' },
  equalDist: { name: 'Equal',
    caption: 'Makes two lines the same length.' },

  // ── the rules row's own verbs ──
  fix: { name: 'Fix',
    caption: 'Pins the selected points where they are; rules and drags leave them in place.' },
  repeat: { name: 'Repeat…',
    caption: 'Copies the selection around a ring. Type how many, then click the centre.' },
  mirror: { name: 'Mirror',
    caption: 'Copies the selection across a line. Pick the line; the copy follows the original.' },
  'flip-h': { name: 'Flip horizontal',
    caption: 'Flips the selection left to right, in place.' },
  'flip-v': { name: 'Flip vertical',
    caption: 'Flips the selection top to bottom, in place.' },
  construction: { name: 'Make guide',
    caption: 'Turns the selection into guides that shape the drawing but aren’t drawn, or back again.' },
  delete: { name: 'Delete', key: '⌫',
    caption: 'Removes the selection.' },
}

/** A tip's key badge text: Mac glyphs as-is on a Mac, spelled out elsewhere
 *  (⌘Z → Ctrl+Z, ⇧⌘Z → Ctrl+Shift+Z). */
export function tipKeyLabel(key: string, isMac: boolean): string {
  if (isMac || !/[⌘⇧]/.test(key)) return key
  const mods: string[] = []
  if (key.includes('⌘')) mods.push('Ctrl')
  if (key.includes('⇧')) mods.push('Shift')
  return [...mods, key.replace(/[⌘⇧]/g, '')].join('+')
}
