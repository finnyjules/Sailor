#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// STUDIO BACKDROP: a photographer's cove — a wall that curves down into a floor —
// lit by an overhead key light pooling on the stage, two side fills, an upward
// back wash on the wall, an ambient level, and soft ambient lights that drift.
// A port of the Shaders.com "StudioBackground" component (the "Fluid Chrome"
// design's values are the defaults). Generative: it ignores its input.
//
// v_texCoord.y = 1 is the visual top. Percent dials keep the component's 0–100
// ranges so a design's numbers carry over as they are.

uniform vec3  u_surface;         // base surface colour
uniform vec3  u_keyColor;        // overhead key light
uniform float u_keyIntensity;    // 0–100
uniform float u_keySoftness;     // 0–100, how diffuse the key is
uniform vec3  u_fillColor;       // the two side fills
uniform float u_fillIntensity;   // 0–100
uniform float u_fillSoftness;    // 0–100
uniform float u_fillSpread;      // 0–100, how far apart the fills sit
uniform vec3  u_backColor;       // upward wash on the wall
uniform float u_backIntensity;   // 0–100
uniform float u_backSoftness;    // 0–100
uniform float u_ambient;         // 0–100, overall ambient level
uniform float u_vignette;        // 0–100, edge darkening
uniform float u_centerX;         // where the key light meets the floor
uniform float u_centerY;
uniform float u_lightDepth;      // 0–100, spotlights aim at the wall (0) .. the floor (100)
uniform float u_wallCurvature;   // 0–100, how rounded the cove is
uniform float u_ambientDetail;   // 0–100, drifting ambient lights

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
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return s;
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 uv = v_texCoord;
    float x = uv.x * asp.x;                    // aspect-corrected
    float v = 1.0 - uv.y;                      // 0 at the visual top, 1 at the bottom
    float sx = u_centerX * asp.x;              // stage centre
    float sv = 1.0 - u_centerY;

    // ---- The cove: wall above the fold, floor below, a soft fold between ----
    float fold = sv - 0.05;                                        // where wall meets floor
    float cw = mix(0.01, 0.16, u_wallCurvature / 100.0);           // how rounded the fold is
    float isFloor = smoothstep(fold - cw, fold + cw, v);
    float wallT = clamp(v / max(fold, 1e-3), 0.0, 1.0);            // 0 top of wall .. 1 fold

    // ---- Key light: a beam widening up the wall, pooling on the floor ----
    float depthT = u_lightDepth / 100.0;                           // 0 aims at the wall, 1 at the floor
    float softK = mix(0.3, 1.6, u_keySoftness / 100.0);
    float dx = x - sx;
    float wBeam = mix(0.11, 0.38, 1.0 - wallT) * softK;            // wider toward the top
    float beam = exp(-(dx * dx) / (wBeam * wBeam));
    float beamV = mix(0.6, 1.0, pow(wallT, 1.5));                  // brighter near the pool
    beamV *= mix(1.0, 0.75, depthT * (1.0 - wallT));               // aimed at the floor: the top dims
    float keyWall = beam * beamV * (1.0 - isFloor) * 0.62;
    float poolV = (v - sv) / (0.06 * softK + 0.03);
    float poolX = dx / (0.22 * softK);
    float pool = exp(-(poolX * poolX + poolV * poolV)) * mix(0.5, 1.4, depthT);
    float floorGlow = exp(-(dx * dx) / (0.5 * 0.5)) * exp(-abs(v - sv) / 0.22) * 0.5;
    float keyFloor = (pool + floorGlow) * isFloor;
    float key = (keyWall + keyFloor) * (u_keyIntensity / 100.0) * 2.2;

    // ---- Two side fills: soft blobs low on the wall, either side of the stage ----
    float spread = mix(0.15, 0.95, u_fillSpread / 100.0) * asp.x * 0.5;
    float softF = mix(0.12, 0.42, u_fillSoftness / 100.0);
    float fill = 0.0;
    for (int i = 0; i < 2; i++) {
        float fx = sx + (i == 0 ? -spread : spread);
        float fv = fold - 0.22;
        float ddx = (x - fx) / softF, ddv = (v - fv) / (softF * 1.4);
        fill += exp(-(ddx * ddx + ddv * ddv));
    }
    fill *= (u_fillIntensity / 100.0) * 4.0;

    // ---- Back wash: light climbing the wall from the fold, and the floor's near edge ----
    float softB = mix(0.05, 0.5, u_backSoftness / 100.0);
    float back = (1.0 - isFloor) * exp(-max(fold - v, 0.0) / softB)
               + isFloor * exp(-max(v - fold, 0.0) / (softB * 1.5)) * 0.6;
    back *= (u_backIntensity / 100.0) * 0.9;

    // ---- Drifting ambient lights: broad, faint, slowly wandering ----
    vec2 drift = vec2(u_time * 0.04, -u_time * 0.025);
    float seedFold = mod(u_seed, 97.0) + floor(u_seed / 97.0) * 0.3711;
    float blobs = fbm(vec2(x, v) * 1.4 + drift + seedFold * 3.1);
    float detail = (blobs - 0.5) * (u_ambientDetail / 100.0) * 0.16;

    // ---- Compose: the surface under each light ----
    float ambient = 0.14 + (u_ambient / 100.0) * 1.5;
    vec3 col = u_surface * ambient;
    // The set falls away from the stage: corners sit darker even with no vignette.
    vec2 away = vec2((x - sx) / asp.x, (v - sv) * 1.1);
    col *= 1.0 - 0.28 * smoothstep(0.35, 1.3, length(away));
    col *= 1.0 + detail;
    col += u_surface * u_keyColor * key;
    col += u_surface * u_fillColor * fill;
    col += u_surface * u_backColor * back;
    // The floor sits a touch darker than the wall away from the lights, and the far
    // bottom edge falls off.
    col *= mix(1.0, 0.92, isFloor) * (1.0 - 0.25 * smoothstep(sv + 0.05, 1.05, v));

    // ---- Vignette ----
    vec2 vq = uv * 2.0 - 1.0;
    float vig = 1.0 - (u_vignette / 100.0) * smoothstep(0.45, 1.6, dot(vq, vq));
    col *= vig;

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
