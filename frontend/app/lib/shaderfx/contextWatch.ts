// WebGL context loss watcher (AI in Sailor spec §7.5): a shader that hangs the
// GPU makes the browser drop the context. preventDefault on `webglcontextlost`
// is what lets `webglcontextrestored` fire at all (Scene3D's engine does the
// same in app/lib/scene3d/engine.ts).

/** Watch `target` (a canvas) for WebGL context loss/restore. Returns a detach fn. */
export function attachContextWatch(target: EventTarget, hooks: { onLost(): void; onRestored(): void }): () => void {
  const lost = (e: Event) => { e.preventDefault(); hooks.onLost() }
  const restored = () => hooks.onRestored()
  target.addEventListener('webglcontextlost', lost)
  target.addEventListener('webglcontextrestored', restored)
  return () => {
    target.removeEventListener('webglcontextlost', lost)
    target.removeEventListener('webglcontextrestored', restored)
  }
}
