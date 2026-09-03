// frontend/scripts/shapeLibrary.mjs
// Pure helpers for build-shape-library.mjs. Parses the tiny SVG dialect
// Assets/Shapes uses (path/polygon/rect/circle, optional transform, only
// M L H V C S Z path commands) into ABSOLUTE `M L C Z` path data plus an ink
// bounding box. No DOM, no dependencies, so the unit test imports it directly.

/** Round to 2 decimals and kill negative zero. */
export function f(v) {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? 0 : r
}

export function slug(name) {
  return name.toLowerCase().replace(/\.svg$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function displayName(id) {
  const s = id.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Parse `key="value"` pairs off one tag's attribute text. */
export function attrs(tagText) {
  const out = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(tagText))) out[m[1]] = m[2]
  return out
}

/**
 * Tokenise + normalise a path `d` string. Returns [{ c: 'M'|'L'|'C'|'Z', p: number[] }]
 * with every coordinate absolute. H/V become L; S becomes C with the reflected
 * control point. Anything outside M L H V C S Z throws — the build script surfaces
 * the filename so a future drawing that uses arcs is caught at build time.
 */
export function parsePath(d) {
  const tokens = []
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m
  while ((m = re.exec(d))) tokens.push(m[1] ?? Number(m[2]))
  const out = []
  let cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0
  let cmd = null
  let prev = ''
  let i = 0
  const num = () => {
    const v = tokens[i++]
    if (typeof v !== 'number') throw new Error(`expected a number in path data near token ${i - 1}`)
    return v
  }
  while (i < tokens.length) {
    const t = tokens[i]
    if (typeof t === 'string') { cmd = t; i++ }
    else if (cmd === null) throw new Error('path data does not start with a command')
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    switch (cmd) {
      case 'M': case 'm': {
        let x = num(), y = num()
        if (cmd === 'm') { x += cx; y += cy }
        cx = sx = x; cy = sy = y; px = cx; py = cy
        out.push({ c: 'M', p: [x, y] }); break
      }
      case 'L': case 'l': {
        let x = num(), y = num()
        if (cmd === 'l') { x += cx; y += cy }
        cx = x; cy = y; px = cx; py = cy
        out.push({ c: 'L', p: [x, y] }); break
      }
      case 'H': case 'h': {
        let x = num()
        if (cmd === 'h') x += cx
        cx = x; px = cx; py = cy
        out.push({ c: 'L', p: [cx, cy] }); break
      }
      case 'V': case 'v': {
        let y = num()
        if (cmd === 'v') y += cy
        cy = y; px = cx; py = cy
        out.push({ c: 'L', p: [cx, cy] }); break
      }
      case 'C': case 'c': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num()
        if (cmd === 'c') { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy }
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] })
        px = x2; py = y2; cx = x; cy = y; break
      }
      case 'S': case 's': {
        let x2 = num(), y2 = num(), x = num(), y = num()
        if (cmd === 's') { x2 += cx; y2 += cy; x += cx; y += cy }
        const x1 = prev === 'C' ? 2 * cx - px : cx
        const y1 = prev === 'C' ? 2 * cy - py : cy
        out.push({ c: 'C', p: [x1, y1, x2, y2, x, y] })
        px = x2; py = y2; cx = x; cy = y; break
      }
      case 'Z': case 'z': {
        out.push({ c: 'Z', p: [] })
        cx = sx; cy = sy; px = cx; py = cy; break
      }
      default:
        throw new Error(`unsupported path command "${cmd}"`)
    }
    prev = out[out.length - 1].c
  }
  return out
}

export function serializePath(cmds) {
  return cmds.map(({ c, p }) => c + p.map(f).join(',')).join('')
}

/** [a, b, c, d, e, f] in SVG matrix layout. */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** Parse an SVG `transform` list (translate / rotate / scale) into one matrix. */
export function parseTransform(s) {
  let m = [1, 0, 0, 1, 0, 0]
  const re = /(translate|rotate|scale|matrix)\s*\(([^)]*)\)/g
  let t
  while ((t = re.exec(s ?? ''))) {
    const a = t[2].trim().split(/[\s,]+/).filter(Boolean).map(Number)
    let n
    if (t[1] === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    else if (t[1] === 'scale') { const sx = a[0] ?? 1, sy = a[1] ?? sx; n = [sx, 0, 0, sy, 0, 0] }
    else if (t[1] === 'matrix') { if (a.length !== 6) throw new Error('matrix() needs 6 numbers'); n = a }
    else {
      const rad = ((a[0] ?? 0) * Math.PI) / 180
      const cos = Math.cos(rad), sin = Math.sin(rad)
      n = [cos, sin, -sin, cos, 0, 0]
      if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]])
    }
    m = mul(m, n)
  }
  return m
}

export function applyMatrix(cmds, m) {
  return cmds.map(({ c, p }) => {
    const q = []
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1]
      q.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
    }
    return { c, p: q }
  })
}

