#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Static: a low-res ONE-BIT poster. The picture is a tiny grid of cells, every cell
// either ink or paper. The grid splits into stacked horizontal BANDS, each running
// its own 1-bit pattern engine (moire, bars, static, blocks, rings, zigzag); some of
// the time an INSET panel punches in on top with its own engine. A glitch pass then
// shifts row segments sideways, smears rows down over their neighbours, and punches
// rectangular dropouts. Drawn as hard, scaled-up pixels - no smoothing anywhere.
//
// Everything is decided per CELL, and every random choice comes from one seeded
// stream read by index, so a seed always gives the same poster in the browser, on
// the server, and at any output size (the cell grid itself is what changes).

uniform vec3 u_ink;       // the 1 bits
uniform vec3 u_bg;        // the 0 bits
uniform float u_res;      // cells across
uniform float u_regions;  // stacked bands
uniform float u_glitch;   // 0..1 glitch amount
uniform float u_mix;

// ── randomness ─────────────────────────────────────────────────────────────────
// A permuted-congruential mixer (the "pcg" one-liner) over 32-bit state; three
// inputs fold in one after another. Own construction, not the tool's.
uint pcg(uint v) {
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
uint fold3(uint a, uint b, uint c) { return pcg(pcg(pcg(a) + b * 0x9E3779B9u) + c * 0x85EBCA6Bu); }
// 24 mantissa bits -> a float in [0,1) that is exact on every GPU.
float unit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }

// The seeded STREAM: value k of stream `s` is a pure function of (s, k), so the
// layout can address its draws by index instead of replaying a generator - the
// same order and ranges the tool draws in, without the sequential dependence.
uint streamU(uint s, int k) { return fold3(s, uint(k) + 1u, 0x27D4EB2Fu); }
float stream(uint s, int k) { return unit(streamU(s, k)); }

// Per-cell hash for the pattern engines: (u, v, salt, region seed).
float cellHash(float u, float v, uint salt, uint rs) {
    uint hu = uint(int(u) + 65536), hv = uint(int(v) + 65536);
    return unit(fold3(hu, hv, pcg(rs + salt * 0x632BE5ABu)));
}

// ── layout ──────────────────────────────────────────────────────────────────────
#define MAXR 6
#define RDRAWS 18     // draws per region: type + 17 params, in the order below
#define T_MOIRE 0
#define T_BARS 1
#define T_STATIC 2
#define T_BLOCKS 3
#define T_RINGS 4
#define T_ZIGZAG 5

struct Region {
    int type;
    float x0, x1, y0, y1;
    float a, b, warp, th, cx, cy, rk, ph, dens, grad, q, duty, p, slope;
    bool vert;
    uint rs;
};

// Draw a region's parameters from the layout stream starting at index `k`. Same
// order and ranges as the tool: type, a, b, warp, th, cx, cy, rk, ph, dens, grad,
// q, duty, p, slope (sign then size), vert, region seed.
Region mkRegion(uint s, int k, float x0, float x1, float y0, float y1, float gw, float gh) {
    Region R;
    R.type = int(stream(s, k) * 6.0);
    R.x0 = x0; R.x1 = x1; R.y0 = y0; R.y1 = y1;
    R.a = 0.15 + stream(s, k + 1) * 0.75;
    R.b = 0.06 + stream(s, k + 2) * 0.4;
    R.warp = stream(s, k + 3) * 6.0;
    R.th = (stream(s, k + 4) - 0.5) * 0.8;
    R.cx = (stream(s, k + 5) * 1.6 - 0.3) * gw;
    R.cy = (stream(s, k + 6) * 1.6 - 0.3) * gh;
    R.rk = 0.12 + stream(s, k + 7) * 0.4;
    R.ph = stream(s, k + 8) * 6.28318530718;
    R.dens = 0.2 + stream(s, k + 9) * 0.5;
    R.grad = (stream(s, k + 10) - 0.5) * 0.9;
    R.q = 2.0 + floor(stream(s, k + 11) * 5.0);
    R.duty = 0.35 + stream(s, k + 12) * 0.35;
    R.p = 5.0 + floor(stream(s, k + 13) * 10.0);
    R.slope = (stream(s, k + 14) < 0.5 ? 1.0 : -1.0) * (0.3 + stream(s, k + 15) * 1.2);
    R.vert = stream(s, k + 16) < 0.35;
    R.rs = streamU(s, k + 17);
    return R;
}

