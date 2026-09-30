/**
 * Minimal WebGL2 post stage for the Compositor. Modelled on lib/shaderfx/renderer.ts.
 *
 * The Compositor's post chain is Canvas 2D (see postEffects.ts) and that is right for
 * everything currently in it. This exists for effects that genuinely cannot run there —
 * depth of field is ~700 samples per pixel, which is the wrong machine, not an
 * optimisation problem. Output is an offscreen canvas the 2D chain drawImage()s.
 *
 * TRAP: reading back from a WebGL canvas without forcing the frame to complete returns
 * STALE pixels — the previous frame, or nothing. The gl.finish() before returning is
 * load-bearing, not defensive. This has bitten this codebase before.
 */

import type { FloatDepth } from '~/lib/relight/depthField'

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export function isFloatDepth(d: unknown): d is FloatDepth {
  return !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'float'
    && (d as { data?: unknown }).data instanceof Float32Array
}

/** Whether `next` needs uploading given what was last uploaded: the same object means the
 *  same pixels (a source is immutable once built), so re-upload only on a genuine change. */
export function needsUpload(last: CanvasImageSource | null, next: CanvasImageSource | null): boolean {
  return last !== next
}

/** A uniform value. Plain numbers are floats (ints only for `uTapCount`, DOF's loop bound),
 *  a Float32Array is an array of vec2s (DOF's tap offsets), and `{ vec3 }` / `{ vec4 }` is one
 *  vec3 / vec4 — a wrapper rather than "guess by length", so a vec2 array is never misread. */
export type GpuUniform = number | Float32Array
  | { vec3: readonly [number, number, number] }
  | { vec4: readonly [number, number, number, number] }

export function uniformSetter(name: string, value: GpuUniform): '1i' | '1f' | '2fv' | '3f' | '4f' {
  if (value instanceof Float32Array) return '2fv'
  if (typeof value === 'object') return 'vec4' in value ? '4f' : '3f'
  if (Number.isInteger(value) && name === 'uTapCount') return '1i'
  return '1f'
}

export class GpuPost {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texColor: WebGLTexture | null = null
  private texDepth: WebGLTexture | null = null
  private texNormals: WebGLTexture | null = null
  /** The float field currently in texDepth. A field is immutable once built, so the same object
   *  means the same pixels: skip the (several-MB) re-upload. Forgotten whenever texDepth is. */
  private depthUploaded: FloatDepth | null = null
  /** Float-field uploads actually made (test marker for the reuse above). */
  depthUploads = 0
  /** The image currently uploaded to texNormals, or null when it still holds the 1×1 dummy. */
  private lastNormals: CanvasImageSource | null = null
  private failed = false
  private reason = ''
  /** Assertion marker: how many real GL draws have happened. Lets a test tell
   *  "the pass applied" from "the pass silently skipped". */
  runs = 0

  constructor(private frag: string) {}

  available(): boolean {
    if (this.gl?.isContextLost()) this.drop()
    this.init()
    return !this.failed && !!this.gl
  }

  /** Why the pass is unavailable — surfaced in the panel rather than swallowed. */
  unavailableReason(): string {
    this.init()
    return this.reason
  }

  /** Forget the context (and everything made on it) so the next call builds a fresh one. A lost
   *  context is transient — not `failed` — or one GPU reset would disable the pass for the session. */
  private drop() {
    this.canvas = null
    this.gl = null
    this.program = null
    this.texColor = null
    this.texDepth = null
    this.texNormals = null
    this.depthUploaded = null
    this.lastNormals = null
  }

  private die(reason: string) {
    this.failed = true
    this.reason = reason
    console.error('[gpuPost]', reason)
  }

