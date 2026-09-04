// Vertex-buffer codec for the `mesh` primitive: the geometry a sculpt or a
// merge produces, small enough to live inline in the scene document.
//
// The delta+varint stage before deflate is LOAD-BEARING, not an optimisation.
// Measured on SphereGeometry (three@0.171, deflate level 9, base64 length):
//
//   verts    uint16+deflate    delta+zigzag varint+deflate
//    6.3k         106KB                    15KB
//     13k         226KB                    42KB
//     26k         450KB                    91KB
//     52k         917KB                   186KB
//
// Naive quantise-and-deflate puts one sculpt near a megabyte of base64 in the
// scene_state widget. Index buffers dominate the raw size and are also what
// delta-encodes best, because surface-nets output is grid-scan ordered.
//
// Normals are never stored — recomputing them on decode is cheaper than the
// bytes they would cost.
import * as THREE from 'three'
import { contentDigest } from '~/lib/scene3d/config'
import { addSphericalUV } from './roundedGeometry'

export { contentDigest }

/** Hard ceiling, enforced at encode time — the only place vertex count grows
 *  is a remesh, and it clamps to this. ~190KB encoded. */
export const MESH_VERTEX_CAP = 40_000
/** What the Remesh control aims for by default. ~70KB encoded. */
export const MESH_DEFAULT_TARGET = 20_000

export interface MeshData {
  /** xyz triples, length = 3 * vertexCount. */
  positions: Float32Array
  indices: Uint32Array
}

const MAGIC = 0x534d3031 // 'SM01'
const HEADER_BYTES = 4 + 4 + 4 + 24 // magic, vertexCount, indexCount, bbox(6 f32)

// --- varint + zigzag ---------------------------------------------------------

const zigzag = (n: number): number => ((n << 1) ^ (n >> 31)) >>> 0
const unzigzag = (n: number): number => (n >>> 1) ^ -(n & 1)

/** Growable byte sink. Sized generously up front — every caller knows an upper
 *  bound (5 bytes is the max varint width for a uint32). */
class ByteWriter {
  private buf: Uint8Array
  private len = 0
  constructor(capacity: number) { this.buf = new Uint8Array(capacity) }
  varint(v: number): void {
    let x = v >>> 0
    while (x > 127) { this.buf[this.len++] = (x & 127) | 128; x >>>= 7 }
    this.buf[this.len++] = x
  }
  bytes(): Uint8Array { return this.buf.subarray(0, this.len) }
}

class ByteReader {
  private at = 0
  constructor(private buf: Uint8Array) {}
  varint(): number {
    let x = 0, shift = 0, b = 0
    do { b = this.buf[this.at++]!; x |= (b & 127) << shift; shift += 7 } while (b & 128)
    return x >>> 0
  }
}

// --- base64 (works in both the browser and vitest's node env) ----------------

function toBase64(bytes: Uint8Array): string {
  let s = ''
  // Chunked: String.fromCharCode(...huge) blows the argument limit.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- deflate (async: the platform offers no synchronous form) ----------------

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // TS's newer lib.dom types narrow BlobPart to ArrayBufferView<ArrayBuffer>,
  // which a generic Uint8Array<ArrayBufferLike> doesn't satisfy — the lib is
  // over-narrow here, Blob's runtime constructor accepts any Uint8Array. Cast
  // rather than copy: these buffers run tens-to-hundreds of KB per sculpt.
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Same BlobPart over-narrowing as deflate above.
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// --- three <-> MeshData ------------------------------------------------------

/** Pull an indexed triangle mesh out of a geometry. Non-indexed input is
 *  indexed trivially (0..n-1) rather than welded — welding is the remesh's job,
 *  and doing it here would silently change a caller's topology. */
export function meshDataFromGeometry(geo: THREE.BufferGeometry): MeshData {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const positions = new Float32Array(pos.array.length)
  positions.set(pos.array as ArrayLike<number>)
  let indices: Uint32Array
  if (geo.index) {
    indices = new Uint32Array(geo.index.count)
    for (let i = 0; i < geo.index.count; i++) indices[i] = geo.index.getX(i)
  } else {
    indices = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) indices[i] = i
  }
  return { positions, indices }
}

