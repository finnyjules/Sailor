#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// NEBULA: a volumetric gas nebula sealed inside polished glass. Billowing emission clouds with
// hot glowing cores and hollow dark cavities, star fields drifting at real depth behind the gas,
// all refracted through the curved glass walls and dressed with a studio reflection. A port of the
// Shaders.com "Nebula" component (the "Fluid Chrome" preview's current design). Sailor renders it
// clipped to the layer's silhouette (the glass shape), raymarching a virtual depth per pixel.
//
// A material coats whatever it is applied to; the Frame hands over the layer's silhouette
// (u_shape: R rim field, G distance to the outline) so the glass bevel and refraction follow the
// shape. With no silhouette it fills the tile as a round glass lens of nebula.

uniform vec3  u_coreColor;         // the hot colour the densest gas cores glow with
uniform vec3  u_gasColor;          // the main emission colour of the gas body (H-alpha rose)
uniform vec3  u_veilColor;         // thin outer veils + the deep-space background behind the gas
uniform float u_density;           // optical density: how strongly clouds occlude what is behind
uniform float u_cavity;            // how hollowed-out: high carves large dark voids
uniform float u_dust;              // cold dark dust lanes threading the gas (absorb-only, redden)
uniform float u_gasScale;          // feature size of the gas: higher = finer, busier detail
uniform float u_billow;            // turbulent folding: 0 smooth banks, 1 heavily churned billows
uniform float u_glow;              // hot emission bloom of the dense cores
uniform float u_gasSeed;           // pans the gas field for a new cloud composition
uniform float u_stars;             // brightness of the star fields at depth
uniform float u_starScale;         // density of the star fields (higher = smaller, busier)
uniform float u_twinkle;           // star twinkle intensity
uniform float u_refraction;        // how strongly the glass walls bend the interior near the edges
uniform float u_environment;       // strength of the studio softboxes reflected in the glass
uniform float u_highlight;         // sharp key-light glint on the glass
uniform float u_highlightSoftness; // specular softness: lower is a tighter glint
uniform float u_lightAngle;        // direction of the key light and studio, degrees
uniform float u_edgeSoftness;      // softness of the shape boundary
uniform float u_speed;             // churn/twinkle speed

// Supplied by the Frame when the effect follows a layer's shape.
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

const float PI = 3.14159265359;

// ---- Hash + 3D value noise (stand-in for the component's mxNoiseFloat3) ----
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0)), n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0)), n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0)), n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0)), n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z) * 2.0 - 1.0;
}

// The gas field at a point: domain-warped fbm folded by Billow (port of the component's `zze`).
// Returns density (signed-ish), plus the mid/fine octaves the shading reads for dust and grain.
void gasField(vec3 pos, float freq, float drift, float seed, float billow,
              out float density, out float mid, out float fine) {
    vec3 q = vec3(pos.x * freq, pos.y * freq * (-0.7), pos.z * freq * 1.25)
           + vec3(drift, drift * 0.53, drift * 0.79) + vec3(seed * 0.37, seed * 0.61, seed);
    vec3 warp = vec3(vnoise3(q * 0.5 + vec3(drift * 1.4, 0.0, drift * -0.9)));
    vec3 qw = q + vec3(warp.x, warp.x * -0.73, warp.x * 0.41) * billow;
    mid  = vnoise3(qw * 2.13 + vec3(5.2, 1.3, 8.4));
    fine = vnoise3(qw * 4.31 + vec3(9.1, 3.7, 1.2));
    density = (vnoise3(qw) + mid * 0.5 + fine * 0.27) * 0.57;
}

// Veil -> gas -> core colour ramp (RGB; the component blends in OKLab, approximated here).
vec3 nebulaRamp(float a, float b) {
    vec3 vg = mix(u_veilColor, u_gasColor, clamp(a, 0.0, 1.0));
    return mix(vg, u_coreColor, clamp(b, 0.0, 1.0));
}

