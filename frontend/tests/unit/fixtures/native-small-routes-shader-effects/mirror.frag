#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_mode;     // 0 Axis, 1 Quad, 2 Octal, 3 Mirror-ball
uniform float u_angle;    // mirror axis orientation, degrees
uniform float u_zoom;
uniform float u_speed;    // axis rotation over time (0 = still)
uniform float u_edge;     // 0 Mirror-tile, 1 Clamp, 2 Transparent
uniform float u_centerX;
uniform float u_centerY;

// triangle-wave mirror wrap: keeps samples in-bounds with no seam
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
    vec2 p = (v_texCoord - center) * asp;

    float ang = radians(u_angle) + u_time * u_speed;
    float c = cos(ang), s = sin(ang);
    mat2 R = mat2(c, -s, s, c);       // world -> axis frame
    mat2 Rinv = mat2(c, s, -s, c);    // axis frame -> world
    vec2 q = (R * p) * u_zoom;

    int m = int(u_mode + 0.5);
    if (m == 0) {                     // Axis: reflect across one line
        q.x = abs(q.x);
    } else if (m == 1) {              // Quad: reflect across both axes
        q = abs(q);
    } else if (m == 2) {              // Octal: 8-fold dihedral fold
        q = abs(q);
        if (q.x < q.y) q = q.yx;      // fold across the diagonal -> 1/8 wedge
    } else {                          // Mirror-ball: chrome sphere reflection
        float r2 = dot(q, q);
        if (r2 < 1.0) {
            float z = sqrt(1.0 - r2);
            vec3 nrm = vec3(q, z);
            vec3 refl = reflect(vec3(0.0, 0.0, -1.0), nrm);
            q = refl.xy / (1.0 + refl.z);   // stereographic projection to plane
        } else {
            q = (r2 > 0.0) ? q * inversesqrt(r2) : q;  // rim
        }
    }

    vec2 uv = (Rinv * q) / asp + center;
    fragColor0 = sampleEdge(uv);
}
