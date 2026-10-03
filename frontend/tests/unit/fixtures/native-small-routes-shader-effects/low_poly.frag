#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_scale;   // triangles across the short axis
uniform float u_jitter;  // vertex randomness (organic vs regular)
uniform float u_edges;   // wireframe darkness
uniform float u_shade;   // facet lighting amount

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

const float F2 = 0.3660254038;   // (sqrt(3)-1)/2
const float G2 = 0.2113248654;   // (3-sqrt(3))/6

// Unskew a simplex lattice index back into p-space.
vec2 cornerPos(vec2 latt) {
    return latt - (latt.x + latt.y) * G2;
}

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    float dens = max(u_scale, 2.0);
    vec2 p = v_texCoord * asp * dens;

    // 2D simplex cell: pick the triangle this fragment lands in.
    float s = (p.x + p.y) * F2;
    vec2 i = floor(p + s);
    float t = (i.x + i.y) * G2;
    vec2 d0 = p - (i - t);
    vec2 i1 = (d0.x > d0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);

    vec2 c0 = i;
    vec2 c1 = i + i1;
    vec2 c2 = i + vec2(1.0, 1.0);

    // Jitter each triangle vertex in p-space for the hand-cut low-poly look.
    vec2 j0 = cornerPos(c0) + (hash22(c0 + u_seed) - 0.5) * u_jitter;
    vec2 j1 = cornerPos(c1) + (hash22(c1 + u_seed) - 0.5) * u_jitter;
    vec2 j2 = cornerPos(c2) + (hash22(c2 + u_seed) - 0.5) * u_jitter;

    vec2 triCenter = (j0 + j1 + j2) / 3.0;
    vec2 uvc = triCenter / dens / asp;
    vec3 col = texture(u_image0, clamp(uvc, 0.0, 1.0)).rgb;

    // Subtle per-facet shading so adjacent triangles read as distinct planes.
    if (u_shade > 0.0) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col *= mix(1.0, 0.78 + 0.44 * lum, u_shade);
    }

    // Optional wireframe: darken near the jittered triangle edges.
    if (u_edges > 0.0) {
        float d = min(min(segDist(p, j0, j1), segDist(p, j1, j2)), segDist(p, j2, j0));
        float aa = fwidth(d) + 1e-4;
        float line = 1.0 - smoothstep(0.0, aa * 1.6, d);
        col = mix(col, vec3(0.0), line * u_edges);
    }

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
