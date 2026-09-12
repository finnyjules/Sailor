#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// LIQUID METAL: a pool of molten chrome in a shape. Flowing folds bend a reflected
// studio across the surface, a bevel runs round the edge catching its own line of
// light, and the picture beneath shows faintly in the reflection. A port of the
// Shaders.com "LiquidMetal" component (circle shape); its defaults are the
// "Fluid Chrome" design.
//
// A material coats whatever it is applied to. On a 3D surface, a Space Type / Shape fill,
// or the catalog preview it fills the ENTIRE tile; in the Frame the Frame hands over the
// layer's silhouette (u_shape: R the rim field, G the distance to the outline), so the pool
// and its bevel fill whatever shape the layer is.

uniform vec3  u_lightColor;      // the bright tone of the chrome
uniform vec3  u_darkColor;       // the tone the reflection falls to in shadow
uniform float u_turbulence;      // how molten: depth of the flowing folds
uniform float u_ripple;          // scale of the folds, higher = busier
uniform float u_warp;            // swirl: domain-warps the folds into curls
uniform float u_environment;     // strength of the reflected studio
uniform float u_envRotation;     // turns the reflected studio, degrees
uniform float u_sharpness;       // 1 = razor glints, 0 = soft satin
uniform float u_dispersion;      // colour fringing along the reflection edges
uniform float u_lightAngle;      // key light direction, degrees clockwise from the right
uniform float u_bevelWidth;      // width of the edge bevel, relative to the shape
uniform float u_bevelShape;      // 0 one round fillet, 1 machined: fillet, chamfer, knee
uniform float u_edgeSoftness;    // softness of the boundary

// Supplied by the Frame when the effect follows a layer's shape (see glass_lens).
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

const float PI = 3.14159265359;

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
    // Three octaves only: molten metal has broad folds, not grain.
    float s = 0.0, a = 0.55;
    for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 1.9 + 11.7; a *= 0.45; }
    return s;
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// The molten surface height at a point: folds, domain-warped into curls, drifting.
float surface(vec2 q, float t) {
    vec2 w = vec2(fbm(q * 0.6 + vec2(0.0, t * 0.35)), fbm(q * 0.6 + vec2(5.2, -t * 0.28)));
    q += (w - 0.5) * u_warp * 2.2;
    return fbm(q + vec2(t * 0.22, -t * 0.17));
}

// The reflected studio: a dark room with two softboxes and a horizon, looked up by
// the surface normal's tilt.
float studio(vec2 d) {
    vec2 r = rot2(radians(u_envRotation)) * d;
    // Two wide softboxes above and a floor glow below: a fold catches a white line
    // where its normal sweeps through a box, and falls to black between them.
    float box1 = smoothstep(0.55, 0.12, abs(r.y - 0.45)) * smoothstep(1.3, 0.2, abs(r.x + 0.2));
    float box2 = smoothstep(0.35, 0.05, abs(r.y + 0.5)) * smoothstep(1.4, 0.3, abs(r.x - 0.3)) * 0.7;
    float side = smoothstep(0.5, 0.15, abs(r.x - 0.9)) * smoothstep(0.9, 0.1, abs(r.y)) * 0.6;
    return clamp(box1 + box2 + side, 0.0, 1.5);
}

