# Spike: 2D deformation field for typographic stretch (2026-09-02)

**Question.** Can deforming a glyph as a *body* — a lattice with stroke-aware,
anisotropic stiffness, solved as sparse least squares — clear the slice
engine's pile-2 residuals (extra inflections on stretched curves, uneven ring
thickness, the bell/turn/C1 patches) with only stiffness, zones and
constraints, no rules?

**Answer in one line.** Mixed, leaning *loses*: the field wins outright on the
`o` (0 inflections at Width 1.8 where the slice engine has 8, ring thickness
0.88 vs 0.78) and on zone alignment, ties the slice engine on Unbounded, and
loses on the `S` and `a` of Inter and Fraunces (more, and visible, ripples),
on stems under condense, and folds the lattice at deep condense.

Code: `frontend/app/lib/vectortype/stretch2d.ts` (engine),
`frontend/tests/unit/vectortype-stretch2d.unit.spec.ts` (probes; writes
`/tmp/spike-2d.txt`), `analyzeGrid` exported from `stretch.ts`, fourth column
in `frontend/app/pages/dev/stretch-lab.vue`. Commits `d9218a1f2`,
`cafcc4a67`, `767444e52`.

## The model as built

- **Lattice.** N×N vertices (N = 25 by default — see "lattice size" below),
  columns uniform over the glyph's **advance box** in X (sidebearings are part
  of the body: an `l`'s growth goes into its air, its stem stays), rows over
  the ink bbox in Y with the row nearest each zone line **snapped onto it**,
  so zone constraints are exact rather than half-a-cell off.
- **Stiffness per cell** from `analyzeGrid` (the shipped engine's 96×96
  nearest-boundary-tangent grid, exported unchanged), ink fraction `f`, mean
  over ink of the nearest boundary's alignment `ax²`, `ay²`:
  `kx = f·(base + strong·ay²) + (1−f)·soft` (a vertical stroke resists
  changing width), `ky = f·(base + strong·ax²) + (1−f)·soft`,
  `ks = f·shearBase + (1−f)·softShear`; cells the terminal patch or the
  small-feature pass made rigid: all three = `rigid`.
- **Energy — two decoupled systems.** x: `Σ kx·(Δdx)²/Lx` over horizontal
  edges + `Σ ks·(Δdx)²/Ly` over vertical edges; y: the mirror. Plus a tiny
  isotropic first-order smoothness on every edge. Both are weighted graph
  Laplacians, SPD once constrained. **Why decoupled:** the first build
  coupled x and y through the difference of the two diagonals' linearised
  strains (engineering shear, ∂dx/∂y + ∂dy/∂x). Under a *pure Height* dial
  the solver answered with local **rotations** — the o's shoulders turned,
  its flanks slid sideways by ±75 units at Width 1.0 — physically right for
  an elastic sheet, typographically wrong (L9 parallel strokes stay
  parallel, L14 slant is a constant). Penalising ∂dx/∂y and ∂dy/∂x
  *separately* forbids rotation, and that is exactly what makes the two
  systems independent. So: "shear acts within each system as a smoothness
  term along the stroke", as the brief allowed.
- **Constraints by elimination.** Left/right lattice columns → x·S. Rows on
  zone lines inside the bbox (baseline, x-height, cap, ascender, descender)
  → y·SY, baseline fixed; a glyph with no zone line inside it constrains its
  top/bottom rows. Everything else is free — including the overshoot slivers
  beyond the outermost zone line, which nothing pulls.
- **Solve.** Jacobi-preconditioned CG on the free DOFs (masked matvec over a
  fixed 9-slot stencil). Then a **compressive barrier**: any cell squeezed
  below 0.3× its rest size on an axis has that axis's stiffness ×20 and the
  system is re-solved, up to 3 times. Contact physics, not a typographic
  rule.
- **Apply.** Every outline coordinate (anchors and control points) maps
  through bicubic interpolation of the lattice *displacement* — Catmull-Rom
  in x, non-uniform cubic Hermite in y (snapped rows) — so the map is C1 and
  a curve crossing a cell edge picks up no curvature kink. Command count is
  constant by construction. Advance = advance × S (advance-box mode).

### Stiffness constants used (all in `DEFAULT_FIELD_OPTIONS`)