// ── one bit per cell, by engine ────────────────────────────────────────────────
bool cellOn(Region R, float u, float v) {
    if (R.type == T_MOIRE) {
        float w1 = sin(u * R.a + sin(v * R.b) * R.warp + R.ph);
        float w2 = sin(length(vec2(u - R.cx, v - R.cy)) * R.rk);
        return (w1 + w2) > R.th;
    }
    if (R.type == T_RINGS) {
        return sin(length(vec2(u - R.cx, v - R.cy)) * R.rk + R.ph) > R.th;
    }
    if (R.type == T_BARS) {
        if (R.vert) {
            float vv = v - R.y0;
            float seg = cellHash(u, floor(vv / R.q), 1u, R.rs);
            bool colOn = cellHash(u, 0.0, 7u, R.rs) < 0.8;
            return colOn && seg < R.duty + sin(vv * 0.2) * 0.1;
        }
        float uu = u - R.x0;
        float seg = cellHash(floor(uu / R.q), v, 1u, R.rs);
        bool rowOn = cellHash(0.0, v, 7u, R.rs) < 0.8;
        return rowOn && seg < R.duty + sin(u * 0.15) * 0.08;
    }
    if (R.type == T_STATIC) {
        // density runs from dens-grad at the top of the band to dens+grad at the bottom
        float t = (v - R.y0) / max(1.0, R.y1 - R.y0);
        float d = clamp(R.dens + R.grad * (t - 0.5) * 2.0, 0.02, 0.95);
        return cellHash(u, v, 0u, R.rs) < d;
    }
    if (R.type == T_BLOCKS) {
        // XOR of a coarse and a coarser block grid
        bool a = cellHash(floor(u / (R.q * 2.0)), floor(v / (R.q * 2.0)), 0u, R.rs) < 0.5;
        bool b = cellHash(floor(u / (R.q * 5.0)), floor(v / (R.q * 5.0)), 3u, R.rs) < 0.5;
        return a != b;
    }
    // zigzag: a diagonal stripe, its duty cycle across a period of p cells
    float uu = u + floor(v * R.slope);
    float m = uu - floor(uu / R.p) * R.p;       // positive modulo
    return m < R.p * R.duty;
}

// The bit BEFORE the glitch pass: the band owning row v, unless the inset panel
// covers the cell.
bool originalBit(uint s, int n, float u, float v, float gw, float gh) {
    // band heights from weights 0.5 + r*1.2 (draws 0..n-1); the last band snaps to gh
    float sum = 0.0;
    for (int i = 0; i < MAXR; i++) { if (i >= n) break; sum += 0.5 + stream(s, i) * 1.2; }
    float y = 0.0, y0 = 0.0, y1 = gh; int band = 0;
    for (int i = 0; i < MAXR; i++) {
        if (i >= n) break;
        float h = floor((0.5 + stream(s, i) * 1.2) / sum * gh + 0.5);
        float yb = (i == n - 1) ? gh : min(gh, y + h);
        if (v >= y && v < yb) { band = i; y0 = y; y1 = yb; }
        y = yb;
    }
    // rows below every band (none, since the last snaps to gh) fall to band 0 like the tool
    int k = n + band * RDRAWS;
    Region R = mkRegion(s, k, 0.0, gw, y0, y1, gw, gh);

    // 40% of seeds: an inset panel with its own engine punches in on top
    int ki = n + n * RDRAWS;
    if (stream(s, ki) < 0.4) {
        float ix0 = floor(gw * (0.1 + stream(s, ki + 1) * 0.25) + 0.5);
        float ix1 = floor(gw * (0.65 + stream(s, ki + 2) * 0.3) + 0.5);
        float iy0 = floor(gh * (0.15 + stream(s, ki + 3) * 0.3) + 0.5);
        float iy1 = floor(gh * (0.55 + stream(s, ki + 4) * 0.35) + 0.5);
        if (u >= ix0 && u < ix1 && v >= iy0 && v < iy1) {
            R = mkRegion(s, ki + 5, ix0, ix1, iy0, iy1, gw, gh);
        }
    }
    return cellOn(R, u, v);
}

// ── the glitch pass, resolved per cell ─────────────────────────────────────────
// The tool runs a fixed list of seeded ops over the whole bit buffer: shifts, then
// smears, then drops. A cell finds its final bit by walking those lists BACKWARDS:
// a later op decides where an earlier op's result is read from, so undoing them
// from the last to the first maps this cell to the source cell whose original bit
// it shows. Loop caps: 64 shifts, 16 smears, 8 drops (the counts are 0.3*rows,
// 0.08*rows and 6 at full glitch; rows only pass 213 on a tall grid at max res).
#define MAXSHIFT 64
#define MAXSMEAR 16
#define MAXDROP 8

