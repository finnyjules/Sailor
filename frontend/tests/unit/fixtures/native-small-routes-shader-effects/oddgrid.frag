#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Oddgrid: a fine grid of crisp cells. Three low-octave value-noise fields decide,
// per CELL (never per pixel), whether a cell is painted, which ink it takes, and
// where a mark goes. Every field is sampled at cell coordinates, so the look is
// blocks with pixel edges, not a smoothed noise.

// Integer hash: a multiply-xorshift mixer over (cell x, cell y, salted seed). Each
// decision below uses its own salt so the fields stay independent of one another.
uint mixbits(uint v) { v ^= v >> 16u; v *= 0x7feb352du; v ^= v >> 15u; v *= 0x846ca68bu; v ^= v >> 16u; return v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = mixbits(q.x * 0x9e3779b1u ^ mixbits(q.y * 0x85ebca77u ^ mixbits(uint(int(seed)) * 0xc2b2ae3du)));
    return float(h) * (1.0 / 4294967295.0);
}
// Smooth value noise on the integer lattice, one lattice value per hash.
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
// Normalised fbm: `oct` octaves, halving amplitude, doubling frequency, a new
// lattice per octave. Few octaves on purpose - the tool keeps its regions coherent.
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 4; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 977.0); norm += a;
        p *= 2.0; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}
// Contrast about the midpoint, clamped: the tool's `stretch`.
float stretch(float v, float k) { return clamp((v - 0.5) * k + 0.5, 0.0, 1.0); }

// The palette is an ORDERED list of inks: a filled cell's field value picks an
// index into it, low to high. The order IS the stop position — both upload
// paths (shaderfx/params.ts cleanStops and the server's _shader_effects.py)
// sort stops by pos before filling u_ramp, so a user reorders inks by moving
// stops, not by list order.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
uniform vec3 u_bg;      // shows through every empty cell
uniform vec3 u_ink;     // the marks

uniform float u_cols;
uniform float u_scale;
uniform float u_density;
uniform float u_block;
uniform float u_bsize;
uniform float u_speck;
uniform float u_grain;
uniform float u_variety;
uniform float u_balance;
uniform float u_motif;     // 0 none, 1 dot, 2 ring, 3 square, 4 wedge, 5 mixed
uniform float u_motifAmt;
uniform float u_markSize;
uniform float u_mix;

// Pixel edge of grid line `i` for `n` cells over `len` pixels: the tool rounds every
// edge to a whole pixel, so cells differ by a pixel here and there and never blur.
float edgeAt(float i, float n, float len) { return floor(i * len / n + 0.5); }

