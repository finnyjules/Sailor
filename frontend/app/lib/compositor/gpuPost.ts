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

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** A uniform value. Plain numbers are floats (ints only for `uTapCount`, DOF's loop bound),
 *  a Float32Array is an array of vec2s (DOF's tap offsets), and `{ vec3 }` is one vec3 —
 *  a wrapper rather than "guess by length", so a vec2 array is never misread. */
export type GpuUniform = number | Float32Array | { vec3: readonly [number, number, number] }

export function uniformSetter(name: string, value: GpuUniform): '1i' | '1f' | '2fv' | '3f' {
  if (value instanceof Float32Array) return '2fv'
  if (typeof value === 'object') return '3f'
  if (Number.isInteger(value) && name === 'uTapCount') return '1i'
  return '1f'
}

export class GpuPost {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texColor: WebGLTexture | null = null
  private texDepth: WebGLTexture | null = null
  private failed = false
  private reason = ''
  /** Assertion marker: how many real GL draws have happened. Lets a test tell
   *  "the pass applied" from "the pass silently skipped". */
  runs = 0

  constructor(private frag: string) {}

  available(): boolean {
    this.init()
    return !this.failed && !!this.gl
  }

  /** Why the pass is unavailable — surfaced in the panel rather than swallowed. */
  unavailableReason(): string {
    this.init()
    return this.reason
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
  }

  render(
    color: CanvasImageSource,
    depth: CanvasImageSource,
    w: number,
    h: number,
    uniforms: Record<string, GpuUniform>,
  ): HTMLCanvasElement | null {
    this.init()
    const { gl, program, canvas } = this
    if (this.failed || !gl || !program || !canvas) return null

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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depth as TexImageSource)
    gl.uniform1i(gl.getUniformLocation(program, 'uDepth'), 1)

    for (const [name, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name)
      if (!loc) continue
      switch (uniformSetter(name, value)) {
        case '2fv': gl.uniform2fv(loc, value as Float32Array); break
        case '3f': { const v = (value as { vec3: readonly [number, number, number] }).vec3; gl.uniform3f(loc, v[0], v[1], v[2]); break }
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
