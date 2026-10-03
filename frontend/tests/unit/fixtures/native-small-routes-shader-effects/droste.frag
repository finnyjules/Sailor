#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_mode;     // 0 Zoom, 1 Spiral, 2 Tunnel
uniform float u_scale;    // size ratio between recursion levels
uniform float u_twist;    // spiral strength (Spiral mode)
uniform float u_speed;    // infinite-zoom drift rate (0 = still)
uniform float u_zoom;
uniform float u_edge;     // 0 Mirror-tile, 1 Clamp, 2 Transparent
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

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 center = vec2(u_centerX, u_centerY);
    vec2 c = (v_texCoord - center) * asp;

    float radius = length(c);
    float angle = atan(c.y, c.x);
    vec2 lp = vec2(log(max(radius, 1e-4)), angle);   // log-polar

    float ratio = log(max(u_scale, 1.05));           // log-period per recursion
    float drift = u_time * u_speed;
    int m = int(u_mode + 0.5);

    if (m == 1) {                       // Spiral — logarithmic-spiral shear
        lp.y += u_twist * lp.x;                       // angle sheared by radius
    }

    lp.x = mod(lp.x - drift, ratio);                 // wrap into one annulus
    if (m == 2) {                       // Tunnel — mirror the shells for symmetry
        lp.x = abs(lp.x - ratio * 0.5);
    }

    float er = exp(lp.x);                            // radius within one recursion band
    vec2 dir = vec2(cos(lp.y), sin(lp.y));
    vec2 uv = dir * er * u_zoom * (0.5 / max(u_scale, 1.05)) / asp + center;
    fragColor0 = sampleEdge(uv);
}
