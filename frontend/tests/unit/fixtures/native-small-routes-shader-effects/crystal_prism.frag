#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_mode;        // 0 Glass, 1 Faceted, 2 Prism
uniform float u_facetStyle;  // 0 Voronoi, 1 Radial, 2 Shards, 3 Triangles
uniform float u_facetJitter; // Triangles: 0 regular equilateral -> 1 irregular
uniform float u_facetRefract;// per-facet rotate/zoom of each slice (cut-gem optics)
uniform float u_shading;     // per-facet flat shading + spec (3D low-poly look)
uniform float u_multiScale;  // Triangles: chance a facet subdivides into smaller ones
uniform float u_refraction;  // bend strength
uniform float u_dispersion;  // RGB / rainbow split
uniform float u_facets;      // cell density / wedge count
uniform float u_glint;       // facet-seam sparkle
uniform float u_shimmer;     // built-in drift speed (0 = static)
uniform float u_rotation;    // degrees
uniform float u_centerX;
uniform float u_centerY;

const float TAU = 6.28318530718;
const float PI  = 3.14159265359;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
vec2 hash22(vec2 p) { float n = hash21(p); return vec2(n, hash21(p + n)); }

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.02 + 7.1; a *= 0.5; }
    return s;
}

// Visible-spectrum colour for a normalised wavelength w in [0,1] (Zucconi 6).
// Used to integrate a continuous prism spectrum instead of an RGB 3-tap.
vec3 bump3(vec3 x, vec3 y) { vec3 v = 1.0 - x * x; return clamp(v - y, 0.0, 1.0); }
vec3 spectral(float w) {
    vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
    vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
    vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
    vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
    vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
    vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
    return bump3(c1 * (w - x1), y1) + bump3(c2 * (w - x2), y2);
}

// Jittered position of an integer lattice corner (shared corners move alike).
vec2 jitterVert(vec2 P) { return P + (hash22(P + u_seed * 0.31) - 0.5) * (u_facetJitter * 0.7); }

