#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Culture: a plate of colonies. Each of `count` cells contributes one round, soft
// hump to a SINGLE field — added, never maxed or layered. Two cells that overlap
// therefore push the total above what either reaches alone, and the pair reads as
// one grown-together blob. That field is then inked by a RING LADDER: the first ink
// paints the ground; each later ink takes a ring one step nearer the middle. Every
// boundary is chosen as a RADIUS — the reason the rings stay comparable in width
// rather than collapsing into one fat centre behind a thread-thin outline.
//
// Ported rule for rule from the playgrnd generator (reference line numbers below);
// every hash, every draw and every line of GLSL here is our own.
//
//  1. ONE field, bumps SUMMED, profile (1-d^2)^2, nothing outside d<1   [ref 87-94]
//       -> the cell loop in main(), `field += t * t`
//  2. `fuse` is a radius multiplier only: the seeded centres are fixed,   [ref 68-74]
//     and a bigger radius means more of the summed bumps overlap. That is
//     why the dial reads as "how joined-up the colonies are" while the
//     layout of the plate stays put.
//       -> the (0.75 + fuse*0.8) factor in `baseR`; positions never see fuse
//  3. the radius follows sqrt(AREA) * 0.87 — area, not width — so       [ref 71-74]
//     reshaping the frame keeps roughly the coverage it had, instead of
//     packing a wide frame solid
//       -> `baseR` carries sqrt(aspect): in frame-width units,
//          sqrt(FW*FH)/FW == sqrt(FH/FW) == sqrt(H/W)
//  4. centres are scattered past all four borders, so blobs get cut by  [ref 77-78]
//     the frame instead of tidily fitting inside it
//       -> centres drawn over [-0.15, 1.15] of each side
//  5. each cell has its own radius factor 0.55..1.45 and its own wobble [ref 79-80]
//     phase
//       -> draws 53u and 37u
//  6. ring boundaries are chosen as radii and pushed back through the   [ref 112-127]
//     bump profile into field values: `cover` fixes the outermost one
//     (t0 -> dEdge) and `spread` raises the inner radii to a power, so
//     above 1 the middle ink takes more room and the centre ink less;
//     the top of the ladder is pinned at 1.55
//       -> `t0`, `dEdge`, the `TH` ladder
//  7. a pixel's place is measured in WHOLE RINGS (ring index plus the   [ref 149-157]
//     fraction across it), so one notch of grain moves a pixel the same
//     share of a ring however thick that ring is
//       -> `band`
//  8. grain lands twice, from two unrelated noise fields: on the ring   [ref 129-130,
//     position (grain*1.05), which frays the boundaries, and on the         158-161,
//     finished RGB (grain*46 of 255), which speckles every pixel            173-177]
//       -> `gq` / `gl`
//  9. `tex` fine | stipple: the grain reads a SNAPPED pixel, (x/dot|0), [ref 131-132,
//     so stipple is a coarse grain that never beats against the grid       159, 174]
//       -> `gp`
// 10. the change from one ink to the next is squeezed into the LAST     [ref 165-170]
//     `soft` of a band and smoothed, so the colour turns over right at
//     the ring's edge: a small `soft` cuts a stencil-hard border, a big
//     one spreads the turnover across most of the ring
//       -> `fr`
// 11. motion, one loop long: drift moves each cell on its own wobble    [ref 64-67,
//     (amount*0.05 of the width), grow breathes its radius                 80-82,
//     (amount*0.22), cycle rolls the palette in WHOLE steps,               100-105]
//     max(1, round(amount*2)) turns per loop
//       -> `drift`, `grow`, `roll`

// ── the inks ────────────────────────────────────────────────────────────────────
// The stops are ORDERED ROLES, not a smooth ramp: stop 0 is the ground the blobs
// sit on, and each stop after it takes the next ring inward, the last one the very
// middle of a blob. The order IS the stop position — both upload paths
// (shaderfx/params.ts cleanStops and the server's _shader_effects.py) sort stops by
// pos before filling u_ramp, so a person reorders the roles by moving stops.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;   // how many inks: one for the ground, one per ring