// Pixel edge of grid line `i` for `n` cells over `len` pixels: rounded to a whole
// pixel so cells differ by a pixel here and there and never blur.
float edgeAt(float i, float n, float len) { return floor(i * len / n + 0.5); }

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float gw = clamp(floor(u_res + 0.5), 8.0, 320.0);
    float gh = max(8.0, floor(gw * H / W + 0.5));
    int n = clamp(int(u_regions + 0.5), 1, MAXR);
    float amt = clamp(u_glitch, 0.0, 1.0);
    uint seed = uint(max(u_seed, 0.0) + 0.5);
    uint sLayout = pcg(seed * 0x9E3779B1u + 0x1B873593u);
    uint sGlitch = pcg(seed * 0xC2B2AE35u + 0x165667B1u);

    // The device pixel, y DOWN like the tool's canvas, and the snapped cell holding it.
    vec2 pix = floor(vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H));
    pix = clamp(pix, vec2(0.0), vec2(W, H) - 1.0);
    float u = floor(pix.x * gw / W);
    if (pix.x < edgeAt(u, gw, W)) u -= 1.0; else if (pix.x >= edgeAt(u + 1.0, gw, W)) u += 1.0;
    float v = floor(pix.y * gh / H);
    if (pix.y < edgeAt(v, gh, H)) v -= 1.0; else if (pix.y >= edgeAt(v + 1.0, gh, H)) v += 1.0;
    u = clamp(u, 0.0, gw - 1.0); v = clamp(v, 0.0, gh - 1.0);

    int nShift = min(MAXSHIFT, int(floor(gh * 0.3 * amt + 0.5)));
    int nSmear = min(MAXSMEAR, int(floor(gh * 0.08 * amt + 0.5)));
    int nDrop = min(MAXDROP, int(floor(6.0 * amt + 0.5)));
    int kSmear = nShift * 4;            // stream index where the smear draws begin
    int kDrop = kSmear + nSmear * 2;    // ... and the drop draws

    bool bit;
    bool dropped = false;
    float dropVal = 0.0;

    // 3. Drops (last op wins): a rect x0,y0 w,h filled with a random 0 or 1.
    for (int i = 0; i < MAXDROP; i++) {
        if (i >= nDrop) break;
        int k = kDrop + i * 5;
        float x0 = floor(stream(sGlitch, k) * gw);
        float y0 = floor(stream(sGlitch, k + 1) * gh);
        float w = 2.0 + floor(stream(sGlitch, k + 2) * gw * 0.2);
        float h = 1.0 + floor(stream(sGlitch, k + 3) * gh * 0.06);
        float val = stream(sGlitch, k + 4) < 0.5 ? 0.0 : 1.0;
        if (u >= x0 && u < min(gw, x0 + w) && v >= y0 && v < min(gh, y0 + h)) { dropped = true; dropVal = val; }
    }

    if (dropped) {
        bit = dropVal > 0.5;
    } else {
        // 2. Smears, undone last-to-first: a row inside [y, y+reps) shows row y-1 as it
        //    stood when that op ran, so the walk carries on from y-1 through the earlier
        //    ops. That follows a smear-of-a-smear chain exactly, with no hop bound.
        float sv = v;
        for (int i = MAXSMEAR - 1; i >= 0; i--) {
            if (i >= nSmear) continue;
            int k = kSmear + i * 2;
            float y = 1.0 + floor(stream(sGlitch, k) * (gh - 1.0));
            float reps = 1.0 + floor(stream(sGlitch, k + 1) * 3.0);
            if (sv >= y && sv < min(gh, y + reps)) sv = y - 1.0;
        }
        // 1. Shifts, undone last-to-first: inside a shifted segment of row y the cell
        //    shows the row's earlier state at (x+dx) mod gw.
        float su = u;
        for (int i = MAXSHIFT - 1; i >= 0; i--) {
            if (i >= nShift) continue;
            int k = i * 4;
            float y = floor(stream(sGlitch, k) * gh);
            if (y != sv) continue;
            float x0 = floor(stream(sGlitch, k + 1) * gw);
            float len = 1.0 + floor(stream(sGlitch, k + 2) * gw * 0.5);
            float dx = 1.0 + floor(stream(sGlitch, k + 3) * 7.0);
            if (su >= x0 && su < min(gw, x0 + len)) su = mod(su + dx, gw);
        }
        bit = originalBit(sLayout, n, su, sv, gw, gh);
    }

    // 4. Ink where the bit is set, paper elsewhere. Hard cell edges, no smoothing.
    vec3 col = bit ? u_ink : u_bg;
    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
