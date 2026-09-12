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
vec3 grad3(vec3 p) {
    return normalize(vec3(hash13(p + 11.0), hash13(p + 47.0), hash13(p + 83.0)) * 2.0 - 1.0);
}
// 3D gradient (Perlin-style) noise, in [-1,1] — the natural flowing structure the component's
// MaterialX noise gives, in place of the earlier blobby value noise.
float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = dot(grad3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
    float n100 = dot(grad3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
    float n010 = dot(grad3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
    float n110 = dot(grad3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
    float n001 = dot(grad3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
    float n101 = dot(grad3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
    float n011 = dot(grad3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
    float n111 = dot(grad3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 1.6;
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

// sRGB <-> linear, and linear-RGB <-> OKLab (the exact matrices the component blends in). The
// veil -> gas -> core ramp is mixed in OKLab so the midtones stay vivid instead of muddying.
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 linearToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    float l_ = pow(max(l, 0.0), 1.0 / 3.0), m_ = pow(max(m, 0.0), 1.0 / 3.0), s_ = pow(max(s, 0.0), 1.0 / 3.0);
    return vec3(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
                1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
                0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
vec3 oklabToLinear(vec3 lab) {
    float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
// veil -> gas -> core, blended in OKLab, returned as LINEAR rgb.
vec3 nebulaRamp(vec3 oklVeil, vec3 oklGas, vec3 oklCore, float a, float b) {
    vec3 lab = mix(mix(oklVeil, oklGas, clamp(a, 0.0, 1.0)), oklCore, clamp(b, 0.0, 1.0));
    return max(oklabToLinear(lab), 0.0);
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

    // The three nebula colours are sRGB; work in linear, and pre-convert to OKLab for the ramp.
    vec3 veilLin = srgbToLinear(u_veilColor), gasLin = srgbToLinear(u_gasColor), coreLin = srgbToLinear(u_coreColor);
    vec3 oklVeil = linearToOklab(veilLin), oklGas = linearToOklab(gasLin), oklCore = linearToOklab(coreLin);

    // ---- Smooth glass shell normal (computed up here so it can REFRACT the interior) ----
    // Heavily blur the distance field so the glass normal is smooth (no faceted rings), read as a
    // sphere: flat at the centre, curving steeply only near the rim.
    float gd = 0.0;
    {
        vec2 gr1 = 7.0 / u_resolution, gr2 = 14.0 / u_resolution;
        gd = texture(u_shape, v_texCoord).g * 3.0;
        gd += (texture(u_shape, v_texCoord + vec2(gr1.x, 0.0)).g + texture(u_shape, v_texCoord - vec2(gr1.x, 0.0)).g
             + texture(u_shape, v_texCoord + vec2(0.0, gr1.y)).g + texture(u_shape, v_texCoord - vec2(0.0, gr1.y)).g
             + texture(u_shape, v_texCoord + gr1).g + texture(u_shape, v_texCoord - gr1).g
             + texture(u_shape, v_texCoord + vec2(gr1.x, -gr1.y)).g + texture(u_shape, v_texCoord + vec2(-gr1.x, gr1.y)).g) * 2.0;
        gd += texture(u_shape, v_texCoord + vec2(gr2.x, 0.0)).g + texture(u_shape, v_texCoord - vec2(gr2.x, 0.0)).g
            + texture(u_shape, v_texCoord + vec2(0.0, gr2.y)).g + texture(u_shape, v_texCoord - vec2(0.0, gr2.y)).g
            + texture(u_shape, v_texCoord + gr2).g + texture(u_shape, v_texCoord - gr2).g
            + texture(u_shape, v_texCoord + vec2(gr2.x, -gr2.y)).g + texture(u_shape, v_texCoord + vec2(-gr2.x, gr2.y)).g;
        gd = u_hasShape > 0.5 ? gd / 27.0 : edgeD;
    }
    float la = radians(u_lightAngle);
    float rr = clamp(1.0 - gd, 0.0, 1.0);                     // 0 at the centre, 1 at the rim
    float theta = pow(rr, 2.6) * 1.5;                         // flat centre, steep only at the rim
    vec3 Ng = normalize(vec3(outward * sin(theta), cos(theta)));

    // ---- Refraction: the curved glass walls BEND the interior. Pull the sampled point inward
    // toward the centre near the rim — a lens that magnifies the nebula behind the glass wall. The
    // displacement uses a smoothstep falloff that is FLAT at both ends (max at the rim, zero at the
    // centre), so its gradient never spikes and the magnified gas does not alias. ----
    float refr = u_refraction * 0.45 * (1.0 - smoothstep(0.0, 1.0, gd));
    vec2 bent = relN - outward * refr;

    // ---- Volumetric raymarch of the gas (6 steps front-to-back) ----
    const int STEPS = 6;
    // Coarsen the gas where the glass magnifies it (near the rim): less high frequency to
    // undersample, so the refracted gas reads soft rather than aliasing into moire.
    float freq = u_gasScale * 6.0 * (1.0 - clamp(refr * 1.6, 0.0, 0.62));
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
        float dens = smoothstep(0.40, 0.90, density + macro - cav) * endFade * (0.55 + grain * 0.8);
        float dust = smoothstep(0.45, 0.75, mid) * endFade * u_dust;
        vec3 col = nebulaRamp(oklVeil, oklGas, oklCore, smoothstep(0.05, 0.75, dens), smoothstep(0.68, 1.0, dens));
        float be = 1.0 - t * 0.45;                            // depth darkening
        float veilTerm = smoothstep(-0.7, 0.3, density) * 0.05 * endFade;
        vec3 emit = col * (dens * be * 0.85)
                  + coreLin * (pow(dens, 2.4) * (0.5 + u_glow * 1.3) * be)
                  + veilLin * (veilTerm * be);
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

    // ---- Glass surface shading (the shell normal Ng was computed up top for the refraction) ----
    float fres = pow(1.0 - clamp(Ng.z, 0.0, 1.0), 3.0);      // grazing → the bright glass rim
    vec3 Rg = reflect(vec3(0.0, 0.0, -1.0), Ng);             // reflection direction off the glass
    float envG = studio(Rg.xy * 1.5, la);                    // soft studio reflection
    vec2 lightv = vec2(cos(la), -sin(la));
    float ndh = clamp(dot(Ng.xy, lightv) + Ng.z * 0.15, 0.0, 1.0);
    float glint = pow(ndh, mix(240.0, 30.0, u_highlightSoftness)) * u_highlight;

    // ---- Composite: veil bg, gas volume, stars, then the glass shell on top ----
    vec3 col = veilLin * 0.03 * transmit;                     // deep-space veil behind everything
    col += emission;                                          // the gas
    float interior = smoothstep(0.0, 0.08, edgeD);
    col += farStars * transmit * interior;
    col += nearStars * mix(transmit, 1.0, 0.35) * interior;
    col *= 1.0 - fres * 0.55;                                 // at the rim the glass turns reflective
    col += vec3(0.72, 0.80, 1.0) * fres * (0.25 + 0.35 * u_environment);   // bright Fresnel rim
    col += vec3(0.85, 0.92, 1.08) * envG * u_environment * 0.5;            // soft studio reflection
    col += vec3(1.0, 0.98, 0.95) * glint;                                  // sharp key glint
    col = linearToSrgb(tonemap(col));

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0) * cover;
}