uniform float u_count;    // cells dropped on the plate
uniform float u_size;     // cell size
uniform float u_fuse;     // how much they melt together
uniform float u_cover;    // how much of a blob the outermost ink keeps
uniform float u_spread;   // how far the inner boundaries are pulled toward the middle
uniform float u_soft;     // width of the crossing between rings
uniform float u_tex;      // 0 fine, 1 stipple
uniform float u_grain;
uniform float u_dot;      // stipple cell, in pixels
uniform float u_motion;   // 0 still, 1 drift, 2 grow, 3 cycle
uniform float u_amount;
uniform float u_speed;
uniform float u_mix;

#define MAXCELLS 64
#define TAU 6.28318530718

// ── randomness ─────────────────────────────────────────────────────────────────
// A permuted-congruential mixer over 32-bit state; three inputs fold in one after
// another. Own construction, not the tool's.
uint pcg(uint v) {
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
uint fold3(uint a, uint b, uint c) { return pcg(pcg(pcg(a) + b * 0x9E3779B9u) + c * 0x85EBCA6Bu); }
// 24 mantissa bits -> a float in [0,1) that is exact on every GPU.
float unit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }

// Cell k's draw for `salt`: a pure function of (seed, index, salt), so the cells are
// addressed by index instead of replaying a generator in order — same independent
// draws per cell (centre x, centre y, wobble, radius), no sequential dependence.
float cellDraw(int k, uint salt, uint seed) { return unit(fold3(seed, uint(k) + 1u, salt)); }
// Grain: one value per (pixel or stipple cell, salted seed).
float pixHash(vec2 p, uint salt, uint seed) {
    uvec2 q = uvec2(ivec2(p) + 65536);
    return unit(fold3(q.x, q.y, pcg(seed + salt)));
}

