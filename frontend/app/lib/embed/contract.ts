/**
 * The contract every embeddable studio implements. Deliberately four methods:
 * set up, draw at a normalized time, react to a size change, clean up.
 *
 * `container` rather than `canvas`: ShaderFxRenderer, GradientFxRenderer and the
 * texturefx renderer each already own their canvas and GL context and hand the
 * canvas back. Adapters append that canvas here. Handing them a canvas to draw
 * into would force a per-frame copy, and drawImage off a studio WebGL canvas is
 * known to read stale in this codebase.
 */
export interface EmbedCaps {
  /** True only if this surface genuinely renders with a transparent background. */
  alpha: boolean
}

export interface EmbedHandle {
  /** Draw at normalized loop position. Synchronous — no awaits in the hot path. */
  setTime(t01: number): void
  setSize(w: number, h: number): void
  destroy(): void
}

export interface EmbedSurface {
  readonly kind: string
  readonly caps: EmbedCaps
  /** All compiling, decoding and asset inflation happens here, once. */
  mount(container: HTMLElement, config: unknown): Promise<EmbedHandle>
}

/** What a single exported .html file carries, before it is serialized. */
export interface EmbedSnapshot {
  kind: string
  config: unknown
  /** Loop length in seconds. Drives the clock; must be > 0. */
  duration: number
  width: number
  height: number
  /** Baked still frame, inlined as a data: URI. Fallback and pre-mount frame. */
  posterDataUrl: string
  transparent: boolean
  /** 'box' hands the adapter the page's whole box; it frames the piece itself. */
  framing?: 'contain' | 'box'
  /** How the fallback poster image fits its box. */
  posterFit?: 'contain' | 'cover'
  /** Nothing moves: render one frame, never start the clock. */
  still?: boolean
  /** A #hex colour behind the stage when not transparent. */
  backdrop?: string
}