/** Ink bbox [x, y, w, h]: lines exactly, cubics sampled at 16 steps. */
export function pathBounds(cmds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let cx = 0, cy = 0
  const add = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  for (const { c, p } of cmds) {
    if (c === 'M' || c === 'L') { cx = p[0]; cy = p[1]; add(cx, cy) }
    else if (c === 'C') {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, mt = 1 - t
        const x = mt * mt * mt * cx + 3 * mt * mt * t * p[0] + 3 * mt * t * t * p[2] + t * t * t * p[4]
        const y = mt * mt * mt * cy + 3 * mt * mt * t * p[1] + 3 * mt * t * t * p[3] + t * t * t * p[5]
        add(x, y)
      }
      cx = p[4]; cy = p[5]
    }
  }
  if (!Number.isFinite(minX)) throw new Error('empty path')
  return [f(minX), f(minY), f(maxX - minX), f(maxY - minY)]
}

const KAPPA = 0.5522847498

/** One SVG element → path data (still un-normalised; parsePath runs after). */
export function elementToPath(name, a) {
  switch (name) {
    case 'path':
      if (!a.d) throw new Error('<path> without d')
      return a.d.trim()
    case 'polygon': {
      const n = (a.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (n.length < 6 || n.length % 2 || n.some(v => !Number.isFinite(v))) throw new Error('<polygon> points malformed')
      let d = `M${n[0]},${n[1]}`
      for (let i = 2; i < n.length; i += 2) d += `L${n[i]},${n[i + 1]}`
      return d + 'Z'
    }
    case 'rect': {
      if (a.rx || a.ry) throw new Error('<rect> with rx/ry is not supported — convert it to a path')
      const x = Number(a.x ?? 0), y = Number(a.y ?? 0), w = Number(a.width), h = Number(a.height)
      if (![x, y, w, h].every(Number.isFinite)) throw new Error('<rect> malformed')
      return `M${x},${y}h${w}v${h}h${-w}Z`
    }
    case 'circle': {
      const cx = Number(a.cx ?? 0), cy = Number(a.cy ?? 0), r = Number(a.r)
      if (![cx, cy, r].every(Number.isFinite)) throw new Error('<circle> malformed')
      const k = KAPPA * r
      return `M${cx + r},${cy}` +
        `C${cx + r},${cy + k},${cx + k},${cy + r},${cx},${cy + r}` +
        `C${cx - k},${cy + r},${cx - r},${cy + k},${cx - r},${cy}` +
        `C${cx - r},${cy - k},${cx - k},${cy - r},${cx},${cy - r}` +
        `C${cx + k},${cy - r},${cx + r},${cy - k},${cx + r},${cy}Z`
    }
    default:
      throw new Error(`unsupported element <${name}>`)
  }
}

/**
 * Turn a batch of `{ name, text }` SVG files into manifest shapes: slug the
 * filename into an id, flag id collisions and empty ids, parse the rest via
 * parseShapeSvg. One bad or colliding file is skipped and reported in
 * `errors` — it never stops the others from parsing. Pure — no filesystem —
 * so the collision/error paths are directly testable.
 */
export function buildShapes(files) {
  const shapes = []
  const seen = new Map()
  const errors = []
  for (const { name, text } of files) {
    const id = slug(name)
    if (!id) { errors.push(`${name}: empty id`); continue }
    if (seen.has(id)) { errors.push(`${name}: id "${id}" collides with ${seen.get(id)}`); continue }
    seen.set(id, name)
    try {
      const parsed = parseShapeSvg(text, name)
      shapes.push({ id, name: displayName(id), ...parsed })
    } catch (e) {
      errors.push(String(e.message))
    }
  }
  return { shapes, errors }
}

/** Whole file → { d, fillRule, box, sourceColor }. Throws with the filename on anything odd. */
export function parseShapeSvg(svgText, fileName) {
  const vb = /viewBox="([^"]+)"/.exec(svgText)
  if (!vb || vb[1].trim().split(/\s+/).join(' ') !== '0 0 96 96') throw new Error(`${fileName}: viewBox must be "0 0 96 96"`)
  const body = svgText.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const tagRe = /<([a-zA-Z]+)([^>]*?)\/?>/g
  const cmds = []
  let sourceColor = null
  let fillRule = 'nonzero'
  let m
  try {
    while ((m = tagRe.exec(body))) {
      const a = attrs(m[2])
      let part = parsePath(elementToPath(m[1], a))
      if (a.transform) part = applyMatrix(part, parseTransform(a.transform))
      cmds.push(...part)
      if (sourceColor === null && a.fill && a.fill !== 'none') sourceColor = a.fill
      if (a['fill-rule'] === 'evenodd') fillRule = 'evenodd'
    }
  } catch (e) {
    throw new Error(`${fileName}: ${e.message}`)
  }
  if (!cmds.length) throw new Error(`${fileName}: no drawable elements`)
  return { d: serializePath(cmds), fillRule, box: pathBounds(cmds), sourceColor: sourceColor ?? '#000000' }
}