export function geometryFromMeshData(data: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3))
  geo.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1))
  geo.computeVertexNormals()
  // Surface coordinates, same spherical fallback the GLB path and the gem hull use. The
  // codec never stores UVs (positions + indices only), so without this every consumer that
  // samples by uv — the screen finish above all — reads one texel and paints the whole
  // sculpt as a single giant dot.
  if (!geo.getAttribute('uv')) addSphericalUV(geo)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

// --- encode / decode ---------------------------------------------------------

export async function encodeMesh(data: MeshData): Promise<string> {
  const vertexCount = data.positions.length / 3
  if (vertexCount > MESH_VERTEX_CAP) {
    throw new Error(`[scene3d-mesh] ${vertexCount} vertices exceeds the vertex cap of ${MESH_VERTEX_CAP}`)
  }

  // Bounding box, guarded against a zero-extent axis (a flat mesh).
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < data.positions.length; i++) {
    const a = i % 3
    const v = data.positions[i]!
    if (v < min[a]!) min[a] = v
    if (v > max[a]!) max[a] = v
  }
  const size = [0, 1, 2].map((a) => {
    const s = max[a]! - min[a]!
    return s > 1e-9 ? s : 1
  })

  // Positions: quantise → delta vs the previous vertex, per component → zigzag → varint.
  const posW = new ByteWriter(vertexCount * 3 * 5 + 16)
  const prev = [0, 0, 0]
  for (let i = 0; i < vertexCount; i++) {
    for (let a = 0; a < 3; a++) {
      const t = (data.positions[i * 3 + a]! - min[a]!) / size[a]!
      const q = Math.round(Math.min(1, Math.max(0, t)) * 65535)
      posW.varint(zigzag(q - prev[a]!))
      prev[a] = q
    }
  }

  // Indices: delta vs the previous index → zigzag → varint.
  const idxW = new ByteWriter(data.indices.length * 5 + 16)
  let p = 0
  for (let i = 0; i < data.indices.length; i++) {
    const v = data.indices[i]!
    idxW.varint(zigzag(v - p))
    p = v
  }

  const posBytes = posW.bytes()
  const idxBytes = idxW.bytes()
  const out = new Uint8Array(HEADER_BYTES + posBytes.length + idxBytes.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, vertexCount, true)
  view.setUint32(8, data.indices.length, true)
  for (let a = 0; a < 3; a++) {
    view.setFloat32(12 + a * 4, min[a]!, true)
    view.setFloat32(24 + a * 4, size[a]!, true)
  }
  out.set(posBytes, HEADER_BYTES)
  out.set(idxBytes, HEADER_BYTES + posBytes.length)

  return toBase64(await deflate(out))
}

export async function decodeMesh(encoded: string): Promise<MeshData> {
  const bytes = await inflate(fromBase64(encoded))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('[scene3d-mesh] bad magic')
  const vertexCount = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const min = [0, 1, 2].map((a) => view.getFloat32(12 + a * 4, true))
  const size = [0, 1, 2].map((a) => view.getFloat32(24 + a * 4, true))

  const reader = new ByteReader(bytes.subarray(HEADER_BYTES))
  const positions = new Float32Array(vertexCount * 3)
  const prev = [0, 0, 0]
  for (let i = 0; i < vertexCount; i++) {
    for (let a = 0; a < 3; a++) {
      const q = prev[a]! + unzigzag(reader.varint())
      prev[a] = q
      positions[i * 3 + a] = min[a]! + (q / 65535) * size[a]!
    }
  }
  const indices = new Uint32Array(indexCount)
  let p = 0
  for (let i = 0; i < indexCount; i++) {
    p += unzigzag(reader.varint())
    indices[i] = p
  }
  return { positions, indices }
}
