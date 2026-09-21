#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}

uniform sampler2D u_glyphs;
uniform sampler2D u_customGlyphs; // runtime 1-row atlas built from user-typed chars (studio only)
uniform float u_glyphCount;
uniform float u_glyphRows;
uniform float u_cell;
uniform float u_jitter;
uniform float u_speed;
uniform float u_colored;
uniform float u_shape;
uniform float u_brightness;
uniform float u_spacing;
uniform float u_invert;
uniform float u_underlay;
uniform float u_blur;

// Anti-aliased "metric <= t" test: 1 inside, 0 outside, smooth ~1px band across
// the edge (fwidth gives the screen-space derivative of the metric, so the AA band
// stays a constant pixel width at any cell size).
float aaInside(float metric, float t) {
    float w = max(fwidth(metric), 1e-4);
    return 1.0 - smoothstep(t - w, t + w, metric);
}

// Geometric coverage: 1 inside the shape, 0 outside. q is centered in [-1,1], t = luminance.
float geoShape(int shp, vec2 q, float t, vec2 cell) {
    if (shp == 0) shp = 1 + int(floor(hash2(cell, u_seed + 7.0) * 6.0)); // Mixed: pick 1..6 per cell
    float r = length(q);
    if (shp == 1) return aaInside(max(abs(q.x), abs(q.y)), t);      // Blocks
    if (shp == 2) return aaInside(r, t);                            // Circles
    if (shp == 3) return aaInside(abs(q.y), t);                     // Lines
    if (shp == 4) return aaInside(abs(q.x - q.y) * 0.70710678, t);  // Diagonal
    if (shp == 5) return aaInside(min(abs(q.x), abs(q.y)), t * 0.5);// Cross
    return aaInside((abs(q.x) + abs(q.y)) * 0.70710678, t);        // Diamond (6)
}

// Lego: a solid coloured plastic tile with one raised, top-left-lit stud. Unlike the
// coverage shapes above this returns a finished RGB tile (3D shading on the cell colour,
// not a 0/1 mask), so studs are CONSTANT size and the whole tile carries the colour.
// lc = raw in-cell coord [0,1]; tileCol = the plastic colour for this cell.
vec3 legoTile(vec2 lc, vec3 tileCol) {
    vec2 ldir = normalize(vec2(-1.0, -1.0)); // light from the top-left of the cell
    vec2 q = (lc - 0.5) * 2.0;               // centred [-1,1]

    // Plate: dark groove at the cell border + a soft bevel lip (top-left bright,
    // bottom-right dark) so neighbouring bricks read as separate raised plates.
    vec2 bd = min(lc, 1.0 - lc);
    float bmin = min(bd.x, bd.y);
    float plate = smoothstep(0.0, 0.05, bmin);          // 0 in the groove -> 1 inside
    float lip = 1.0 - smoothstep(0.05, 0.18, bmin);     // border band only
    float side = dot(normalize(q + 1e-5), ldir);        // +1 toward top-left, -1 bottom-right
    vec3 base = tileCol * mix(0.42, 1.0, plate) + lip * side * 0.16;

    // Raised stud: a sphere-cap dome, Lambert-lit from the same direction, with a
    // contact-shadow ring on its bottom-right edge.
    float rs = 0.60;
    float r = length(q);
    float mask = aaInside(r, rs);
    float dz = sqrt(max(1.0 - pow(min(r / rs, 1.0), 2.0), 0.0));
    float diff = clamp(dot(normalize(vec3(q / rs, dz * 1.4)), normalize(vec3(ldir, 1.2))), 0.0, 1.0);
    vec3 stud = tileCol * (0.5 + 0.85 * diff);
    float ring = smoothstep(rs - 0.12, rs, r);
    stud *= mix(1.0, 0.65, ring * clamp(-side, 0.0, 1.0));

    return clamp(mix(base, stud, mask), 0.0, 1.0);
}

