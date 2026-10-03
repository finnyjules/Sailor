#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_levels;     // number of contour lines
uniform float u_thickness;  // line thickness
uniform float u_mode;       // 0 over image, 1 dark lines on paper, 2 glow lines on dark
uniform float u_bands;      // hypsometric band tint amount

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Topographic hypsometric ramp: low = teal, mid = green/olive, high = warm tan.
vec3 ramp(float t) {
    vec3 a = vec3(0.05, 0.18, 0.28), b = vec3(0.13, 0.42, 0.32);
    vec3 c = vec3(0.62, 0.55, 0.30), d = vec3(0.85, 0.80, 0.72);
    return (t < 0.5) ? mix(a, b, t * 2.0) : mix(c, d, (t - 0.5) * 2.0);
}

void main() {
    vec3 src = texture(u_image0, v_texCoord).rgb;
    float lum = luma(src);
    float lv = max(u_levels, 1.0);
    float f = lum * lv;

    // Iso-lines at integer crossings, anti-aliased via screen-space derivative.
    float aa = fwidth(f);
    float dEdge = abs(fract(f + 0.5) - 0.5);   // 0 at each level crossing
    float th = max(u_thickness, 0.01);
    float line = 1.0 - smoothstep(0.0, th * 0.5 + aa, dEdge);

    int m = int(u_mode + 0.5);
    vec3 bg = (m == 1) ? vec3(0.96, 0.94, 0.88)
            : (m == 2) ? vec3(0.03, 0.04, 0.06)
                       : src;

    if (u_bands > 0.0) {
        vec3 tint = ramp(clamp(floor(f) / lv, 0.0, 1.0));
        bg = mix(bg, tint, u_bands);
    }

    vec3 lineCol = (m == 2) ? vec3(0.55, 0.95, 0.75) : vec3(0.10, 0.12, 0.10);
    fragColor0 = vec4(mix(bg, lineCol, line), 1.0);
}