// Barycentric weights of point s in triangle ABC (all >= 0 only if inside).
vec3 triBary(vec2 s, vec2 A, vec2 B, vec2 C) {
    vec2 v0 = B - A, v1 = C - A, v2 = s - A;
    float den = v0.x * v1.y - v1.x * v0.y;
    float a = (v2.x * v1.y - v1.x * v2.y) / den;
    float b = (v0.x * v2.y - v2.x * v0.y) / den;
    return vec3(1.0 - a - b, a, b);
}
float triWeight(vec2 s, vec2 A, vec2 B, vec2 C) { vec3 w = triBary(s, A, B, C); return min(min(w.x, w.y), w.z); }

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 center = vec2(u_centerX, u_centerY);
    vec2 p = (v_texCoord - center) * asp;   // centered, aspect-correct
    float shim = u_time * u_shimmer;
    float rot = radians(u_rotation) + shim * 0.3;
    vec2 pr = rot2(rot) * p;                 // rotated facet space

    int mode = int(u_mode + 0.5);
    int style = int(u_facetStyle + 0.5);
    float scale = max(u_facets, 1.0);

    vec2 warp = vec2(0.0);   // refraction displacement, texcoord space
    float seam = 0.0;        // 0..1 proximity to a facet edge (glint)
    float dispMul = 1.0;     // mode-specific dispersion weight
    vec2 cid = vec2(0.0);    // facet id (per-facet randomness)
    vec2 facetC = p;         // facet center in p-space (per-facet refraction)

    if (mode == 0) {
        // ---- Glass: smooth thick-glass refraction via FBM gradient ----
        vec2 q = pr * (scale * 0.35) + 13.0;
        vec2 off = vec2(fbm(q + vec2(0.0, 1.7)), fbm(q + vec2(4.2, 0.0))) - 0.5;
        warp = rot2(-rot) * off * u_refraction * 0.32 / asp;
        seam = smoothstep(0.34, 0.5, length(off) * 2.0);  // ridge lines glint
    } else if (mode == 1) {
        // ---- Faceted: per-cell constant refraction (flat facets) ----
        vec2 dir;
        if (style == 0) {
            // Voronoi gem cells
            vec2 g = pr * scale * 0.5;
            vec2 gi = floor(g), gf = g - gi;
            float f1 = 8.0, f2 = 8.0; vec2 featG = g;
            for (int j = -1; j <= 1; j++) {
                for (int i = -1; i <= 1; i++) {
                    vec2 o = vec2(float(i), float(j));
                    vec2 rnd = hash22(gi + o + u_seed * 0.137);
                    vec2 fp = o + 0.5 + 0.45 * sin(shim * 1.3 + TAU * rnd);
                    vec2 diff = fp - gf;
                    float d = dot(diff, diff);
                    if (d < f1) { f2 = f1; f1 = d; cid = gi + o + rnd; featG = gi + fp; }
                    else if (d < f2) { f2 = d; }
                }
            }
            seam = 1.0 - smoothstep(0.0, 0.14, sqrt(f2) - sqrt(f1));
            facetC = rot2(-rot) * (featG / (scale * 0.5));
        } else if (style == 1) {
            // Radial wedges + rings (cut round-brilliant)
            float ang = atan(pr.y, pr.x);
            float seg = TAU / scale;
            float wid = floor((ang + PI) / seg);
            float local = fract((ang + PI) / seg);
            float r = length(pr) * (scale * 0.25);
            float ring = floor(r);
            cid = vec2(wid, ring);
            float dAng = min(local, 1.0 - local);
            float dRing = min(fract(r), 1.0 - fract(r));
            seam = 1.0 - smoothstep(0.0, 0.10, min(dAng, dRing));
            float midAng = (wid + 0.5) * seg - PI;
            facetC = rot2(-rot) * (vec2(cos(midAng), sin(midAng)) * ((ring + 0.5) / (scale * 0.25)));
        } else if (style == 2) {
            // Shards: grid cells split on the diagonal (cracked glass)
            vec2 g = pr * scale * 0.5;
            vec2 gi = floor(g), gf = g - gi;
            float tri = gf.x + gf.y < 1.0 ? 0.0 : 1.0;
            cid = gi + vec2(tri * 0.5, 0.0);
            float dDiag = abs(gf.x + gf.y - 1.0) * 0.7071;
            float dEdge = min(min(gf.x, 1.0 - gf.x), min(gf.y, 1.0 - gf.y));
            seam = 1.0 - smoothstep(0.0, 0.07, min(dDiag, dEdge));
            facetC = rot2(-rot) * ((gi + (tri < 0.5 ? vec2(1.0 / 3.0) : vec2(2.0 / 3.0))) / (scale * 0.5));
        } else {
            // Triangles: equilateral lattice with JITTERED VERTICES. Edges stay
            // straight (low-poly) while triangles vary in size/shape toward a
            // Delaunay-style shatter — never the wavy "water" of a domain warp.
            // Each pixel is point-located in the *jittered* mesh so the facet
            // DISPLACEMENT follows the jittered edges, not the regular lattice.
            vec2 q = pr * scale * 0.6;
            mat2 SK = mat2(1.0, 0.0, -0.57735, 1.15470);  // screen -> skew lattice
            vec2 s = SK * q;
            vec2 base = floor(s);
            float best = -1e9;
            vec2 Aw = vec2(0.0), Bw = vec2(0.0), Cw = vec2(0.0);
            for (int j = -1; j <= 1; j++) {
                for (int i = -1; i <= 1; i++) {
                    vec2 c0 = base + vec2(float(i), float(j));
                    vec2 P00 = jitterVert(c0);
                    vec2 P10 = jitterVert(c0 + vec2(1.0, 0.0));
                    vec2 P11 = jitterVert(c0 + vec2(1.0, 1.0));
                    vec2 P01 = jitterVert(c0 + vec2(0.0, 1.0));
                    float wl = triWeight(s, P00, P10, P01);     // lower triangle
                    if (wl > best) { best = wl; cid = c0; Aw = P00; Bw = P10; Cw = P01; }
                    float wu = triWeight(s, P10, P11, P01);     // upper triangle
                    if (wu > best) { best = wu; cid = c0 + vec2(0.37, 0.0); Aw = P10; Bw = P11; Cw = P01; }
                }
            }
            // Multi-scale: some facets split once into 4 smaller ones (midpoint
            // subdivision, jittered) for a mix of large + small triangles.
            if (u_multiScale > 0.0 && hash21(cid + 17.0) < u_multiScale) {
                vec3 bc = triBary(s, Aw, Bw, Cw);
                float jm = u_facetJitter * 0.28;
                vec2 Mab = mix(Aw, Bw, 0.5) + (hash22(Aw + Bw + 33.0) - 0.5) * jm;
                vec2 Mbc = mix(Bw, Cw, 0.5) + (hash22(Bw + Cw + 33.0) - 0.5) * jm;
                vec2 Mca = mix(Cw, Aw, 0.5) + (hash22(Cw + Aw + 33.0) - 0.5) * jm;
                if (bc.x > 0.5) { Bw = Mab; Cw = Mca; cid += vec2(0.07, 0.0); }
                else if (bc.y > 0.5) { Aw = Mab; Cw = Mbc; cid += vec2(0.0, 0.07); }
                else if (bc.z > 0.5) { Aw = Mca; Bw = Mbc; cid += vec2(0.07, 0.07); }
                else { Aw = Mab; Bw = Mbc; Cw = Mca; cid += vec2(0.13, 0.13); }
                best = triWeight(s, Aw, Bw, Cw);
            }
            seam = 1.0 - smoothstep(0.0, 0.14, best);
            mat2 SKi = mat2(1.0, 0.0, 0.5, 0.8660254);   // skew -> screen
            facetC = rot2(-rot) * ((SKi * ((Aw + Bw + Cw) / 3.0)) / (scale * 0.6));
        }
        // per-cell magnitude varies so not every facet shifts the same
        float mag = 0.5 + 0.5 * hash21(cid + 4.0);
        dir = normalize(hash22(cid + u_seed * 0.21) * 2.0 - 1.0 + 1e-4);
        warp = rot2(-rot) * dir * u_refraction * 0.15 * mag / asp;
    } else {
        // ---- Prism: minimal displacement, dispersion dominates ----
        vec2 d = (length(p) > 1e-4) ? normalize(p) : vec2(0.0);
        warp = -d / asp * u_refraction * 0.04 * length(p);
        dispMul = 1.0;
    }

    // ---- Chromatic dispersion ----
    // Concentrated where the image actually bends (|warp|) and along seams, so
    // the rainbow reads as refraction rather than a global RGB shift. Prism adds
    // a smooth radial term so the whole frame disperses toward the edges.
    vec2 dir = (length(p) > 1e-4) ? normalize(p) : vec2(0.0);
    float bend = length(warp * asp);                       // refraction strength
    float spread = u_dispersion * (bend * 9.0 + seam * 0.5);
    if (mode == 2) spread += u_dispersion * (0.5 + length(p) * 1.4);
    vec2 dispDir = bend > 1e-5 ? normalize(warp) : (dir / asp);
    // Per-facet refraction: each facet rotates/zooms its own slice of the image
    // around the facet center — true cut-gem optics, not just a parallel shift.
    vec2 baseUv;
    if (mode == 1 && u_facetRefract > 0.0) {
        float fr = (hash21(cid + 7.0) - 0.5) * 2.0;
        float fz = 1.0 + (hash21(cid + 9.0) - 0.5);
        vec2 rel = p - facetC;
        rel = rot2(fr * u_facetRefract * 1.4) * rel * mix(1.0, fz, u_facetRefract * 0.8);
        baseUv = (facetC + rel) / asp + center + warp;
    } else {
        baseUv = v_texCoord + warp;
    }
    // Spectral dispersion: integrate the image across the visible spectrum, each
    // wavelength refracted by a slightly different amount along the bend. Bright
    // edges fan into a continuous red->violet rainbow (a real prism), not a flat
    // cyan/magenta RGB split. Weight-normalised so spread=0 returns the image.
    const int NSPEC = 14;
    vec3 col = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < NSPEC; i++) {
        float t = (float(i) + 0.5) / float(NSPEC);          // 0 red .. 1 violet
        vec3 sw = spectral(t);
        vec2 off = dispDir * spread * (t - 0.5) * 2.0;
        col += texture(u_image0, clamp(baseUv + off, 0.0, 1.0)).rgb * sw;
        wsum += sw;
    }
    col /= max(wsum, vec3(1e-4));

    // ---- Per-facet flat shading: each crystal face catches the light ----
    if (mode == 1 && u_shading > 0.0) {
        vec2 nt = (hash22(cid + 2.0) - 0.5) * 1.5;     // random face tilt
        vec3 nrm = normalize(vec3(nt, 1.0));
        vec3 L = normalize(vec3(0.5, 0.55, 0.7));
        float diff = clamp(dot(nrm, L), 0.0, 1.0);
        float spec = pow(diff, 22.0);
        col *= mix(1.0, 0.55 + 0.8 * diff + 0.7 * spec, u_shading);
    }

    // ---- Edge glint, tinted toward the dispersion rainbow ----
    float hue = atan(p.y, p.x) / TAU + 0.5 + shim * 0.1;
    vec3 rainbow = 0.5 + 0.5 * cos(TAU * (hue + vec3(0.0, 0.33, 0.66)));
    vec3 tint = mix(vec3(1.0), rainbow, clamp(u_dispersion * 8.0, 0.0, 1.0));
    col += seam * u_glint * tint;

    fragColor0 = vec4(col, 1.0);
}