`n 25 · soft 0.05 · base 0.2 · strong 3.0 · shearBase 0.5 · softShear 0.05 ·
rigid 10 · smooth 0.01 · barrier floor 0.3 / gain 20 / 3 iters · bicubic ·
advance box · no blur · arithmetic ink mix`. The brief's suggested constants
verbatim, plus n = 25 (was 33) and the barrier. Two rounds of tuning were
spent (below); nothing else moved.

## Comparison table (from `/tmp/spike-2d.txt`, this commit)

```
2D deformation-field spike — 2026-09-02T20:35:10.000Z
field options: {"n":25,"soft":0.05,"base":0.2,"strong":3,"shearBase":0.5,"softShear":0.05,"rigid":10,"smooth":0.01,"advanceBox":true,"blur":0,"mix":"arithmetic","barrierIters":3,"barrierFloor":0.3,"barrierGain":20,"interp":"bicubic","maxIter":4000,"tol":1e-8}

INFLECTIONS  (drawn / slice / field)  — lower is better; drawn is the target
font        glyph  [1,2.5]       [1.8,1]       [0.7,2.41]    [0.5,1]       [0.96,1.56]   
inter-fix   o      0/0/0         0/8/0         0/12/8f12     0/8/24f50     0/0/0         
inter-fix   S      4/4/10        4/10/6        4/20/20f5     4/22/30f48    4/4/8         
inter-fix   a      6/10/14       6/10/10       6/18/24f10    6/24/36f67    6/8/14        
inter-fix   l      0/0/0         0/0/0         0/0/0         0/0/0         0/0/0         
inter       X      0/0/8         0/4/8         0/8/8f5       0/4/12f48     0/6/8         
inter       Y      3/3/7         3/3/7         3/7/7         3/7/7f64      3/3/7         
inter       A      0/4/0         0/4/4         0/0/0         0/4/4f79      0/4/0         
inter       o      0/0/0         0/8/0         0/12/8f12     0/8/24f50     0/0/0         
fraunces    a      7/9/25        7/9/11        7/15/29f1     7/17/33f120   7/15/21       
fraunces    S      8/12/18       8/14/18       8/18/26f3     8/28/34f108   8/14/18       
fraunces    o      0/0/0         0/8/8         0/4/12        0/6/18f122    0/0/0         
unbounded   S      4/8/12        4/10/10       4/18/24f6     4/22/22f72    4/6/10        
unbounded   a      4/4/4         4/8/4         4/4/6f2       4/28/26f93    4/4/4         
unbounded   o      0/0/0         0/8/8         0/12/8f12     0/8/12f90     0/0/0         
(fN = N folded lattice cells at that setting)

RING THICKNESS BY ANGLE  min/max of 24 bucket means (1 = even) — o
inter-fix   drawn 0.88   [1,2.5] slice 0.87 field 0.88   [1.8,1] slice 0.78 field 0.88
inter       drawn 0.88   [1,2.5] slice 0.87 field 0.88   [1.8,1] slice 0.78 field 0.88
fraunces    drawn 0.32   [1,2.5] slice 0.35 field 0.35   [1.8,1] slice 0.32 field 0.30
unbounded   drawn 0.78   [1,2.5] slice 0.77 field 0.80   [1.8,1] slice 0.78 field 0.80

ZONE ALIGNMENT  top(a)/top(o) at [1, 2.5]  (drawn / slice / field) — should stay ≈ drawn
inter-fix   1.0000 / 1.0010 / 1.0000    a top: drawn 1132 slice 2815 field 2809; o top: slice 2812 field 2809; xHeight×2.5 = 2795
inter       1.0000 / 1.0010 / 1.0000    a top: drawn 1132 slice 2815 field 2809; o top: slice 2812 field 2809; xHeight×2.5 = 2795
fraunces    0.9980 / 0.9980 / 0.9992    a top: drawn 992 slice 2426 field 2438; o top: slice 2431 field 2440; xHeight×2.5 = 2410
unbounded   1.0000 / 1.0000 / 1.0000    a top: drawn 580 slice 1415 field 1429; o top: slice 1415 field 1429; xHeight×2.5 = 1415

STEM WIDTH  'l' at [0.5, 1] and [2, 1]  new/old  (slice / field) — 1 = stem untouched
inter-fix   [0.5,1] slice 0.689 field 0.577 (no barrier 0.970)   [2,1] slice 1.000 field 1.060 (no barrier 1.060)
inter       [0.5,1] slice 0.689 field 0.577 (no barrier 0.970)   [2,1] slice 1.000 field 1.060 (no barrier 1.060)
fraunces    [0.5,1] slice 0.689 field 0.447 (no barrier 0.937)   [2,1] slice 1.000 field 1.126 (no barrier 1.126)
unbounded   [0.5,1] slice 0.689 field 0.797 (no barrier 0.961)   [2,1] slice 1.000 field 1.079 (no barrier 1.079)

COUNTER / FLANK  'o' at [0.5, 1]  mid-row counter and flank widths new/old (slice / field)
inter-fix   slice: counter 0.50 flank 0.69   field: counter 0.41 flank 0.77
inter       slice: counter 0.50 flank 0.69   field: counter 0.41 flank 0.77

ARCH THICKNESS  'o' at [1, 2.5]  mid-column arch thickness new/old (slice / field)
inter-fix   slice: bottom 1.00 top 1.00   field: bottom 1.03 top 1.03
inter       slice: bottom 1.00 top 1.00   field: bottom 1.03 top 1.03

SOLVER  glyph solves: 70; mean 5.1 ms, max 12.7 ms; mean CG iterations 133, max 169; barrier re-solves 78; lattice folds total 1079 — [1,2.5] 0, [1.8,1] 0, [0.7,2.41] 68, [0.5,1] 1011, [0.96,1.56] 0
```

