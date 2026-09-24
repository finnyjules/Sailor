# Frame — Morph transition (design)

**Status:** approved in conversation 2026-09-23 ("that's great, plan and build").
**Origin:** a matvoyce "Slang" reference (type that pumps and morphs between looks) and the medial-pinning
spike (`/dev/morph-lab`), where Julien called the font-to-font morph "fantastic".

## What it is

A new **Out transition** in Frame's Motion tab: element A **morphs into** element B, another element on the
same Frame, over A's out bar. When the bar ends, B is already there and carries on.

Two styles, as two gallery tiles (Julien: "the any element into any element should be a separate transition
style"):

| Tile | What morphs | Covers |
|---|---|---|
| **Morph into…** (letter by letter) | each letter of A into the matching letter of B | same text in a new font; one word into another word |
| **Shape morph into…** | A's whole outline into B's whole outline | any element with an outline into any other: text, shapes, SVG paths |

## What you see

- In the Out gallery, both tiles add a **Morph** bar on A (default length 0.8 s, like every In/Out).
- The inspector for that bar has a **Morph into** picker listing the other elements that have an outline, a
  **Style** switch (Letter by letter / Whole shape) and the usual Easing, Start and Duration. Until a target
  is picked the bar does nothing and the inspector says so in one line.
- **Before the bar:** A as normal, B hidden.
- **During the bar:** one shape travelling from A's outline to B's, in B's real place on the Frame. Position,
  size and rotation travel because the outlines do. The fill colour blends from A's to B's; opacity blends.
- **After the bar:** A gone, B showing, with B's own look and motion.
- Easing works as for every transition, including **Steps**, which gives the held, on-twos feel of the
  reference.
- Dragging or resizing the bar moves the moment B appears. There is no separate link to keep in sync.
- The timeline shows the bar in a **Morph** row on A, like Reveal for Dither and Settle.

## Rules

1. **Hiding B.** An element that is the target of a morph is hidden until that morph's bar ends. A chain
   (A → B, then B → C on B's own out bar) works: B appears when A → B ends and leaves through its own morph.
2. **Letter by letter.** A's outline is split into pieces (a ring plus the holes inside it: one piece per
   letter, two for an `i`). Pieces pair in reading order (line by line, left to right) by an order-keeping
   alignment on position. When the counts differ, an extra piece **grows out of, or shrinks into, the piece
   it sits beside**, moving with it, so nothing flies off (the spike's "hole flies away" lesson).
3. **Whole shape.** A and B are each treated as one shape; rings pair outer↔outer and hole↔hole by
   position, and a hole only one side has closes (or opens) inside its enclosing ring, carried along.
4. **The engine** is the spike's centreline morph (row 3 in the lab): samples pair by where they sit on the
   letter (cyclic alignment on position, centreline point and facing), and the centreline, thickness and
   facing interpolate separately, smoothed, so strokes keep their weight while they turn. A counter only one
   side has shuts in the first half of the bar and opens in the second.
5. **Colour.** Solid ↔ solid blends. Anything else (gradient, shader fill) switches at the midpoint.
6. **Effects.** During the bar the moving shape keeps **A's** effects (not its geometry effects — they are
   already in its outline); **strokes are dropped** for the bar and long shadows sit it out; at the end B's
   own take over. (The approved sketch said effects cross-fade; that needs a second full effect pass per frame
   and is left for later — see Deferred. Strokes: amended 2026-09-24 — stroke widths are in different units per
   element kind, and a wrong width reads worse than none.)
7. **No outline, no morph.** If A or B has no outline (a photo, a system font, underlined or struck-through
   text, a font still loading) the bar becomes a **cross-fade**: A fades out while B fades in. Never an error.
8. **Dangling target.** If B is deleted the bar does nothing and A leaves as if it had no Out transition.
   No cleanup on delete; a duplicate keeps pointing at the original B (the sibling-reference rule).

## How it fits the code

- **Engine:** `app/lib/vectortype/medial.ts` moves to `app/lib/vector/medial.ts` (studio-agnostic, beside
  `morph.ts`). The rejected hand-rolled `weightGlyph` is removed from it (weight is a separate, later piece
  of work). New in the same folder: `morphPieces.ts` — split an outline into pieces, pair two piece lists in
  reading order, and `prepareMorph(dA, dB, style) → (t) => d` with a small cache (analysing a word costs
  ~100–300 ms, so it is done once per pair of outlines, not per frame).
- **Behaviour:** kind `morph`, params `{ target?: StackKey, style: 'letters' | 'shape', ease? }`. It
  compiles to ONE number track on a motion-only property `morph` (0 → 1 over the bar), so the bar gets a
  timeline row; `MOTION_ONLY_LABELS` gains `morph: 'Morph'` and the same "cannot be opened into keyframes"
  guard as `reveal`.
- **Fold:** `applyMorphBehaviours(layers, tracks, behaviours, t)` in `adapter/frame.ts`, after the reveal
  stage. It parks a transient `motionMorph { target, style, amount }` on A's clone while 0 < amount < 1,
  hides A at amount ≥ 1, and hides every target whose morph has not finished. Same array back when idle.
- **Drawing (amended 2026-09-24):** in `paintLayerStack`, after the fold, a layer carrying `motionMorph` is
  replaced by a transient **path** clone. The two SHAPES morph in their own scale-free local frames (so the
  cached analysis survives any movement, rotation or scale animation during the bar) and the placement —
  position, rotation along the shortest turn, skew and size — interpolates from A's to B's separately.
  Fill = the blended colour, A's non-geometry effects kept. Missing outline or an engine error → the
  cross-fade of rule 7.
- **Caches and gates:** `motionMorph` joins `SILHOUETTE_KEY_STRIP`; `hasMotion` already counts any
  behaviour, so export picks it up. Text outlines need the fontkit font; `warmCompositorFont` is called for
  A and B when the behaviour is added and before export.
- **Gallery / inspector:** two Out tiles in `gallery.ts`; a `morph` block in `MotionInspector.vue` with the
  target picker fed by a new `morphTargets` prop (the candidates rule of `geometrySiblingCandidates`:
  other local elements with an outline, no active corner pin, no cloner).
- **Lab:** `/dev/morph-lab` keeps working against the moved engine (its Thickness section is removed with
  `weightGlyph`).

## Testing

Unit (`tests/unit/`, `npx vitest run <file>`):
- engine: rest exactness (t = 0 and 1 give A's and B's samples), pairing is order-keeping, a counter only
  one side has shuts in the first half and stays inside its carrier, no NaN on degenerate input;
- pieces: splitting (letters, `i`, holes), reading-order pairing with unequal counts, extras carried;
- behaviour + fold: the track, B hidden before the end and shown after, A hidden after, the chain, the
  dangling target, the idle identity;
- colour blend; gallery tiles; the cross-fade fallback.

Live (browser pane on the existing :3002 server): two text elements in different fonts and a word into
another word, a text into a star, scrubbed and played with Steps; pixel-checked that B is hidden before the
bar and present after; an exported video.

## Deferred (not in this build)

- **Open question for Julien:** still renders (Design tab, image export, the canvas card, a web-export
  poster) run no clock, so A and B both draw on top of each other. Hiding B there would also hide it while
  it is being designed.
- A one-letter line of a short letter ("a" above "Tight") is read as part of the next line (a rule added in
  the final fix wave); fix = drop that rule.

- Effects cross-fading during the bar (rule 6).
- The Frame **card** on the canvas does not play Motion at all (programme-wide gap, unchanged).
- Vector Type Studio: a morph sequence in its Motion tab and the capped weight dial (needs `clipper-lib`
  in the frontend's dependencies — Julien's call).
- Pre-computing a morph off the main thread; today the first frame into a new pair pays ~100–300 ms.
