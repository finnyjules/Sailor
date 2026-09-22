# Cloner motion — design

Date: 2026-09-21. Surface: the Frame compositor's **Motion tab** (the unified `motionx` timeline). Status: approved in conversation ("approach A yes"); this document is the record.

## In plain words

Three things Julien asked for on 2026-09-21, in one slice:

1. **Duplicating a layer keeps its motion.** Today ⌘D or copy/paste gives you a second layer with an empty Motion tab, because bands and behaviours are stored on the Frame keyed by layer id. The copy should arrive with the same bands and behaviours, at the same times, so the two play together until you drag one.
2. **Copies can stagger.** A layer with the Cloner on gets a **Copies** card in its Motion tab: **Stagger** (seconds between one copy and the next) and **Order** (First to last · Last to first · Centre out · Random). Copy *k* sees the layer's whole Motion tab later by its rank × stagger — bands, letter behaviours, Dither and Settle transitions, everything. Stagger 0 is exactly today's picture.
3. **The Cloner itself can be animated.** Its dials (Count, Spacing, Nudge, Radius, Start angle, Sweep, Step rotation, Step scale, Step opacity) become properties in Add property under a **Copies** group, and five tiles in the Add behaviour gallery — a **Copies** group beside In / Out / Letters — set the common moves up from where the layer already is.

Every default is the identity: a Frame saved before this renders byte-for-byte as before.

## Part 1 — Duplicate keeps the motion

**Where.** `useLocalLayerEditor.ts` — `duplicateSelection()`, `pasteClipboard()`, and the clipboard payload built by `extractForCopy` / consumed by `materializePaste` in `lib/compositor/layerEdits.ts`. The editor already reads and writes the authored motion (`sailor_motion.motionx`, `.behaviours`, `.tracks`) for undo (`readMotionSnap` / `writeMotionSnap`), so it has what it needs.

**The pure core.** One new function in `lib/motionx/adapter/duplicateMotion.ts`:

```ts
/** Every band, behaviour and effect-dial track aimed at a layer in `idMap`'s keys,
 *  re-targeted at the mapped id. Fresh behaviour ids; a compiled track keeps pointing at
 *  its (fresh) behaviour. Deep copies — nothing shared with the originals. */
export function motionForCopies(
  motion: { motionx?: Track[]; behaviours?: StoredBehaviour[]; tracks?: EffectDialTrack[] },
  idMap: ReadonlyMap<string, string>,
  newBehaviourId: () => string,
): { motionx: Track[]; behaviours: StoredBehaviour[]; tracks: EffectDialTrack[] }
```

- Track paths are `layers.<id>.<prop>`; the id segment is swapped. Keyframes are deep-copied. A track's `behaviourId` is mapped through the behaviour id map so the copy's bands stay bars, not orphaned tracks.
- A `StoredBehaviour`'s `layerId` is swapped and it gets a fresh `id`.
- Legacy effect-dial tracks (`tracks`: `EffectDialTrack.target` is the id-path `layers.<layerId>.effects.<effectId>.<dial>`) have the same id segment swapped; effect ids are copied verbatim by `duplicateLayers`, so the rest of the path already matches the copy.
- Entries aimed at ids not in the map are not returned (the caller appends the result to the existing lists).

**Wiring.**
- `duplicateSelection`: `duplicateLayers` returns `newIds` in the order of the selected clonable layers; it gains an `idMap: Map<string, string>` (old → new) in its return so the correspondence is explicit. After it returns, call `motionForCopies` on the current snapshot and append. Inside the existing `recordHistory()` step, so ⌘Z removes layers and motion together.
- Clipboard: `extractForCopy` gains a `motion` field (the entries for the copied ids, un-remapped); `materializePaste` remaps them with its own id map. Pasting into a different Frame therefore carries the motion. An older clipboard payload without `motion` pastes as today.
- The per-layer legacy `animation` block already rides on the layer; nothing changes there.

**Tests.** `motionForCopies`: re-targets bands and behaviours, fresh behaviour ids, compiled track ↔ behaviour link preserved, untouched ids ignored, deep copy (mutating the result leaves the input alone). Editor-level: duplicate a layer with two bands and a Settle-in → the new layer has two bands and a Settle-in at the same times; one undo removes both layer and motion; paste across frames carries them.