Reading guide: `drawn / slice / field`; `fN` = N folded lattice cells at that
setting (folds are all at condense).

### Headline (asserted): Inter `o`

| setting | drawn | slice | field |
|---|---|---|---|
| Width 1.0, Height 2.5 | 0 | 0 | **0** |
| Width 1.8, Height 1.0 | 0 | 8 | **0** |

Passes. **But it is fragile**: the same glyph at Width 1.8 measures 8 at
n = 33, 4 at n = 49, 8 at n = 65, and 0 at n = 17 and 25. The count is decided
by where the lattice lines fall relative to the outline, not by the
constants (see "what was not emergent").

### The other glyphs, one line each (Height 2.5 · Width 1.8 · 0.7×2.41 · 0.5 — slice → field)

- Inter fixture `S` (drawn 4): 4→10 · 10→6 · 20→20 · 22→30 — worse tall, better wide, ties condensed-tall, worse condensed.
- Inter fixture `a` (drawn 6): 10→14 · 10→10 · 18→24 · 24→36 — worse or tie.
- Inter `X` (drawn 0): 0→8 · 4→8 · 8→8 · 4→12; `Y` (3): 3→7 everywhere; `A` (0): 4→0 · 4→4 · 0→0 · 4→4 — the field keeps the A's arms straighter, adds ripple to X/Y's junction curves.
- Fraunces `a` (drawn 7): 9→25 · 9→11 · 15→29 · 17→33 — the field's clearest loss; the ripples survive a 3° threshold (18 vs 7).
- Fraunces `S` (drawn 8): 12→18 · 14→18 · 18→26 · 28→34 — loses.
- Unbounded `S` (drawn 4): 8→12 · 10→10 · 18→24 · 22→22 — tie/lose; `a` (4): 4→4 · 8→4 · 4→6 · 28→26 — tie/win.
- Ring thickness by angle (`o`, min/max of 24 buckets, drawn 0.88): at Height 2.5 slice 0.87 / field 0.88; at Width 1.8 slice 0.78 / **field 0.88**. Fraunces (drawn 0.32): 0.35/0.35 and 0.32/0.30. Unbounded (0.78): 0.77/0.80, 0.78/0.80.
- Zone alignment, top(a)/top(o) at Height 2.5 (drawn 1.0000): slice 1.0010, field 1.0000; Fraunces drawn 0.9980 → slice 0.9980, field 0.9992; Unbounded 1.0000 both. The x-height line lands within 0.5% of 2.5× on every font.
- Stem width, `l` at Width 0.5 (slice 0.689 by schedule): field 0.577 with the barrier, 0.970 without; at Width 2.0: slice 1.000, field 1.060 (Fraunces 1.126).
- `o` at Width 0.5, mid-row: slice counter 0.50 flank 0.69; field counter 0.41 flank 0.77.
- Arch thickness, `o` at Height 2.5: slice 1.00/1.00, field 1.03/1.03.

### Per-glyph time

Mean **5.6 ms**, max 15 ms per glyph in vitest at n = 25 (analysis grid +
assembly + up to 4 PCG solves); mean 133 CG iterations, max 169. Without the
barrier re-solves ≈ 2.7 ms. n = 33 ≈ 5–7 ms, n = 49 ≈ 16 ms, n = 65 ≈ 37 ms.
Well inside the 20 ms budget.