void main() {
    float W = max(u_resolution.x, 1.0), H = max(u_resolution.y, 1.0);
    float A = H / W;                     // the frame's height in units of its width
    int n = clamp(int(u_rampCount + 0.5), 2, MAXS);
    int cells = clamp(int(u_count + 0.5), 1, MAXCELLS);
    uint seed = uint(max(u_seed, 0.0) + 0.5);
    int mode = int(u_motion + 0.5);

    // 11. The tool's loop is frames/fps = 3 s long and T is that loop's phase, so the
    // clock is SCALED (never a raw u_time) and every mode returns to where it began.
    float T = (mode == 0) ? 0.0 : fract(u_time * max(u_speed, 0.0) * (1.0 / 3.0));
    float ph = T * TAU;
    float drift = (mode == 1) ? u_amount * 0.05 : 0.0;
    float grow  = (mode == 2) ? u_amount * 0.22 : 0.0;

    // The device pixel, y DOWN like the tool's canvas, and the same point in
    // frame-width units (x over 0..1, y over 0..A) — the space the plate is built in.
    // The tool reads its field at x*(FW/W), i.e. at the pixel's index, so we do too.
    vec2 pix = clamp(floor(vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H)), vec2(0.0), vec2(W, H) - 1.0);
    vec2 P = pix / W;

    // 1-5. Every cell adds its bump into the same running total, so overlaps compound.
    float baseR = (0.05 + u_size * 0.20) * (0.75 + u_fuse * 0.8) * 0.87 * sqrt(A);
    float field = 0.0;
    for (int k = 0; k < MAXCELLS; k++) {
        if (k >= cells) break;
        vec2 c = vec2((-0.15 + cellDraw(k, 11u, seed) * 1.3),
                      (-0.15 + cellDraw(k, 23u, seed) * 1.3) * A);
        float wob = cellDraw(k, 37u, seed) * TAU;
        float r = max(baseR * (0.55 + cellDraw(k, 53u, seed) * 0.9) * (1.0 + sin(ph + wob) * grow), 1e-5);
        c += vec2(cos(ph + wob), sin(ph + wob * 1.7)) * drift;
        vec2 d = P - c;
        float d2 = dot(d, d) / (r * r);
        if (d2 < 1.0) { float t = 1.0 - d2; field += t * t; }
    }

    // 6. The ring ladder. The bump profile drops away quickly near a cell's rim and
    // barely moves near its middle, so cutting the field at equal VALUE steps would hand
    // nearly the whole blob to the innermost ink and leave the outer ring a thread wide.
    // Pick each boundary as a radius D and push it back through the profile ((1-D^2)^2)
    // to get the value to compare against; the inks then divide a blob into bands of
    // comparable thickness.
    float t0 = clamp((1.0 - u_cover) * 0.9, 0.002, 0.998);
    float dEdge = sqrt(max(0.0, 1.0 - sqrt(t0)));
    float TH[MAXS + 1];
    TH[0] = 0.0;
    float prev = 0.0;
    for (int k = 1; k <= MAXS; k++) {
        float val;
        if (k < n) {
            float D = dEdge * pow(float(n - k) / float(n - 1), max(u_spread, 0.001));
            float e = 1.0 - D * D;
            val = e * e;
        } else if (k == n) {
            val = max(prev + 1e-4, 1.55);      // the ceiling the innermost band runs to
        } else {
            val = 2.0;
        }
        TH[k] = val;
        prev = val;
    }

    // 7. Locate this pixel on the ladder, measured in whole rings.
    float band;
    if (field < TH[1]) {
        band = TH[1] > 0.0 ? field / TH[1] : 0.0;
    } else {
        int kk = 1;
        float lo = TH[1], hi = TH[2];
        for (int k = 1; k < MAXS - 1; k++) {
            if (k >= n - 1) break;             // the innermost band runs to TH[n]
            if (field < TH[k + 1]) break;
            kk = k + 1; lo = TH[k + 1]; hi = TH[k + 2];
        }
        band = float(kk) + (hi > lo ? (field - lo) / (hi - lo) : 0.0);
    }

    // 8-9. Grain on the band position, read at a snapped pixel when stippling.
    float dotPx = max(1.0, floor(u_dot + 0.5));
    vec2 gp = (u_tex > 0.5) ? floor(pix / dotPx) : pix;
    float gq = u_grain * 1.05;
    if (gq > 0.002) band += (pixHash(gp, 1301u, seed) - 0.5) * gq;

    // 10. Mix the two neighbouring roles, the turnover squeezed into the band's last `soft`.
    band = clamp(band, 0.0, float(n - 1));
    int i0 = min(int(floor(band)), n - 2);
    float fr = band - float(i0);
    float soft = max(u_soft, 0.001);
    fr = clamp((fr - (1.0 - soft)) / soft, 0.0, 1.0);
    fr = fr * fr * (3.0 - 2.0 * fr);

    // 11. Cycle rolls the whole ladder of roles by whole steps.
    int roll = 0;
    if (mode == 3) {
        float turns = max(1.0, floor(u_amount * 2.0 + 0.5));
        roll = int(floor(T * float(n) * turns));
    }
    int ia = i0 + roll;      ia -= (ia / n) * n;
    int ib = i0 + 1 + roll;  ib -= (ib / n) * n;
    vec3 col = mix(u_ramp[clamp(ia, 0, MAXS - 1)], u_ramp[clamp(ib, 0, MAXS - 1)], fr);

    // 8. ...and a second time on the finished RGB, every pixel, from an unrelated field.
    float gl = u_grain * 46.0;
    if (gl > 0.002) col += vec3((pixHash(gp, 7919u, seed) - 0.5) * gl * (1.0 / 255.0));
    col = clamp(col, 0.0, 1.0);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
