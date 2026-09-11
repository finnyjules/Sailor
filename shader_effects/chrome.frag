#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// CHROME: a precision-machined mirror-metal shape with a photographic studio reflected in
// it — one big frontal softbox, black side flags, and thin warm/cool strip lights that fringe
// the reflections amber above the horizon and ice-blue below. A polished bevel runs round the
// edge, the faces dome gently, and a slow orbit slides the whole studio across the surface.
// A port of the Shaders.com "Chrome" component (the "Fluid Chrome" design's values).
//
// A material coats whatever it is applied to. In the Frame the Frame hands over the layer's
// silhouette (u_shape: R the rim field, G the distance to the outline), so the bevel and dome
// follow the shape. Elsewhere — a 3D surface, a Space Type / Shape fill, the catalog preview —
// there is no silhouette, so it fills the whole tile as a domed chrome sheet (no edge bevel:
// a UV-border bevel would seam a sphere or a wrapped glyph).

uniform vec3  u_tint;            // metal tint multiplied into the reflection (white = silver)
uniform vec3  u_warmColor;       // the warm strip light hugging the studio horizon
uniform vec3  u_coolColor;       // the cool wash below the horizon
uniform float u_bevelWidth;      // width of the polished edge bevel, relative to the shape
uniform float u_bevelShape;      // 0 one round fillet, 1 machined: fillet, chamfer, knee
uniform float u_curvature;       // convex doming of the faces
uniform float u_waviness;        // pressed-metal imperfection: bends reflections, wobbles edges
uniform float u_environment;     // exposure of the reflected studio
uniform float u_envRotation;     // rotates the whole reflected studio, degrees
uniform float u_softness;        // 0 razor polished, 1 satin diffusion
uniform float u_spectral;        // strength of the amber + ice-blue accent lights
uniform float u_dispersion;      // prismatic RGB fringing along the fast-curving bevel
uniform float u_shadows;         // depth of the dark studio reflections
uniform float u_speed;           // speed of the studio orbit
uniform float u_edgeSoftness;    // softness of the shape boundary

// Supplied by the Frame when the effect follows a layer's shape (see glass_lens/liquid_metal).
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

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

// The bevel light profile, driven by t (0 at the outline, 1 where the flat face begins).
// shape 0 = one smooth round fillet (1 - t); shape 1 = machined: a steep outer fillet, a
// chamfer plateau, then an inner knee. A faithful port of the component's `bevelSin`.
float bevelSin(float t, float shape) {
    float round = 1.0 - t;
    float o = smoothstep(0.0, 0.14, t);
    float n = smoothstep(0.68, 0.92, t);
    float machined = mix(1.0, 0.72 * (1.0 - n), o);
    return mix(round, machined, shape);
}

// The silhouette's distance field (G channel), heavily blurred to erase the 128px thumbnail's
// facets. The distance field is low-frequency, so a wide two-ring 21-tap blur is safe and makes
// the dome and bevel read as one smooth pillow instead of a bilinear-upscaled terrace.
float dfield(vec2 uv) {
    vec2 r = 11.0 / u_resolution;
    vec2 d = r * 0.70711;                         // diagonal taps at the same radius
    float s = texture(u_shape, uv).g * 2.0;
    s += texture(u_shape, uv + vec2(r.x, 0.0)).g + texture(u_shape, uv - vec2(r.x, 0.0)).g
       + texture(u_shape, uv + vec2(0.0, r.y)).g + texture(u_shape, uv - vec2(0.0, r.y)).g
       + texture(u_shape, uv + d).g + texture(u_shape, uv - d).g
       + texture(u_shape, uv + vec2(d.x, -d.y)).g + texture(u_shape, uv + vec2(-d.x, d.y)).g;
    return s / 10.0;
}