// A drifting star field at one depth: bright points on a hashed grid, with a soft radius and a
// per-star twinkle (port of the component's `vO`, simplified). Returns premultiplied colour.
vec3 starField(vec2 uv, float freq, float twinkleRate, float gain, vec3 tintFrom, vec3 tintTo, float t) {
    vec2 g = uv * freq;
    vec2 cell = floor(g), f = fract(g);
    vec3 acc = vec3(0.0);
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 id = cell + o;
        float h = hash13(vec3(id, 3.0));
        if (h < 0.35) continue;                                  // only some cells hold a star
        vec2 pos = o + vec2(hash13(vec3(id, 1.0)), hash13(vec3(id, 2.0)));
        float d = length(f - pos);
        float r = mix(0.03, 0.09, hash13(vec3(id, 5.0)));
        float star = smoothstep(r, 0.0, d);
        float tw = 1.0 - u_twinkle * (0.5 + 0.5 * sin(t * twinkleRate + h * 40.0));
        float br = mix(0.3, 1.2, hash13(vec3(id, 7.0))) * tw;
        vec3 tint = mix(tintFrom, tintTo, hash13(vec3(id, 9.0)));
        acc += tint * star * br;
    }
    return acc * gain * 9.0;
}

// The reflected studio: a couple of soft softboxes looked up by the glass reflection direction.
float studio(vec2 d, float angle) {
    float c = cos(angle), s = sin(angle);
    vec2 r = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
    float box1 = smoothstep(0.6, 0.12, abs(r.y - 0.4)) * smoothstep(1.3, 0.2, abs(r.x + 0.2));
    float box2 = smoothstep(0.4, 0.08, abs(r.y + 0.5)) * smoothstep(1.2, 0.3, abs(r.x - 0.3)) * 0.6;
    return clamp(box1 + box2, 0.0, 1.4);
}

vec3 tonemap(vec3 c) { return vec3(1.0) - exp(-c); }