// Does the mark of kind `shape` cover the pixel whose centre sits at `l` in a
// cell of cw x ch pixels? Dot and ring get a one-pixel soft edge (the tool draws
// them with an antialiased arc); square and wedge are hard, as fillRect/fill are.
float markCover(int shape, vec2 l, float cw, float ch) {
    float cs = min(cw, ch), ms = u_markSize;
    vec2 c = vec2(cw, ch) * 0.5;
    if (shape == 1) {                                   // dot: disc, diameter markSize x cell
        float r = cs * ms * 0.5;
        return clamp(r - length(l - c) + 0.5, 0.0, 1.0);
    }
    if (shape == 2) {                                   // ring: stroked circle
        float lw = max(1.0, cs * ms * 0.28);
        float r = max(lw * 0.6, cs * ms * 0.5 - lw * 0.5);
        return clamp(lw * 0.5 - abs(length(l - c) - r) + 0.5, 0.0, 1.0);
    }
    if (shape == 3) {                                   // square: side markSize x cell
        float hs = cs * ms * 0.5;
        vec2 d = abs(l - c);
        return (d.x < hs && d.y < hs) ? 1.0 : 0.0;
    }
    if (shape == 4) {                                   // wedge: the lower-right triangle
        return (l.x / cw + l.y / ch >= 1.0) ? 1.0 : 0.0;
    }
    return 0.0;
}

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float cols = max(2.0, floor(u_cols + 0.5));
    float rows = max(4.0, floor(cols * H / W + 0.5));
    float B = max(2.0, floor(u_bsize + 0.5));
    float sc = max(0.5, u_scale);
    int n = max(1, int(u_rampCount + 0.5));

    // The device pixel, y DOWN like the tool's canvas; its centre for the marks.
    vec2 pix = floor(vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H));
    pix = clamp(pix, vec2(0.0), vec2(W, H) - 1.0);

    // Which snapped cell holds this pixel: start from the even split, then step to
    // the neighbour if the rounded edges say so.
    float x = floor(pix.x * cols / W);
    if (pix.x < edgeAt(x, cols, W)) x -= 1.0; else if (pix.x >= edgeAt(x + 1.0, cols, W)) x += 1.0;
    float y = floor(pix.y * rows / H);
    if (pix.y < edgeAt(y, rows, H)) y -= 1.0; else if (pix.y >= edgeAt(y + 1.0, rows, H)) y += 1.0;
    x = clamp(x, 0.0, cols - 1.0); y = clamp(y, 0.0, rows - 1.0);
    float x0 = edgeAt(x, cols, W), y0 = edgeAt(y, rows, H);
    float cw = edgeAt(x + 1.0, cols, W) - x0, ch = edgeAt(y + 1.0, rows, H) - y0;
    vec2 local = pix - vec2(x0, y0) + 0.5;

    // ── the cell's decisions (everything below is a function of the cell, not the pixel)
    vec2 cell = vec2(x, y);
    vec2 blk = floor(cell / B);                          // the block this cell belongs to
    vec2 centre = cell + 0.5;

    // 1. Coordinates slide toward the block centre as blockiness rises, so colour
    //    regions square off.
    vec2 bc = mix(centre, blk * B + B * 0.5, u_block);

    // 2. Colour field: a coherent 2-octave field, then each block takes on its own
    //    tone in proportion to blockiness, and the result is pushed apart.
    float smoothF = fbmN(bc / sc, u_seed, 2);
    float blockTone = smoothF * 0.5 + hash2(blk, u_seed + 404.0) * 0.5;
    float base = stretch(mix(smoothF, blockTone, u_block), 2.0);

    // 3. Coverage field: decides what gets painted at all (3 octaves, offset domain).
    float mask = stretch(fbmN(centre / (sc * 1.15) + vec2(91.0, -17.0), u_seed + 9111.0, 3), 1.8);

    // 4. Fine field: much smaller features that chew the region edges into pixels.
    float det = fbmN(centre / (sc * 0.26) + vec2(37.0, -11.0), u_seed + 7717.0, 2);

    // 5. Each block gets its own coverage bias and its own grain strength - that is
    //    what makes the patchwork.
    float bias = (hash2(blk, u_seed + 808.0) - 0.5) * u_variety * 0.6;
    float level = 0.5 + (u_density - 0.5) * 1.1 + bias;
    float grainLocal = u_grain * mix(1.0, 0.15 + hash2(blk, u_seed + 909.0) * 2.1, clamp(u_variety * 0.8, 0.0, 1.0));

    // 6. Filled or empty.
    bool filled = mask + (det - 0.5) * grainLocal * 1.15 < level;

    vec3 col = u_bg;
    if (filled) {
        // 7. Field value -> palette index (order = ramp); balance skews the mapping.
        //    Specks swap in a random ink from the same palette.
        float v = pow(base, pow(2.0, -u_balance));
        int ci = min(n - 1, int(floor(v * float(n))));
        if (u_speck > 0.0 && hash2(cell, u_seed + 21.0) < u_speck) {
            ci = int(floor(hash2(cell, u_seed + 33.0) * float(n)));
            ci = ci - (ci / n) * n;
        }
        col = u_ramp[clamp(ci, 0, MAXS - 1)];

        // 8. Some filled cells also carry a mark in the ink colour. Mixed picks a
        //    shape per cell.
        int motif = int(u_motif + 0.5);
        if (motif != 0 && u_motifAmt > 0.0 && hash2(cell, u_seed + 64.0) < u_motifAmt) {
            int shape = motif;
            if (motif == 5) {
                float k = hash2(cell, u_seed + 4009.0);
                shape = k < 0.4 ? 1 : k < 0.65 ? 3 : k < 0.85 ? 2 : 4;
            }
            col = mix(col, u_ink, markCover(shape, local, cw, ch));
        }
    }

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
