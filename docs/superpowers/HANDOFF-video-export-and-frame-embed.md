# Handoff: browser video export ↔ Frame web export

For the session building Frame web export (`docs/superpowers/specs/2026-09-21-frame-web-export-design.md`), from the session building browser video export (`docs/superpowers/specs/2026-09-21-browser-video-export-design.md`). Written 2026-09-22.

## What the video-export work is doing

Every studio's "Download video" / "As video" moves from the server (PNG per frame → upload → server encode) to the browser (frames → `mediabunny` → one file). Plan 1 (`docs/superpowers/plans/2026-09-22-browser-video-export-studios.md`) covers Shader, Gradient, Space Type and 3D Studio. **It does not touch the Frame / Compositor, and it does not edit anything under `frontend/app/lib/embed/`.**

## What we will need from you, later

Plan 2 of the video work switches the Frame's video export. It will wait until your Frame work has landed, so the two sessions never edit how a Frame draws at the same moment. Two small requests:

1. **Keep "draw the Frame at time t" as one plain function**, separate from the code that mounts it into a web page. Today that is `renderCompositeAtTime(t)` in `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (~line 907): it pulls every wired layer to its moment, awaits it, then paints the stack. The video recorder calls exactly that, once per frame, and needs it to stay awaitable (a wired video has to decode its frame first). If your work moves or renames it, a one-line note here is enough.
2. **Say when it lands** — a line at the bottom of this file, or in `docs/STATE.md`.

## What we will build on your side of the seam (read-only)

A small bridge, `frontend/app/lib/engine/recordEmbed.ts`, so the video recorder can export anything that implements the embed contract (`frontend/app/lib/embed/contract.ts`: `mount` / `setTime` / `setSize` / `destroy`). It only READS the contract. If you change the contract's shape, the bridge follows you, not the other way round.

## Notes for your side

- The embed contract's `setTime` is synchronous by design; video export deliberately does not rely on it for wired Frames (they must wait on decodes). Nothing for you to change.
- The recorder copies a WebGL canvas onto its own 2D canvas right after each render — the same "drawImage off a studio WebGL canvas reads stale" trap your contract comment describes.

---

_Landed notes (append below):_