// The surface HEIGHT as a function of distance-from-edge d (0 at the outline, 1 deepest). A
// convex dome: rises from the edge and levels at the interior. The normal comes from this
// height's SCREEN-space gradient (below), which stays smooth across the shape's medial axis —
// where the raw distance-field gradient flips and would crease the surface into a fan.
float domeH(float d) {
    d = clamp(d, 0.0, 1.0);
    return 1.0 - (1.0 - d) * (1.0 - d);          // parabolic dome: monotonic slope, smooth reflection
}

// The reflected studio, looked up by a reflection direction d (a unit-ish vec3). A dark
// graphite room, a bright frontal softbox, a warm strip light at the softbox edge, a cool wash
// below the horizon, a floor bounce and a lower cool card. A faithful port of the component's
// `Aw` environment. softEff/soft = edge softness, spectral = accent-light strength,
// shadows = how hard the darks crush, warmC/coolC = the two accent colours.
vec3 studio(vec3 d, float softEff, float soft, float spectral, float shadows, vec3 warmC, vec3 coolC) {
    float ex = d.x, ey = d.y, ez = d.z;
    float horiz = ex / (length(vec2(ex, ey)) + 1e-4);
    float warmSide = 0.35 + 0.65 * smoothstep(-0.7, 0.7, horiz);
    float coolSide = 0.45 + 0.55 * smoothstep(-0.7, 0.7, -horiz);
    float up = smoothstep(-0.65, 1.0, ey);

    vec3 g = coolC * 0.03 + vec3(0.003, 0.003, 0.004);
    vec3 b = mix(mix(vec3(0.17, 0.175, 0.19), g, clamp(shadows, 0.0, 1.0)),
                 vec3(0.56, 0.57, 0.6), clamp(up * up, 0.0, 1.0));
    b += vec3(0.55, 0.55, 0.56) * smoothstep(0.3, 0.9, ey);

    // Cool wash hugging just below the horizon band.
    float cd = (ey + 0.45) / 0.2;
    b += coolC * (exp(-(cd * cd)) * spectral * 0.2) * coolSide;

    // The frontal softbox, seen only by faces reflecting toward the viewer (ez negative).
    float facing = 1.0 - smoothstep(-0.1, 0.18, ez);
    float pz = max(0.32 - ez, 0.06);
    float px = ex / pz, py = ey / pz;
    float boxC = abs(px) - 0.62;
    float boxK = abs(py - 0.3) - 0.28;
    float U = length(max(vec2(boxC, boxK), vec2(0.0))) + min(max(boxC, boxK), 0.0);
    float boxSoft = 0.05 + soft * 0.4;
    float box = (1.0 - smoothstep(boxSoft * -0.6, boxSoft, U)) * facing;
    b += vec3(2.9, 2.87, 2.82) * box;

    // Side vignette: darken toward the left/right edges of the reflection.
    float vig = smoothstep(0.5, 0.92, abs(ex));
    b *= mix(vec3(1.0), vec3(mix(0.55, 0.07, shadows)), vig);

    // The warm strip light hugging the softbox edge (an amber fringe).
    float gw = 0.065 + softEff * 0.05;
    float jd = max(U, 0.0);
    float strip = exp(-((jd / gw) * (jd / gw))) * smoothstep(-0.06, 0.1, U);
    b += warmC * (strip * spectral * 1.3) * warmSide * facing;

    // A warm floor bounce along the bottom horizon.
    float fb = (ey + 0.12) / 0.05;
    b += warmC * (exp(-(fb * fb)) * spectral * 0.5) * warmSide * (1.0 - facing);

    // A dim cool card below.
    float cardX = abs(px) - 0.7;
    float cardY = abs(py + 0.78) - 0.05;
    float dCard = length(max(vec2(cardX, cardY), vec2(0.0))) + min(max(cardX, cardY), 0.0);
    float card = (1.0 - smoothstep(boxSoft * -0.6, boxSoft, dCard)) * facing;
    b += vec3(0.5, 0.5, 0.52) * card;

    return b;
}

