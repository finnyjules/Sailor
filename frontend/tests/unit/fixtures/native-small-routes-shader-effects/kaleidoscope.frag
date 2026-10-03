#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_mode;      // 0 Wedge, 1 Nested, 2 Square (p4m), 3 Hex (p6m)
uniform float u_segments;
uniform float u_rotation;
uniform float u_zoom;
uniform float u_speed;     // adds to rotation over time (0 = still)
uniform float u_edge;      // 0 Mirror-tile, 1 Clamp, 2 Transparent
uniform float u_centerX;
uniform float u_centerY;

const float TAU = 6.28318530718;

vec2 mirrorWrap(vec2 uv) { return abs(fract(uv * 0.5) * 2.0 - 1.0); }

// Sample the input asset, handling out-of-bounds per the Edge mode.
vec4 sampleEdge(vec2 uv) {
    int e = int(u_edge + 0.5);
    if (e == 1) return vec4(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, 1.0);
    if (e == 2) {
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
        return vec4(texture(u_image0, uv).rgb, 1.0);
    }
    return vec4(texture(u_image0, mirrorWrap(uv)).rgb, 1.0);
}

// Fold an angle into a mirrored wedge of width seg.
float wedge(float a, float seg) {
    a = mod(a, seg);
    return abs(a - seg * 0.5);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 center = vec2(u_centerX, u_centerY);
    vec2 p = (v_texCoord - center) * asp;
    float rot = radians(u_rotation) + u_time * u_speed;
    float segs = max(u_segments, 2.0);
    int m = int(u_mode + 0.5);

    vec2 uv;
    if (m == 0) {                      // Wedge — original kaleidoscope behavior
        float r = length(p);
        float a = wedge(atan(p.y, p.x) + rot, TAU / segs);
        uv = vec2(cos(a), sin(a)) * r * u_zoom / asp + center;
    } else if (m == 1) {               // Nested — recursive double fold
        float r = length(p) * u_zoom;
        float a = atan(p.y, p.x) + rot;
        float seg = TAU / segs;
        a = wedge(a, seg);
        a = wedge(a, seg * 0.5);       // second, finer fold -> nested petals
        r = abs(fract(r * 1.5) * 2.0 - 1.0) * 0.6 + r * 0.25;  // repeating shells
        uv = vec2(cos(a), sin(a)) * r / asp + center;
    } else if (m == 2) {               // Square wallpaper (p4m)
        vec2 g = p * u_zoom * (segs * 0.5);
        vec2 cell = abs(fract(g) * 2.0 - 1.0);   // pmm mirror cell
        if (cell.x < cell.y) cell = cell.yx;     // diagonal fold -> 4mm
        uv = cell;
    } else {                           // Hex wallpaper (p6m)
        vec2 g = p * u_zoom * (segs * 0.5);
        // nearest hexagon center (two candidate sublattices)
        vec2 s = vec2(1.0, 1.7320508);
        vec4 hc = floor(vec4(g, g - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
        vec4 h = vec4(g - hc.xy * s, g - (hc.zw + 0.5) * s);
        vec2 local = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
        // 6-fold dihedral fold inside the cell
        float a = wedge(atan(local.y, local.x) + rot, TAU / 6.0);
        uv = vec2(cos(a), sin(a)) * length(local) + 0.5;
    }

    fragColor0 = sampleEdge(uv);
}
