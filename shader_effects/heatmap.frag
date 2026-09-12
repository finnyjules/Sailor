#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// HEATMAP: thermal-camera heat flowing through a shape. Heat gathers inside the
// silhouette (Inner glow), radiates just past its edge (Outer glow) and concentrates
// along the outline (Contour); cool waves travel across it in the Angle direction, and
// the whole field is read through a colour ramp interpolated in OKLab. A port of the
// Shaders.com "Heatmap" component (Paper Shaders); its default is a centred disc.
//
// A material dresses whatever it is applied to. With no silhouette handed over — a 3D
// surface, a Space Type / Shape fill, the catalog preview — the heat maps over a centred
// disc that fills the tile and radiates onto transparency. In the Frame the layer hands
// over its silhouette (u_shape: R the rim field, G the depth inward), so the heat flows
// through the layer's own shape. The compositor clips the result to the crisp full-res
// silhouette, so the outer glow reads as an edge bloom on a Frame and radiates fully only
// on the no-shape tile (there is no "outside" to glow into once clipped).

#define MAXS 8
uniform vec3  u_ramp[MAXS];       // the heat colour ramp, cold -> hot
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
uniform float u_innerGlow;        // heat filling the inside of the shape
uniform float u_outerGlow;        // heat radiating beyond the silhouette
uniform float u_contour;          // heat concentrated along the outline
uniform float u_angle;            // direction the heat waves travel, degrees
uniform float u_scale;            // size of the heat field, 1 = default
uniform float u_edgeSoftness;     // softness of the boundary

// Supplied by the Frame when the effect follows a layer's shape (see glass_lens).
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

// ---- noise (the source's 2D noise, `G7e`): value noise ----
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---- OKLab, so the heat ramp interpolates the way the source does (colorSpace: oklab) ----
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 linearToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    l = pow(l, 1.0 / 3.0); m = pow(m, 1.0 / 3.0); s = pow(s, 1.0 / 3.0);
    return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLinear(vec3 lab) {
    float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

// The heat scalar (0 cold -> 1 hot) read through the ramp, interpolated in OKLab.
vec3 heatRamp(float t) {
    int n = max(1, int(u_rampCount + 0.5));
    t = clamp(t, 0.0, 1.0);
    if (t <= u_rampPos[0]) return linearToSrgb(oklabToLinear(linearToOklab(srgbToLinear(u_ramp[0]))));
    for (int i = 0; i < MAXS - 1; i++) {
        if (i + 1 >= n) break;
        float p0 = u_rampPos[i], p1 = u_rampPos[i + 1];
        if (t >= p0 && t <= p1) {
            float f = p1 > p0 ? (t - p0) / (p1 - p0) : 0.0;
            vec3 l0 = linearToOklab(srgbToLinear(u_ramp[i]));
            vec3 l1 = linearToOklab(srgbToLinear(u_ramp[i + 1]));
            return linearToSrgb(oklabToLinear(mix(l0, l1, f)));
        }
    }
    return linearToSrgb(oklabToLinear(linearToOklab(srgbToLinear(u_ramp[clamp(n - 1, 0, MAXS - 1)]))));
}

// Sw: a soft Gaussian heat band whose centre sweeps across the travel direction as its
// phase runs 0 -> 1, its edge wobbled by noise, fading in and out over its life. Three
// staggered layers carve the cool streaks that flow through the hot interior.
float wave(float along, float across, float s, float layer) {
    float o = mix(-0.6, 0.6, s);
    float n = vnoise(vec2(across * 4.0 + layer * 13.7, s * 3.0 + layer * 7.1)) - 0.5;
    float a = (along - o) + n * 0.12;
    return clamp(exp(-a * a / 0.0256) * (smoothstep(0.0, 0.15, s) * (1.0 - smoothstep(0.85, 1.0, s))), 0.0, 1.0);
}

void main() {
    vec4 base = texture(u_image0, v_texCoord);
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;

    float sc = max(u_scale, 0.05);
    float soft = max(u_edgeSoftness, 0.001);

    // ---- The signed distance field the heat is measured from ----
    // i < 0 inside, ~0 at the outline, > 0 outside. `inside` is a soft 0..1 mask.
    vec2 c, rel;
    float i, inside;
    if (u_hasShape > 0.5) {
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        rel = p - c;
        // G (the chamfer field) is 0 at the outline and rises to 1 at the deepest point.
        // There is no true outside distance once the compositor clips to the silhouette,
        // so i only goes negative (inward); the outer glow becomes an inner edge bloom.
        float depth = texture(u_shape, v_texCoord).g;
        i = -depth / sc;
        inside = smoothstep(0.0, soft, depth);
    } else {
        c = 0.5 * asp;
        rel = p - c;
        i = (length(rel) - 0.35) / sc;              // the source default: a disc, radius 0.35
        inside = 1.0 - smoothstep(-soft, soft, i);
    }

    // ---- Where the heat waves travel ----
    float ang = radians(u_angle);
    vec2 tangent = vec2(cos(ang), sin(ang));
    vec2 perp = vec2(-sin(ang), cos(ang));
    float along = dot(rel, tangent);
    float across = -dot(rel, perp);

    float time = u_time;                            // fill.shader.speed already scales the clock
    float m = 0.1 * time - 0.3;

    // ---- Inner heat: edge-weighted fill, cool waves carved through it, a contour band ----
    float depthIn = max(-i, 0.0);
    float inner = 0.8 + 0.8 * exp(-depthIn / 0.12);
    inner = mix(inner, 0.0, wave(along, across, fract(m),             1.0));
    inner = mix(inner, 0.0, wave(along, across, fract(m + 1.0 / 3.0), 2.0));
    inner = mix(inner, 0.0, wave(along, across, fract(m + 2.0 / 3.0), 3.0));
    inner *= 2.0 * u_innerGlow;
    inner += (u_contour * 2.0) * exp(-abs(i) / 0.03);
    inner = min(inner, 1.0) * inside;
    inner = pow(max(inner, 0.0), 1.2);

    // ---- Outer heat: a travelling glow radiating past the edge ----
    float outAmt = 0.05 + 0.15 * u_outerGlow;
    float v = exp(-max(i, 0.0) / outAmt);
    float g = fract(3.0 * m - 0.1);
    float bb = fract(1.2 * along - g);
    float y = 0.5 + smoothstep(0.3, 0.65, bb) * (1.0 - smoothstep(0.65, 1.0, bb));
    float outer = 0.9 * pow(v, 0.8) * y * 5.0 * u_outerGlow * u_outerGlow * (1.0 - inside);

    float heat = clamp(inner + outer, 0.0, 1.0);
    heat += 0.005 * (hash21(rel * vec2(991.3, 787.7)) - 0.5);   // tiny dither breaks the banding
    heat = clamp(heat, 0.0, 1.0);

    float alpha = clamp(inside + outer, 0.0, 1.0);
    vec3 col = heatRamp(heat);

    fragColor0 = vec4(mix(base.rgb, col, alpha), max(base.a, alpha));
}