void main() {
    vec4 base = texture(u_image0, v_texCoord);
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;

    // ---- Where the shape is, how far from its edge, and the outward edge direction ----
    vec2 c, rel, outward;
    vec2 domeGrad = vec2(0.0);    // screen-space gradient of the height field (the dome)
    float cover, edgeD;            // edgeD: 0 on the outline, 1 at the deepest interior point
    if (u_hasShape > 0.5) {
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        rel = p - c;
        // edgeD from the BLURRED distance field (dfield erases the thumbnail's steps). Four
        // neighbour samples serve BOTH the outward direction (raw distance gradient) and the dome
        // (gradient of the height field domeH) — one set of taps, so the shape branch is 5 dfield
        // reads, not nine.
        edgeD = dfield(v_texCoord);
        vec2 e0 = 16.0 / u_resolution;
        float dpx = dfield(v_texCoord + vec2(e0.x, 0.0));
        float dnx = dfield(v_texCoord - vec2(e0.x, 0.0));
        float dpy = dfield(v_texCoord + vec2(0.0, e0.y));
        float dny = dfield(v_texCoord - vec2(0.0, e0.y));
        vec2 grd = vec2(dpx - dnx, dpy - dny) / asp;
        float gl = length(grd);
        outward = gl > 1e-6 ? -grd / gl : vec2(0.0, 1.0);    // toward the nearest edge
        domeGrad = vec2(domeH(dpx) - domeH(dnx), domeH(dpy) - domeH(dny)) / asp;
        cover = smoothstep(0.0, 0.02 + u_edgeSoftness * 0.08, texture(u_shape, v_texCoord).g);
    } else {
        // As a material with no silhouette handed over — a 3D surface, a Space Type / Shape fill,
        // or the catalog preview — the chrome coats the whole tile: full cover, deep interior
        // (edgeD = 1, so no edge bevel), the dome measured radially from the tile centre.
        c = 0.5 * asp;
        rel = p - c;
        outward = length(rel) > 1e-5 ? normalize(rel) : vec2(0.0, 1.0);
        cover = 1.0;
        edgeD = 1.0;
    }
    // Everything below is measured in SHAPE-NORMALISED coordinates: `rel` divided by the
    // shape's own half-extent (u_shapeSize in the Frame, half the short side otherwise), so
    // relN spans about [-1, 1] across the shape at ANY size. A small chip and a frame-filling
    // clover then dome and reflect identically — measuring in absolute frame units made a large
    // shape over-tilt into a flat top-to-bottom gradient, the "just cut, not applied" look.
    float unit = u_hasShape > 0.5 ? max(u_shapeSize, 0.05) : 0.5;
    vec2 relN = rel / unit;
    float flenN = length(relN);
    vec2 rdir = flenN > 1e-5 ? relN / flenN : vec2(0.0, 1.0);

    // ---- The polished bevel + convex dome, both inflated from the distance field ----
    // The bevel is a machined rim profile over the outer edgeD band; the dome puffs the whole
    // face from every edge and lies flat at the deepest interior (where it faces the viewer and
    // catches the softbox). Both lean along `outward` (the smoothed distance-field gradient), so
    // the surface reads as one pillow that follows the shape. No waviness on the rim line and no
    // fade onto the face — those flattened and scraggled the earlier version.
    float bw = max(u_bevelWidth, 0.005) * 3.0;           // bevel width in edgeD units
    float t0 = clamp(edgeD / bw, 0.0, 1.0);              // 0 at the outline, 1 at the flat face
    float sBev = bevelSin(t0, u_bevelShape);             // the machined rim profile, 0 past the bevel

    vec2 txy;
    if (u_hasShape > 0.5) {
        // The dome is the SCREEN-space gradient of the height field domeH(distance): it puffs the
        // whole shape and follows the outline (cleft and lobes), yet stays smooth across the
        // medial axis — where domeH is a rounded ridge, so its gradient tapers to zero instead of
        // flipping like the raw distance gradient (that flip was the fan-crease).
        vec2 domeXY = -domeGrad * (u_curvature * 2.6);
        // The bevel rim leans outward on top of the dome.
        txy = domeXY + outward * (sBev * 0.6);
    } else {
        // Bare material (no silhouette): a radial dome sweeps the studio across the flat tile.
        float sSphere = u_curvature * 0.75 * smoothstep(0.0, 2.3, flenN);
        txy = rdir * sSphere;
    }
    float tl = min(length(txy), 0.9995);
    vec2 tn = length(txy) > 1e-4 ? txy * (tl / length(txy)) : vec2(0.0);
    float nz = sqrt(max(1.0 - tl * tl, 0.0));
    // The normal points AWAY from the eye (−z): the studio sits on the far side and is seen by
    // reflection, so a flat face pointing at the viewer catches the big frontal softbox.
    vec3 N = vec3(tn, -nz);

    // ---- Waviness: a broad, slowly drifting tilt so the surface reads as pressed metal ----
    float time = u_time * u_speed;
    vec2 wg = vec2(vnoise(relN * 0.23 + vec2(time * 0.08, 3.1)) - 0.5,
                   vnoise(relN * 0.23 + vec2(-1.7, time * 0.08 + 8.4)) - 0.5);
    N = normalize(N + vec3(wg, 0.0) * u_waviness * 0.6);

    // ---- Reflect a slightly perspective view ray, then orbit the studio around ----
    // The perspective is in shape units (relN) so the reflection sweep is the same across sizes.
    vec3 T = normalize(vec3(relN * 0.12, 1.0));          // view ray toward the eye, mild perspective
    vec3 R = reflect(T, N);
    float fres = clamp(abs(dot(N, T)), 0.0, 1.0);

    float rotA = radians(u_envRotation) + sin(time * 0.23) * 0.05;
    float ec = cos(rotA), es = sin(rotA);
    float upY = -R.y;
    float rx0 = R.x * ec - upY * es;
    float ry0 = R.x * es + upY * ec;
    float orbit = sin(time * 0.5) * 0.4 + sin(time * 0.19 + 1.7) * 0.2;
    float oc = cos(orbit), os = sin(orbit);
    float rx = rx0 * oc + R.z * os;
    float rz0 = R.z * oc - rx0 * os;
    float nod = sin(time * 0.31 + 0.9) * 0.12;
    float nc = cos(nod), ns = sin(nod);
    float ry = ry0 * nc - rz0 * ns;
    float rz = rz0 * nc + ry0 * ns;
    vec3 dir = vec3(rx, ry, rz);

    float grazing = smoothstep(0.75, 1.0, 1.0 - abs(N.z));   // high at the rim, where |N.z| is small
    float softEff = u_softness + grazing * 0.2;

    // ---- Studio reflection, with prismatic dispersion on the fast-curving bevel ----
    vec3 env = studio(dir, softEff, u_softness, u_spectral, u_shadows, u_warmColor, u_coolColor);
    float delta = u_dispersion * (0.004 + fres * fres * 0.06);
    vec3 envR = studio(vec3(dir.x, dir.y + delta, dir.z), softEff, u_softness, u_spectral, u_shadows, u_warmColor, u_coolColor);
    vec3 envB = studio(vec3(dir.x, dir.y - delta, dir.z), softEff, u_softness, u_spectral, u_shadows, u_warmColor, u_coolColor);
    vec3 col = vec3(envR.x, env.y, envB.z);

    col = col * u_environment * u_tint;
    col = vec3(1.0) - exp(-col);                          // gentle exposure tonemap, keeps chrome brilliance

    fragColor0 = vec4(mix(base.rgb, clamp(col, 0.0, 1.0), cover), mix(base.a, 1.0, cover));
}