// Cross-stitch: two crossing rounded yarn strands (an X) per cell, each shaded like a
// round fibre (bright along its spine, dark at the edges) and lit from the top-left.
// The over/under strand alternates per cell so the field reads as woven thread.
vec3 stitchTile(vec2 lc, vec3 tileCol, vec2 cell) {
    vec2 q = (lc - 0.5) * 2.0;
    float hw = 0.42;                                   // thread half-width
    float d1 = abs(q.x - q.y) * 0.70710678;            // BL->TR strand
    float d2 = abs(q.x + q.y) * 0.70710678;            // TL->BR strand
    float m1 = aaInside(d1, hw), m2 = aaInside(d2, hw);
    float cyl1 = sqrt(max(1.0 - pow(min(d1 / hw, 1.0), 2.0), 0.0)); // round cross-section
    float cyl2 = sqrt(max(1.0 - pow(min(d2 / hw, 1.0), 2.0), 0.0));
    float sheen1 = 0.85 + 0.30 * (-q.x - q.y) * 0.5;   // gentle top-left sheen along length
    float sheen2 = 0.85 + 0.30 * (-q.x - q.y) * 0.5;
    vec3 s1 = tileCol * (0.40 + 0.75 * cyl1) * sheen1;
    vec3 s2 = tileCol * (0.40 + 0.75 * cyl2) * sheen2;
    vec3 c = vec3(0.0);                                 // fabric gap (dark)
    bool firstTop = mod(cell.x + cell.y, 2.0) < 1.0;    // weave parity
    if (firstTop) { c = mix(c, s2, m2); c = mix(c, s1, m1); }
    else          { c = mix(c, s1, m1); c = mix(c, s2, m2); }
    return clamp(c, 0.0, 1.0);
}

// Isometric voxel — "tumbling blocks". A real iso cube is a HEXAGON (rhombus top + two
// parallelogram sides), which can't fill a square without becoming a chevron, so this
// tiles cubes on a pointy-top HEX grid (offset rows) where the rhombi tessellate with no
// gaps. Self-contained: maps the pixel to its hex cell, samples the image at that cell's
// centre for the cube colour, then shades the three rhombus faces (top bright, sides
// mid/dark) with thin dark seams along the internal edges. Reads globals for size/colour.
vec3 voxelTile(vec2 uv) {
    vec2 res = u_resolution;
    float s = max(u_cell * res.y, 2.0);                 // square cell px (matches main)
    float R = s * 0.5;                                  // hex size (centre→corner), height 2R = s
    vec2 px = uv * res;
    // pixel → fractional axial (pointy-top), then cube-round to the nearest hex centre.
    float aq = (0.57735027 * px.x - 0.33333333 * px.y) / R;
    float ar = (0.66666667 * px.y) / R;
    float cx = aq, cz = ar, cy = -cx - cz;
    float rx = floor(cx + 0.5), ry = floor(cy + 0.5), rz = floor(cz + 0.5);
    float dx = abs(rx - cx), dy = abs(ry - cy), dz = abs(rz - cz);
    // Reset the coordinate with the LARGEST rounding error from the other two so the
    // cube coords stay consistent (rx+ry+rz==0). Only rx/rz feed the centre below, so the
    // dy-largest case (reset ry) needs no action.
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dz > dy)       rz = -rx - ry;
    vec2 center = vec2(R * 1.73205081 * (rx + rz * 0.5), R * 1.5 * rz);
    vec2 p = (px - center) / R;                         // local, y up
    p.y = -p.y;

    // Cube colour from the hex centre (Size/Brightness/Invert/Colored honoured).
    vec3 hcol = texture(u_image0, clamp(center / res, 0.0, 1.0)).rgb;
    float hlum = dot(hcol, vec3(0.299, 0.587, 0.114));
    float hg = clamp(hlum + u_brightness, 0.0, 1.0);
    if (u_invert > 0.5) hg = 1.0 - hg;
    vec3 tileCol = (u_colored > 0.5) ? hcol * (hg / max(hlum, 1e-3)) : vec3(hg);

    // Three rhombus faces. K = 1/sqrt(3) → the proper 30° iso rhombus top.
    const float K = 0.57735027;
    float ax = abs(p.x);
    vec3 shade;
    if (p.y > K * ax)      shade = tileCol * 1.00;       // top rhombus
    else if (p.x < 0.0)    shade = tileCol * 0.62;       // left face
    else                   shade = tileCol * 0.44;       // right face
    // Seams along the 3 internal edges (centre→upper-left/right, centre→bottom).
    float dDiag = abs(p.y - K * ax) * 0.86602540;        // perp dist to y = K|x|
    float dVert = (p.y < 0.0) ? ax : 1e3;
    float seam = aaInside(min(dDiag, dVert), 0.05);
    shade *= 1.0 - 0.40 * seam;
    return clamp(shade, 0.0, 1.0);
}

// Perler bead: a glossy ring (donut) with a hole, on a dark pegboard. Round tube
// cross-section shaded by a top-left light, with a small specular glint.
vec3 beadTile(vec2 lc, vec3 tileCol) {
    vec2 q = (lc - 0.5) * 2.0;
    float r = length(q);
    float outer = 0.84, inner = 0.32;
    float ring = aaInside(r, outer) * (1.0 - aaInside(r, inner));
    float rmid = (outer + inner) * 0.5;
    float prof = 1.0 - clamp(abs(r - rmid) / ((outer - inner) * 0.5), 0.0, 1.0);
    float tube = sqrt(max(prof, 0.0));                 // round tube
    float lit = clamp(dot(normalize(q + 1e-4), normalize(vec2(-1.0, -1.0))), 0.0, 1.0);
    vec3 bead = tileCol * (0.40 + 0.60 * tube) * (0.72 + 0.45 * lit);
    bead += smoothstep(0.55, 1.0, tube * (0.45 + 0.55 * lit)) * 0.22; // glint
    return clamp(mix(vec3(0.0), bead, ring), 0.0, 1.0);
}

