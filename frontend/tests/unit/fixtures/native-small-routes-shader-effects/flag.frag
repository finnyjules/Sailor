#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbm3(vec2 p, float seed) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_anchor;     // 0 none · 1 left · 2 right · 3 top · 4 bottom
uniform float u_amplitude;
uniform float u_frequency;
uniform float u_speed;
uniform float u_gust;
uniform float u_shading;

void main() {
    int anchor = int(u_anchor + 0.5);
    vec2 uv = v_texCoord;

    // s runs 0 at the anchored edge -> 1 at the free edge; displacement is
    // perpendicular to the wind axis. Horizontal anchors wave along x and
    // displace y; vertical anchors wave along y and displace x.
    float s, across;
    vec2 dispAxis, windAxis;
    if (anchor == 3 || anchor == 4) {
        s = (anchor == 3) ? 1.0 - uv.y : uv.y;
        across = uv.x;
        dispAxis = vec2(1.0, 0.0);
        windAxis = (anchor == 3) ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
    } else {
        s = (anchor == 2) ? 1.0 - uv.x : uv.x;
        across = uv.y;
        dispAxis = vec2(0.0, 1.0);
        windAxis = (anchor == 2) ? vec2(-1.0, 0.0) : vec2(1.0, 0.0);
    }
    float env = (anchor == 0) ? 0.75 : smoothstep(0.0, 1.0, s);

    float t = u_time * u_speed;
    // Gust: slow FBM wobble travelling with the wind, so the wave never loops
    // robotically. Centered on 0.
    float gust = (fbm3(vec2(s * 2.0 - t * 0.7, across * 2.0), u_seed) - 0.5) * 2.0;
    float phase = s * u_frequency * 6.2831853 - t * 6.2831853
                + u_gust * gust * 2.0 + across * 0.9;
    // Primary wave + half-frequency harmonic; /1.5 keeps the sum in [-1,1].
    float wave = (sin(phase) + 0.5 * sin(phase * 0.5 + 1.7)) / 1.5;

    vec2 off = dispAxis * wave * env * u_amplitude;
    if (anchor != 0) {
        // Gravity sag toward the free edge (horizontal flags droop down;
        // vertical flags get a slight symmetric belly via the same term on x).
        float sag = 0.35 * u_amplitude * s * s;
        off += (anchor == 3 || anchor == 4) ? vec2(sag * 0.4, 0.0) : vec2(0.0, sag);
        // Fold compression: bunch the cloth along the wind on wave slopes.
        off += windAxis * (0.25 * u_amplitude * cos(phase) * env);
    }

    vec3 img = texture(u_image0, clamp(uv + off, 0.0, 1.0)).rgb;
    // Cloth shading from the wave slope — bright faces toward the light on
    // rising slopes, shadowed folds on falling ones.
    float light = 1.0 + u_shading * 0.45 * cos(phase) * env;
    fragColor0 = vec4(clamp(img * light, 0.0, 1.0), 1.0);
}