void main() {
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;

    // ---- Shape: coverage, distance field, and the outward (glass-wall) normal ----
    vec2 c, rel, outward;
    float cover, edgeD;
    if (u_hasShape > 0.5) {
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        rel = p - c;
        vec4 sh = texture(u_shape, v_texCoord);
        vec2 px = 1.5 / u_resolution;
        float gx = texture(u_shape, v_texCoord + vec2(px.x, 0.0)).r - texture(u_shape, v_texCoord - vec2(px.x, 0.0)).r;
        float gy = texture(u_shape, v_texCoord + vec2(0.0, px.y)).r - texture(u_shape, v_texCoord - vec2(0.0, px.y)).r;
        vec2 g = vec2(gx, gy) / asp;
        float gl = length(g);
        outward = gl > 1e-6 ? -g / gl : vec2(0.0, 1.0);
        // Blur the distance field (a 256px thumbnail upscaled) so the glass terms that key off it
        // do not band into contour streaks near the wall.
        vec2 e0 = 6.0 / u_resolution;
        edgeD = (texture(u_shape, v_texCoord).g * 2.0
               + texture(u_shape, v_texCoord + vec2(e0.x, 0.0)).g + texture(u_shape, v_texCoord - vec2(e0.x, 0.0)).g
               + texture(u_shape, v_texCoord + vec2(0.0, e0.y)).g + texture(u_shape, v_texCoord - vec2(0.0, e0.y)).g
               + texture(u_shape, v_texCoord + e0).g + texture(u_shape, v_texCoord - e0).g) / 8.0;
        cover = 1.0;                          // the compositor clips to the crisp silhouette
    } else {
        c = 0.5 * asp;
        rel = p - c;
        float r = length(rel) / max(u_shapeSize, 0.42);
        outward = length(rel) > 1e-5 ? normalize(rel) : vec2(0.0, 1.0);
        edgeD = clamp(1.0 - r, 0.0, 1.0);
        cover = 1.0 - smoothstep(0.99, 1.0, r);
    }
    float unit = u_hasShape > 0.5 ? max(u_shapeSize, 0.05) : 0.42;
    vec2 relN = rel / unit;                    // shape-normalised, ~[-1,1] across the shape

    float time = u_time * u_speed;
    float drift = time * 0.14;

    // ---- Refraction: bend the interior sample toward the glass walls near the edge ----
    float wall = smoothstep(0.0, 0.14, edgeD) * (1.0 - smoothstep(0.14, 0.6, edgeD)); // 0 at wall, peak just inside
    // Gentle refraction: a small, smoothly-falling displacement toward the wall. Kept small
    // with a wide falloff so its screen-space gradient stays low and the gas does not alias.
    vec2 bent = relN + outward * (u_refraction * 0.14 * smoothstep(0.45, 0.0, edgeD));

    // ---- Volumetric raymarch of the gas (6 steps front-to-back) ----
    const int STEPS = 6;
    float freq = u_gasScale * 6.0;
    float macro = vnoise3(vec3(bent * 1.3, drift * 0.6 + u_gasSeed * 0.37)) * 0.45;
    float cav = mix(-0.35, 0.5, u_cavity);
    vec3 emission = vec3(0.0);
    float transmit = 1.0;
    for (int s = 0; s < STEPS; s++) {
        float t = (float(s) + 0.5) / float(STEPS);           // 0 (front) .. 1 (back)
        float z = t * 2.0 + u_gasSeed * 7.31;                   // depth into the volume
        float density, mid, fine;
        gasField(vec3(bent, z), freq, drift, u_gasSeed * 7.31, u_billow * 0.9, density, mid, fine);
        float endFade = smoothstep(0.0, 0.11, min(t, 1.0 - t));       // fade the volume's front/back
        float grain = 1.0 - clamp(abs(fine) * 1.6, 0.0, 1.0);
        float dens = smoothstep(0.12, 0.62, density + macro - cav) * endFade * (0.55 + grain * 0.8);
        float dust = smoothstep(0.45, 0.75, mid) * endFade * u_dust;
        vec3 col = nebulaRamp(smoothstep(0.05, 0.75, dens), smoothstep(0.68, 1.0, dens));
        float be = 1.0 - t * 0.45;                            // depth darkening
        float veilTerm = smoothstep(-0.7, 0.3, density) * 0.05 * endFade;
        vec3 emit = col * (dens * be * 1.3)
                  + u_coreColor * (pow(dens, 2.4) * (0.5 + u_glow * 1.3) * be)
                  + u_veilColor * (veilTerm * be);
        float aGain = (0.5 + t * 2.2) * u_density * 0.5;
        vec3 absorb = vec3(dens * aGain) + vec3(1.5, 1.0, 0.55) * (dust * aGain * 2.2);
        float eGain = (0.3 + t * 0.9) * 1.0;
        emission += emit * eGain * transmit;
        transmit *= exp(-(absorb.r + absorb.g + absorb.b) * 0.5);
    }

    // ---- Star fields at two depths, drifting and twinkling behind/through the gas ----
    float sf = u_starScale * 34.0;
    vec3 farStars  = starField(bent * 0.9 + vec2(drift * 0.3, 0.0), sf,       1.7, u_stars, vec3(0.72, 0.82, 1.0), vec3(1.0, 0.92, 0.82), time);
    vec3 nearStars = starField(bent * 1.4 + vec2(-drift * 0.2, 0.1), sf * 0.56, 2.3, u_stars, vec3(0.75, 0.85, 1.0), vec3(1.0, 0.95, 0.88), time);

    // ---- Glass surface: reflected studio + a key-light glint on the bevel ----
    float la = radians(u_lightAngle);
    vec2 rdir = reflect(normalize(vec3(relN * 0.5, 1.0)), normalize(vec3(outward * (1.0 - edgeD), 0.3))).xy;
    float env = studio(rdir * 1.6, la) * u_environment * smoothstep(0.02, 0.18, edgeD);
    float ndh = clamp(dot(outward, vec2(cos(la), -sin(la))) * (1.0 - edgeD) + edgeD * 0.3, 0.0, 1.0);
    float glint = (pow(ndh, mix(140.0, 20.0, u_highlightSoftness)) * 1.3
                 + pow(ndh, 22.0) * 0.14) * u_highlight;

    // ---- Composite: veil bg, gas volume, stars behind the gas, then glass reflections ----
    vec3 col = u_veilColor * 0.025 * transmit;                // deep-space veil behind everything
    col += emission;                                          // the gas
    float interior = smoothstep(0.0, 0.08, edgeD);
    col += farStars * transmit * interior;
    col += nearStars * mix(transmit, 1.0, 0.35) * interior;
    col += vec3(0.85, 0.92, 1.08) * env * 0.38;               // studio reflection
    col += vec3(1.0, 0.98, 0.95) * glint;                     // key glint
    col = tonemap(col);

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0) * cover;
}
