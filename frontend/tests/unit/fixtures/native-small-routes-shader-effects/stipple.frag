#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_density;   // dots across the short axis
uniform float u_jitter;    // 0..1 positional randomness
uniform float u_dotSize;   // radius multiplier
uniform float u_contrast;  // shapes darkness -> dot radius
uniform float u_mode;      // 0 ink on paper, 1 image color on white, 2 image color on black

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    float dens = max(u_density, 4.0);
    vec2 g = v_texCoord * asp * dens;      // grid space
    vec2 cell = floor(g);
    vec2 f = fract(g);

    // Walk the 3x3 neighborhood so jittered dots can spill across cell borders.
    float ink = 0.0;                       // coverage of the winning dot
    vec3 dotCol = vec3(0.0);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 nc = cell + vec2(float(x), float(y));
            vec2 jit = (hash22(nc + u_seed) - 0.5) * u_jitter;
            vec2 center = vec2(float(x), float(y)) + 0.5 + jit;
            vec2 uvc = (nc + 0.5 + jit) / dens / asp;   // where this dot samples the image
            vec3 col = texture(u_image0, clamp(uvc, 0.0, 1.0)).rgb;
            float lum = dot(col, vec3(0.299, 0.587, 0.114));
            float dark = pow(clamp(1.0 - lum, 0.0, 1.0), max(u_contrast, 0.001));
            float radius = sqrt(dark) * 0.5 * u_dotSize;
            float d = length(f - center);
            float aa = fwidth(d) + 1e-4;
            float cov = smoothstep(radius, radius - aa, d);
            if (cov > ink) { ink = cov; dotCol = col; }   // nearest/topmost dot wins
        }
    }

    int m = int(u_mode + 0.5);
    vec3 paper = (m == 2) ? vec3(0.0) : vec3(1.0);
    vec3 fill  = (m == 0) ? vec3(0.0) : dotCol;
    vec3 outc = mix(paper, fill, ink);
    fragColor0 = vec4(outc, 1.0);
}