## What was emergent, what was not

**Emergent (no rule written):**
- *Stroke thickness under stretch.* Flanks at Width 1.8 keep their width
  (ring ratio 0.88 = drawn) and arches at Height 2.5 grow 3% — the
  anisotropic stiffness alone does what the slice engine's min-channel plus
  turn taper do, and does it better on the wide `o`.
- *Zones are hard and shared* (L5) — by construction of the constraints.
- *Constant overshoot* (L8): the `o`'s 14-unit overshoot above the x-height
  stays 14 units at Height 2.5 because nothing pulls the sliver.
- *Sidebearings absorb an `l`'s growth* (advance box): stem 1.06 at Width 2
  without any stem rule.
- *Order of sacrifice, partially* (L2): at Width 0.5 the `o`'s counter gives
  first (0.41) and the flanks second (0.77) — from compliance alone. Then the
  barrier hands the rest to the ink.
- *Rounds stay round* for the `o` — no turn preset needed; the racetrack the
  slice engine had to fight does not appear.

**Not emergent:**
- *Curve harmony in general.* The extra inflections on the `S`/`a` are
  **lattice-scale ripple**: a stroke's boundary runs through partially inked
  cells whose stiffness staircases cell to cell; the displacement field
  inherits the staircase and the bicubic interpolation cannot hide it. The
  proof is the wrong-way resolution trend (finer lattice = more ripple).
  Tried and rejected: a 3×3 log-domain blur on the stiffness (no change),
  harmonic (series) ink/whitespace mixing (worse everywhere), higher shear
  stiffness, higher `strong`, lower `soft`, more smoothness. The C1 remap and
  the bell exist in the slice engine for exactly this reason and the field
  needs an equivalent — a smooth stiffness *representation* (distance-field
  based, not per-cell), which is a redesign, not a constant.
- *Stem schedule under condense* (L3/L4). The width target is a hard
  constraint, so a glyph whose whitespace has hit the barrier thins its ink
  to reach S: `l` at 0.577 vs the schedule's 0.689, and per glyph, not per
  run. The slice engine under-achieves S instead (leftover dropped). A soft
  width target would fix the `l` but then the `o` under-achieves too; the
  right answer is a run-level advance rule, which is a rule.
- *Straight strokes stay straight* (L9) — the `A`'s arms do (0 inflections
  at Height 2.5 where the slice has 4) but the `X`/`Y` gain ripple at the
  crossing curves, and there is no uniform-span guarantee.
- *Small marks rigid* (L1), *terminals keep their cut* (L6): honoured only
  because the analysis grid's flags were fed in as rigid cells — inherited
  from the slice engine's rules, not emergent.

## Blockers

1. **Folds at condense (structural).** A linearised spring has no barrier
   against a cell passing through zero, and the width target is hard. At
   Width 0.5 every glyph folds its sidebearing / counter cells (Fraunces `a`
   has no right sidebearing: its left one is driven to −60 units). The
   compressive barrier halves the total (1909 → 1079 cells over 70 solves)
   and keeps the ink out of the folds, but 68 cells still fold at 0.7×2.41
   and 1011 at 0.5. Clearing this needs a non-linear solve (true barrier
   energy or a projected solve), or a soft width target — either is beyond
   the spike. Recorded as an `it.fails` in the spec.
2. **Lattice-scale ripple** on curves (above) — the pile-2 residual the
   spike was meant to clear, and it does not.
3. **Sensitivity to lattice alignment**: the headline flips between 0 and 8
   with N. A result that depends on N this way cannot be shipped as-is.

## Verdict

**Mixed, and the field does not earn Phase B.** Where the field is right it
is *very* right — the wide `o` (0 inflections, drawn ring thickness), exact
zone alignment, constant overshoot, stems that stay put under expansion,
rounds that stay round — all from stiffness and constraints alone, in 5 ms,
and that is genuinely what the slice engine needed four patches to
approximate. But on the harder curves (`S`, `a`, Fraunces) it adds visible
ripple the slice engine does not, it folds at deep condense, and its
best number is decided by lattice alignment. Recommendation per the spec's
exit clause: **Phase B ships the slice engine with conservative ranges**, and
the field's *ideas* migrate — the advance-box lattice for sidebearings, the
no-rotation shear as a Y-axis "rows move together" rule, and above all the
finding that the destination is a smooth stiffness representation (stroke
vectors: skeleton + thickness), not a finer grid.