// Faceted gem: a round jewel cut into angular facets (per-sector hashed brightness +
// a bright core), with a top-left sparkle that twinkles on the animation clock.
vec3 gemTile(vec2 lc, vec3 tileCol, vec2 cell) {
    vec2 q = (lc - 0.5) * 2.0;
    float r = length(q), rad = 0.90;
    float mask = aaInside(r, rad);
    float ang = atan(q.y, q.x);
    const float N = 6.0;
    float seg = floor((ang + 3.14159265) / (6.2831853 / N));
    float facet = 0.6 + 0.4 * hash2(cell + seg * 7.0, u_seed + 13.0);
    float core = mix(1.05, 0.5, clamp(r / rad, 0.0, 1.0));
    vec3 gem = tileCol * facet * core;
    float spark = smoothstep(0.22, 0.0, length(q - vec2(-0.35, -0.35)));
    float tw = step(0.5, hash2(cell, u_seed + floor(u_time * u_speed * 4.0)));
    gem += spark * (0.45 + 0.55 * tw);
    return clamp(mix(vec3(0.0), gem, mask), 0.0, 1.0);
}

// Atlas geometry. Glyphs are CW x CH, laid out u_glyphCount across x and
// TOTAL_ROWS down y; numpy rows are uploaded Y-flipped for GL convention.
const int CW = 192, CH = 288, TOTAL_ROWS = 7;

// One atlas texel for glyph `gi`, atlas `row`, clamped INSIDE that glyph cell so a
// bilinear tap near an edge never bleeds into the neighbouring glyph or row.
float glyphTexel(int gx, int gy, int gi, int row) {
    gx = clamp(gx, 0, CW - 1);
    gy = clamp(gy, 0, CH - 1);
    int tx = gi * CW + gx;
    int ty = (TOTAL_ROWS - 1 - row) * CH + gy;
    return texelFetch(u_glyphs, ivec2(tx, ty), 0).r;
}

// Bilinear glyph sample: smooth at large cells (no blocky upscale) and at small
// cells (no NEAREST sparkle when the atlas is minified for a fine grid).
float sampleGlyph(int gi, int row, vec2 inCell) {
    if (inCell.x < 0.0 || inCell.x >= 1.0 || inCell.y < 0.0 || inCell.y >= 1.0) return 0.0;
    vec2 p = vec2(inCell.x * float(CW), inCell.y * float(CH)) - 0.5; // -0.5 -> texel centers
    vec2 fp = floor(p);
    vec2 fr = p - fp;
    int x0 = int(fp.x), y0 = int(fp.y);
    float c00 = glyphTexel(x0,     y0,     gi, row);
    float c10 = glyphTexel(x0 + 1, y0,     gi, row);
    float c01 = glyphTexel(x0,     y0 + 1, gi, row);
    float c11 = glyphTexel(x0 + 1, y0 + 1, gi, row);
    return mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y);
}

// Custom user glyphs: a runtime-built 1-row atlas (COLS glyphs, CW x CH each) the
// Shader Studio rasterizes from typed characters. Same crisp bilinear path as the
// built-in atlas — single row, so there is no row offset.
float customTexel(int gx, int gy, int gi) {
    gx = clamp(gx, 0, CW - 1);
    gy = clamp(gy, 0, CH - 1);
    return texelFetch(u_customGlyphs, ivec2(gi * CW + gx, gy), 0).r;
}
float sampleCustom(int gi, vec2 inCell) {
    if (inCell.x < 0.0 || inCell.x >= 1.0 || inCell.y < 0.0 || inCell.y >= 1.0) return 0.0;
    vec2 p = vec2(inCell.x * float(CW), inCell.y * float(CH)) - 0.5;
    vec2 fp = floor(p);
    vec2 fr = p - fp;
    int x0 = int(fp.x), y0 = int(fp.y);
    float c00 = customTexel(x0,     y0,     gi);
    float c10 = customTexel(x0 + 1, y0,     gi);
    float c01 = customTexel(x0,     y0 + 1, gi);
    float c11 = customTexel(x0 + 1, y0 + 1, gi);
    return mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y);
}