## Part 2 — Copies stagger

**Storage.** On the Cloner object (so it travels with duplicate/copy and lives with the thing it configures; the *authoring* is in the Motion tab, per the rule that motion is authored only in motion surfaces):

```ts
// useCloner.ts, interface Cloner
/** Motion stagger: seconds between one copy's clock and the next. 0 = unison (today). */
motionStagger?: number
/** Which copy goes first. */
motionOrder?: 'first' | 'last' | 'centre' | 'random'
motionSeed?: number
```

(`staggerX/Y` already exist on the Cloner and mean the brick offset — hence the `motion` prefix. UI label is still "Stagger".)

**The clock of copy k.** `lib/motionx/copies.ts` (pure):

```ts
export function copyRanks(n: number, order: CopyOrder, seed: number): number[]   // rank per copy index k (0 = original)
export function copyClock(t: number, k: number, n: number, cloner: Cloner): number // t − rank(k)·stagger
```

- `first`: rank = k. `last`: rank = n−1−k. `centre`: rank by distance from the middle index (ties: lower k first). `random`: a seeded shuffle (the seed from `motionSeed`; default 1).
- `k` is the Cloner's own copy index as `expandClones` numbers it (`c.k`, 0 = the original); `n` is `c.n`.

**Painting (approach A).** In `paintLayerStack` (useCompositorLayers.ts), the fold currently produces one motion state per layer for the frame's clock and hands it to the painter, which stamps the Cloner's copies from that one state. With a stagger set:

- the stack paints the layer **once per copy**, each time (a) folding the layer's motion at `copyClock(t, k, …)` and (b) narrowing the Cloner to that one copy — `expandClones` gains an optional `only: k` so it returns just the k-th transform (position, falloff, tint all as today);
- copies are painted in the order `expandClones` would have stamped them (back to front, original last), so overlap looks the same;
- everything downstream is untouched: masks, defocus, Vary tint, Pixels/Assemble/Settle solo draws and letter behaviours all run per copy exactly as they run per layer today.

With stagger 0 (or no Cloner) the stack takes the existing path — not a re-implementation of it — so the byte-identity of old Frames is structural. The cost with a stagger is one full layer paint per copy instead of one paint plus N stamps; that is the price of per-copy effects and it is only paid when a stagger is set.

**Bake/export.** The bake goes through the same `paintLayerStack`, so it gets this for free; the export pre-warm for shader transitions (`ensureRevealShadersReady`) is unchanged.

**UI.** `MotionInspector.vue`, a **Copies** card shown only when the selected layer has `cloner.enabled` and nothing else is selected in the timeline (it is a layer-level setting, like the letter card's position): a `StudioSlider` **Stagger** (0–2 s, step 0.01, default 0) and a `StudioSegmentedRow` **Order** (First to last · Last to first · Centre out · Random); a **Seed** shuffle button beside Order appears only for Random (same pattern as the letter behaviours' shuffle). Writes go through the editor's cloner setter so they are one undo step each and coalesce during a drag.

**Tests.** `copyRanks` for all four orders (including odd/even centre-out and a fixed-seed shuffle being a permutation and repeatable); `copyClock`; `expandClones` with `only`; a painter-level test that a staggered cloner layer paints its content once per copy with distinct clocks (through the existing recorder-fake harness), and that stagger 0 paints exactly as before (call-log equality against the un-staggered run).

## Part 3 — The Cloner's dials as motion properties

**Property list.** `animatableProperties(layer)` (lib/motionx/adapter/frame.ts) appends a **Copies** group when `layer.cloner?.enabled`, showing only the dials that apply to the current mode:

| Mode | Path (`layers.<id>.cloner.<key>`) | Label | Range |
|---|---|---|---|
| linear | `countX`, `countY` | Count X, Count Y | 1–50 |
| linear | `spacingX`, `spacingY` | Spacing X, Spacing Y | −1–1 |
| linear | `nudgeX`, `nudgeY` | Nudge X, Nudge Y | −0.5–0.5 |
| radial | `count` | Count | 1–100 |
| radial | `radius` | Radius | 0–1 |
| radial | `startAngle` | Start angle | −360–360 |
| radial | `sweepAngle` | Sweep | 0–360 |
| both | `stepRotation` | Step rotation | −180–180 |
| both | `stepScale` | Step scale | 0–2 |
| both | `stepOpacity` | Step opacity | 0–1 |