  private init() {
    if (this.gl || this.failed) return
    if (typeof document === 'undefined') { this.die('no document (SSR)'); return }

    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    })
    if (!gl) { this.die('WebGL2 is not available in this browser'); return }
    // The browser may take the context back (GPU reset, too many contexts). Drop ours so the next
    // render re-inits instead of drawing into a dead context and returning a blank canvas.
    canvas.addEventListener('webglcontextlost', () => { if (this.canvas === canvas) this.drop() })

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        this.die(`shader compile failed: ${gl.getShaderInfoLog(s)}`)
        return null
      }
      return s
    }
    const vs = compile(gl.VERTEX_SHADER, VERT)
    if (!vs) return
    const fs = compile(gl.FRAGMENT_SHADER, this.frag)
    if (!fs) return

    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.die(`program link failed: ${gl.getProgramInfoLog(program)}`)
      return
    }

    // Single full-screen triangle — cheaper than a quad, no seam down the diagonal.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const mkTex = () => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      return t
    }

    this.canvas = canvas
    this.gl = gl
    this.program = program
    this.texColor = mkTex()
    this.texDepth = mkTex()
    // Third texture, for MoGe-2 normals when a caller has them. A texture bound but never
    // texImage2D'd is "incomplete" — Chrome/ANGLE logs a RENDER WARNING for it on every
    // draw once the program actually samples the unit (uNormals is always declared, even
    // when uHasNormals gates its use). So it gets one real 1×1 RGBA pixel right away, not
    // just a bind; lastNormals stays null so the first real normals image still uploads.
    this.texNormals = mkTex()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]))
    this.depthUploaded = null
    this.lastNormals = null
  }

  render(
    color: CanvasImageSource,
    depth: CanvasImageSource | FloatDepth,
    w: number,
    h: number,
    uniforms: Record<string, GpuUniform>,
    extra?: { normals?: CanvasImageSource },
  ): HTMLCanvasElement | null {
    if (this.gl?.isContextLost()) this.drop()
    this.init()
    const { gl, program, canvas } = this
    if (this.failed || !gl || !program || !canvas) return null
    // A lost context draws nothing — say so (null ⇒ the caller draws the plain layer).
    if (gl.isContextLost()) { this.drop(); return null }
    // Larger than the GPU can hold as a texture: the upload would fail silently. Draw plain.
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (Math.round(w) > maxTex || Math.round(h) > maxTex) return null

    canvas.width = Math.max(1, Math.round(w))
    canvas.height = Math.max(1, Math.round(h))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)

    // GL texture space has its origin at the BOTTOM-left; a canvas has it at the
    // top-left. Without this the output is vertically flipped — and because colour and
    // depth flip together the depth stays correctly aligned, so the result looks
    // entirely plausible while being upside down. Measured: mean abs diff to the
    // original 23.95, to the flipped original 3.07.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texColor)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, color as TexImageSource)
    gl.uniform1i(gl.getUniformLocation(program, 'uColor'), 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texDepth)
    if (isFloatDepth(depth)) {
      if (depth !== this.depthUploaded) {
        // A float field arrives already in GL row order (bottom row first); FLIP_Y must be off
        // for the typed-array upload, then back on for the next image upload.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, depth.width, depth.height, 0, gl.RED, gl.FLOAT, depth.data)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        this.depthUploaded = depth
        this.depthUploads++
      }
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depth as TexImageSource)
      this.depthUploaded = null
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uDepth'), 1)

    // Normals (MoGe-2 surfaces), when given: same upload-reuse trick as the float depth field,
    // uploaded with FLIP_Y on like the colour image. Unit 2 is always bound — to the real
    // normals, or to the 1×1 dummy from init() — so the sampler is never left unbound.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.texNormals)
    const normals = extra?.normals
    if (normals && needsUpload(this.lastNormals, normals)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, normals as TexImageSource)
      this.lastNormals = normals
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uNormals'), 2)

    for (const [name, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name)
      if (!loc) continue
      switch (uniformSetter(name, value)) {
        case '2fv': gl.uniform2fv(loc, value as Float32Array); break
        case '3f': { const v = (value as { vec3: readonly [number, number, number] }).vec3; gl.uniform3f(loc, v[0], v[1], v[2]); break }
        case '4f': { const v = (value as { vec4: readonly [number, number, number, number] }).vec4; gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break }
        case '1i': gl.uniform1i(loc, value as number); break
        default: gl.uniform1f(loc, value as number)
      }
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish() // load-bearing: without it drawImage() reads stale pixels
    this.runs++
    return canvas
  }
}
