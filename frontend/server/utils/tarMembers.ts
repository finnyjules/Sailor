/**
 * Read the files inside a tar on disk, and stream one of them out — the Node
 * stand-in for Python's stdlib `tarfile` that `loraFalWeights.ts` used through
 * the repo's `.venv` (step 3, LC7: the hosted image has no Python).
 *
 * Only what a Replicate `trained_model.tar` needs, done properly: ustar (with
 * its name prefix), GNU long names (`L`), pax `path=` records (`x`), octal and
 * base-256 sizes, and a gzip-compressed tar (tarfile's `r:*` reads those too).
 * Headers are read 512 bytes at a time with seeks over the data, and the chosen
 * member is streamed by byte range, so a 330 MB tar is never held in memory.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

export interface TarFile { name: string, offset: number, size: number }

const BLOCK = 512

function text(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len)
  const z = s.indexOf(0)
  return s.subarray(0, z < 0 ? len : z).toString('utf8')
}

function num(b: Buffer, start: number, len: number): number {
  if (b[start]! & 0x80) { // GNU base-256 (sizes of 8 GiB and up)
    let v = b[start]! & 0x7f
    for (let i = 1; i < len; i++) v = v * 256 + b[start + i]!
    return v
  }
  const s = text(b, start, len).trim()
  return s ? parseInt(s, 8) : 0
}

function checksumOk(h: Buffer): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!
  return sum === num(h, 148, 8)
}

/** pax extended header records: `<len> <key>=<value>\n`, repeated. */
function paxPath(data: Buffer): string | null {
  let at = 0
  let found: string | null = null
  while (at < data.length) {
    const sp = data.indexOf(0x20, at)
    if (sp < 0) break
    const len = parseInt(data.subarray(at, sp).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const rec = data.subarray(sp + 1, at + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0 && rec.slice(0, eq) === 'path') found = rec.slice(eq + 1)
    at += len
  }
  return found
}

async function isGzip(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r')
  try {
    const b = Buffer.alloc(2)
    const { bytesRead } = await fh.read(b, 0, 2, 0)
    return bytesRead === 2 && b[0] === 0x1f && b[1] === 0x8b
  } finally { await fh.close() }
}

/** Every regular file in the tar, in order, with where its bytes sit. Throws on anything that is not a tar. */
export async function listTarFiles(tarPath: string): Promise<TarFile[]> {
  const fh = await fs.open(tarPath, 'r')
  const out: TarFile[] = []
  try {
    const total = (await fh.stat()).size
    const h = Buffer.alloc(BLOCK)
    let pos = 0
    let longName: string | null = null
    let pax: string | null = null
    while (pos + BLOCK <= total) {
      await fh.read(h, 0, BLOCK, pos)
      if (h.every(x => x === 0)) break
      if (!checksumOk(h)) throw new Error(pos === 0 ? 'not a tar file' : 'the tar is damaged')
      const size = num(h, 124, 12)
      const type = h[156]!
      const dataAt = pos + BLOCK
      if (dataAt + size > total) throw new Error('the tar is cut short')
      const readData = async () => {
        const d = Buffer.alloc(size)
        await fh.read(d, 0, size, dataAt)
        return d
      }
      if (type === 0x4c /* L */) {
        longName = text(await readData(), 0, size)
      } else if (type === 0x78 /* x */) {
        pax = paxPath(await readData())
      } else if (type !== 0x67 /* g */) {
        let name = text(h, 0, 100)
        if (text(h, 257, 5) === 'ustar') {
          const prefix = text(h, 345, 155)
          if (prefix) name = `${prefix}/${name}`
        }
        // '0', NUL (old tars) and '7' (contiguous) are regular files.
        if (type === 0x30 || type === 0 || type === 0x37) out.push({ name: pax ?? longName ?? name, offset: dataAt, size })
        longName = null
        pax = null
      }
      pos = dataAt + Math.ceil(size / BLOCK) * BLOCK
    }
  } finally { await fh.close() }
  return out
}

/**
 * Stream the file `pick` chooses (from the tar's file names) to `outPath`.
 * Returns null when `pick` chooses nothing. A gzip tar is unpacked to a temp
 * file beside `outPath` first, and that file is always removed.
 */
export async function extractTarMember(
  tarPath: string,
  pick: (names: string[]) => string | null,
  outPath: string,
): Promise<{ name: string, size: number } | null> {
  let plain = tarPath
  if (await isGzip(tarPath)) {
    plain = `${outPath}.tar`
    await pipeline(createReadStream(tarPath), createGunzip(), createWriteStream(plain))
  }
  try {
    const files = await listTarFiles(plain)
    const name = pick(files.map(f => f.name))
    const member = name === null ? undefined : files.find(f => f.name === name)
    if (!member) return null
    if (member.size === 0) await fs.writeFile(outPath, '')
    else await pipeline(createReadStream(plain, { start: member.offset, end: member.offset + member.size - 1 }), createWriteStream(outPath))
    return { name: member.name, size: member.size }
  } finally {
    if (plain !== tarPath) await fs.rm(plain, { force: true }).catch(() => {})
  }
}