// Blur ONLY the underlay source (not the glyph layer). Golden-angle spiral,
// aspect-corrected so the kernel is round, with a per-pixel start-angle jitter so
// the low tap count reads as smooth rather than banded. u_blur is a fraction of
// the image; 0 returns the sharp source untouched.
vec3 sampleBase(vec2 uv) {
    if (u_blur <= 0.0) return texture(u_image0, uv).rgb;
    const int N = 28;
    float radius = u_blur * 0.10;
    float aspect = u_resolution.y / max(u_resolution.x, 1.0);
    float a0 = hash2(floor(uv * u_resolution), u_seed + 19.0) * 6.2831853;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < N; i++) {
        float t = (float(i) + 0.5) / float(N);
        float r = sqrt(t) * radius;
        float a = a0 + float(i) * 2.39996323; // golden angle
        sum += texture(u_image0, uv + vec2(cos(a) * aspect, sin(a)) * r).rgb;
    }
    return sum / float(N);
}

void main() {
    int shp = int(u_shape + 0.5);
    vec2 cellPx = vec2(max(u_cell * u_resolution.y, 2.0));
    if (shp >= 7 && shp <= 14) cellPx.x *= 2.0 / 3.0; // glyph cells are 2:3; geometric + material shapes (15+) use SQUARE cells
    vec2 cell = floor(v_texCoord * u_resolution / cellPx);
    vec2 cuv = (cell + 0.5) * cellPx / u_resolution;
    vec3 col = texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float tick = floor(u_time * u_speed * 8.0);
    float jitter = u_jitter * (hash2(cell + tick * 101.0, u_seed) - 0.5);
    float g = clamp(lum + jitter + u_brightness, 0.0, 1.0);
    if (u_invert > 0.5) g = 1.0 - g;

    // In-cell coordinate. At u_spacing == 0 this is byte-for-byte the original fract()
    // (no inset round-trip), so the default shape stays identical.
    vec2 inCell = fract(v_texCoord * u_resolution / cellPx);
    if (u_spacing > 0.0) inCell = (inCell - 0.5) / max(1.0 - u_spacing, 1e-3) + 0.5;

    vec3 fx;
    if (shp >= 15) {
        // Material shapes: each returns a finished shaded RGB tile, not a coverage mask.
        // Use the RAW cell coord (Spacing is a no-op — each brick draws its own gaps).
        // Brightness/Invert ride in via g; keep the hue when Colored, else value-g grey.
        vec2 lc = fract(v_texCoord * u_resolution / cellPx);
        vec3 tileCol = (u_colored > 0.5) ? col * (g / max(lum, 1e-3)) : vec3(g);
        if (shp == 15)      fx = legoTile(lc, tileCol);          // Lego
        else if (shp == 16) fx = stitchTile(lc, tileCol, cell);  // Cross-stitch
        else if (shp == 17) fx = voxelTile(v_texCoord);          // Voxel (own hex tiling)
        else if (shp == 18) fx = beadTile(lc, tileCol);          // Beads
        else                fx = gemTile(lc, tileCol, cell);     // Gems (19)
    } else {
        float glyph;
        if (shp < 7) {
            // Geometric shapes render in the SQUARE cell above ⇒ circles are round, crosses/blocks
            // symmetric. (Glyph shapes keep the 2:3 atlas cell.)
            glyph = geoShape(shp, (inCell - 0.5) * 2.0, g, cell);
        } else {
            float gi = min(floor(g * u_glyphCount), u_glyphCount - 1.0);
            glyph = shp >= 14 ? sampleCustom(int(gi), inCell)        // Custom: user-typed glyphs
                              : sampleGlyph(int(gi), shp - 7, inCell);
        }
        vec3 ink = mix(vec3(1.0), col / max(lum, 1e-3), step(0.5, u_colored));
        fx = clamp(ink * glyph, 0.0, 1.0); // the ASCII layer, on black
    }

    // Underlay: composite the ASCII layer over the SHARP, full-res source so the
    // original photo shows through and the glyphs light it up. Mode 0 = Replace is
    // the original black-background look (the default — nothing existing changes).
    int mode = int(u_underlay + 0.5);
    vec3 outc;
    if (mode == 0) {
        outc = fx;                                              // Replace (black bg)
    } else {
        vec3 base = sampleBase(v_texCoord);                     // per-pixel (optionally blurred), not cell-averaged
        if (mode == 1)      outc = 1.0 - (1.0 - base) * (1.0 - fx);  // Screen: only brightens
        else if (mode == 2) outc = base + fx;                       // Add: hotter glow
        else outc = mix(2.0 * base * fx,                            // Overlay: lighten + darken
                        1.0 - 2.0 * (1.0 - base) * (1.0 - fx),
                        step(0.5, base));
    }
    fragColor0 = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
