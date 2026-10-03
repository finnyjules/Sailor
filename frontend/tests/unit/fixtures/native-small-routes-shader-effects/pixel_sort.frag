#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_direction;  // 0 up, 1 down, 2 left, 3 right
uniform float u_low;        // threshold band low (luma)
uniform float u_high;       // threshold band high (luma)
uniform float u_length;     // max streak length (0..1 -> pixels)
uniform float u_mode;       // 0 brighten (carry lightest), 1 darken (carry darkest)

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
    vec2 texel = 1.0 / u_resolution;
    int dir = int(u_direction + 0.5);
    vec2 stp = (dir == 0) ? vec2(0.0, -texel.y)
             : (dir == 1) ? vec2(0.0,  texel.y)
             : (dir == 2) ? vec2(-texel.x, 0.0)
                          : vec2( texel.x, 0.0);
    vec2 march = -stp;   // walk against the streak to gather the span's extreme

    vec3 cur = texture(u_image0, v_texCoord).rgb;
    float curL = luma(cur);
    if (curL < u_low || curL > u_high) {   // pixels outside the band pass through
        fragColor0 = vec4(cur, 1.0);
        return;
    }

    int maxLen = int(clamp(u_length, 0.0, 1.0) * 252.0) + 4;
    bool darken = (u_mode >= 0.5);
    vec3 best = cur;
    float bestL = curL;
    vec2 uv = v_texCoord;
    for (int k = 0; k < 256; k++) {
        if (k >= maxLen) break;
        uv += march;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        vec3 c = texture(u_image0, uv).rgb;
        float l = luma(c);
        if (l < u_low || l > u_high) break;              // span boundary
        if (darken ? (l < bestL) : (l > bestL)) { bestL = l; best = c; }
    }
    fragColor0 = vec4(best, 1.0);
}