`PropertyGroup` gains `'Copies'`. Labels in sentence case; the group heads the picker after Effects.

**Fold.** `applyResolvedValue` gains a `cloner.<key>` case: `{ ...layer, cloner: { ...layer.cloner, [key]: value } }` when the layer has a cloner (else identity). Counts need no rounding here — `expandClones` already floors them, so a rising Count adds copies one at a time.

**Behaviour target.** `frameTarget(layer).get('cloner.<key>')` returns the current dial value (so a tile compiles "from where the layer already is"). `has` follows.

**Agent.** The agent's property vocabulary is derived from `animatableProperties`, so it gains these paths with no separate work; the implementer confirms the hint budget (the cap was raised to 27,700 on 09-15) still holds and reports the number.

**Tests.** The property list for a linear and a radial cloner (and none without a cloner); the fold on `cloner.count`; a Count band from 1 → 6 producing 1, 2, … 6 copies at the right instants through `expandClones`; `frameTarget.get('cloner.radius')`.

## Part 4 — Five tiles in the Add behaviour gallery

Group **Copies** (`needs: 'cloner'`, offered only when the layer's Cloner is on — `GalleryTile.needs` gains `'cloner'`). Each is a behaviour kind that compiles, via the existing compile path, to tracks on the cloner properties above, relative to the layer's current values:

| Tile | Kind · params | What it does |
|---|---|---|
| Copies build in / out | `copies.build` `{dir}` | Count (radial) or Count X (linear) from 1 to the current value (in) or back (out). Linear ease by default — the floor in `expandClones` makes it stairs. |
| Spread out / Gather in | `copies.spread` `{dir}` | Radius (radial) or Spacing X and Y (linear) from 0 to current (out = spread) or current to 0 (in = gather). |
| Ring spins | `copies.spin` | Start angle from current to current + 360, looping; radial only (the tile is hidden for a linear cloner). |
| Fan in / out | `copies.fan` `{dir}` | Step rotation from 0 to the current value — or to 360 ÷ count (radial) / 15° (linear) when the current value is 0. |
| Fade along | `copies.fade` `{dir}` | Step opacity from 0 to current (in) or current to 0 (out). |

Inspector: the same rows a Fade or Slide bar has today (Direction where the kind has one, Easing card, Open into keyframes). The default ease is `linear` for `copies.build` and `copies.spin`, the gallery default for the rest. Previews: one `copies` preview kind — a small ring or row of dots whose count / spread / spin / opacity follows the tile's own maths, so the tile shows what it does (same discipline as the settle previews).

**Tests.** Each kind compiles to the expected property path(s) and endpoints for a radial and a linear cloner (spin absent for linear; fan's fallback angle); the gallery offers the group only with a cloner; `swapLetterMove`-style in-place swap is NOT extended (YAGNI — the tiles are property bars; Open into keyframes covers it).

## Out of scope

- A per-copy stagger on the living-image clip (Phase already does that) or on Vary.
- A stagger that counts in copies of *time between bars* (only the whole Motion tab shifts).
- Animating the Cloner's mode, mirror switches or Vary settings (booleans / enums are not animatable, as with effects).
- Tiles for the 3D Studio cloner.

## Verification

Unit suites `motionx`, `compositor` (both "Test Files" and "Tests" lines read). Live on `http://127.0.0.1:3002/dev/frame-lab` with a ring-cloner text layer added to the lab fixture: (1) ⌘D on a layer with two bands and a Settle-in → the copy has them, undo removes both; (2) stagger 0.15 s + Order First to last on a Settle-in → pixel probes show copy k at a later strength than copy k+1 at one instant, and stagger 0 is byte-identical to before (frame hash); (3) a Count band 1 → 6 shows 1…6 copies at the right instants; (4) each tile applied once, a contact sheet sent.