void main() {
    vec4 base = texture(u_image0, v_texCoord);
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;

    // ---- Where the pool is, and how far from its edge ----
    vec2 c, rel, outward;
    float cover, edgeD;            // edgeD: distance inward from the outline, 0 on the edge, 1 at the deepest point
    if (u_hasShape > 0.5) {
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        rel = p - c;
        vec4 sh = texture(u_shape, v_texCoord);
        // The outward direction comes from the RIM field (R): it is blurred at full
        // resolution, so its gradient is smooth along the edge, where the distance
        // field (G) is upscaled from a thumbnail and would stair-step the bevel.
        vec2 px = 1.5 / u_resolution;
        float gx = texture(u_shape, v_texCoord + vec2(px.x, 0.0)).r - texture(u_shape, v_texCoord - vec2(px.x, 0.0)).r;
        float gy = texture(u_shape, v_texCoord + vec2(0.0, px.y)).r - texture(u_shape, v_texCoord - vec2(0.0, px.y)).r;
        vec2 g = vec2(gx, gy) / asp;
        float gl = length(g);
        outward = gl > 1e-6 ? -g / gl : vec2(0.0, 1.0);
        // Paint solid: the compositor clips this fill to the layer's FULL-RES silhouette
        // (destination-in in applyGlassFromLayer), so that crisp clip IS the outline. A cover that
        // fades near the edge here renders at LIVE_FIELD_PX, upscales soft, and then multiplies the
        // crisp clip — softening the edge (see chrome). Let the clip cut it.
        cover = 1.0;
        edgeD = sh.g;                                   // the distance field, deepest point = 1
    } else {
        // As a MATERIAL with no silhouette handed over — a 3D surface, a Space Type / Shape
        // fill, or the catalog preview — the molten chrome coats the ENTIRE surface. A material
        // fills whatever it is applied to, so there is no stand-alone circle and no border
        // bevel (a bevel at the UV border would seam a sphere or a wrapped glyph). The mesh's
        // own edges are its outline: every texel is deep interior — full cover, edgeD = 1 (flat
        // top, the molten surface at full strength) — and the ripple is measured from the centre.
        c = 0.5 * asp;
        rel = p - c;
        outward = vec2(0.0, 1.0);
        cover = 1.0;
        edgeD = 1.0;
    }

    // ---- The bevel round the edge: a height profile over the bevel width ----
    float bw = max(u_bevelWidth, 0.005) * 2.0;           // bevel width in edgeD units
    float t = clamp(edgeD / bw, 0.0, 1.0);               // 0 at the edge, 1 where the flat top begins
    float round = sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));       // one smooth fillet
    float machined = smoothstep(0.0, 0.25, t) * 0.55 + smoothstep(0.35, 0.6, t) * 0.25 + smoothstep(0.75, 1.0, t) * 0.2;
    float prof = mix(round, machined, u_bevelShape);
    // Slope of the profile → how far the normal leans outward at the bevel.
    float dt = 0.02;
    float t2 = clamp(t + dt, 0.0, 1.0);
    float round2 = sqrt(max(1.0 - (1.0 - t2) * (1.0 - t2), 0.0));
    float machined2 = smoothstep(0.0, 0.25, t2) * 0.55 + smoothstep(0.35, 0.6, t2) * 0.25 + smoothstep(0.75, 1.0, t2) * 0.2;
    float slope = (mix(round2, machined2, u_bevelShape) - prof) / dt;   // 0 on the flat top
    float bevelLean = clamp(slope * 0.9, 0.0, 3.0) * (1.0 - step(1.0, t));

    // ---- The molten surface: normal from the height field ----
    float time = u_time * 0.5;
    vec2 q = rel * u_ripple * 0.65;
    float e = 0.012 * u_ripple;
    float h0 = surface(q, time);
    float hx = surface(q + vec2(e, 0.0), time);
    float hy = surface(q + vec2(0.0, e), time);
    vec2 grad = vec2(hx - h0, hy - h0) / e;
    float molten = u_turbulence * 1.1 * smoothstep(0.0, 0.35, t);     // the bevel stays smooth
    vec3 N = normalize(vec3(-grad * molten + outward * bevelLean, 1.0));

    // ---- Chrome: the studio reflected in the surface, the picture beneath faintly ----
    float sharp = mix(4.0, 48.0, u_sharpness);
    vec2 look = N.xy * 1.6;                                            // where the reflection looks
    float disp = u_dispersion * 0.12;
    vec3 env = vec3(studio(look * (1.0 + disp)), studio(look), studio(look * (1.0 - disp))) * u_environment;
    vec2 refl = v_texCoord + N.xy * 0.18 / asp;
    vec3 scene = vec3(texture(u_image0, clamp(refl + vec2(disp * 0.5, 0.0), 0.0, 1.0)).r,
                      texture(u_image0, clamp(refl, 0.0, 1.0)).g,
                      texture(u_image0, clamp(refl - vec2(disp * 0.5, 0.0), 0.0, 1.0)).b);
    float sceneLum = dot(scene, vec3(0.299, 0.587, 0.114));
    float shade = clamp(env.g * 0.85 + sceneLum * 0.35 * u_environment, 0.0, 1.0);
    shade = smoothstep(0.02, 0.9, shade);                              // chrome contrast
    vec3 col = mix(u_darkColor, u_lightColor, shade);
    col += (env - env.g) * 0.5 * u_lightColor;                         // the dispersion fringe
    // Key light: a specular glint on the folds and along the bevel.
    float la = radians(u_lightAngle);
    vec3 L = normalize(vec3(cos(la), -sin(la), 0.7));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float spec = pow(max(dot(N, H), 0.0), sharp);
    col += u_lightColor * spec * (0.6 + 0.6 * u_environment);
    // Fresnel-ish lift where the surface turns away.
    float rim = pow(1.0 - max(N.z, 0.0), 3.0);
    col += u_lightColor * rim * 0.25;

    fragColor0 = vec4(mix(base.rgb, clamp(col, 0.0, 1.0), cover), mix(base.a, 1.0, cover));
}
