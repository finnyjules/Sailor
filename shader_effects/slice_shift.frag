#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Slice-shift: cut the input into thin bands along one axis and offset each band
// sideways, so the silhouette tears into stepped, sawtooth-edged rows (the Sonar
// treatment). Unlike block_glitch (which forces fragColor.a = 1.0), this shader is
// ALPHA-AWARE: it samples and displaces the input's own alpha, so shifted bands
// leave genuinely transparent gaps that read through to whatever sits behind.

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}

uniform float u_axis;     // 0 horizontal, 1 vertical, 2 both
uniform float u_band;     // band size (fraction of the perpendicular dim)
uniform float u_amount;   // how far each band shifts (fraction of dim)
uniform float u_pattern;  // 0 random, 1 wave, 2 stair, 3 ping-pong
uniform float u_snap;     // 0 continuous, else quantize offset onto N stops
uniform float u_wrap;     // 0 transparent gaps, 1 wrap/clamp edge
uniform float u_ramp;     // 0 none, 1 top->bottom, 2 edges->center, 3 radial
uniform float u_speed;    // 0 static poster; >0 churns
uniform float u_step;     // jitter steps/sec (snap-in-time vs. slide)

// Per-band signed offset in [-1, 1]. `c` is the perpendicular coord, `laneId`
// separates the X-band set from the Y-band set when both axes are active, `tq`
// is the quantized time.
float bandOffset(float c, float laneId, float tq) {
    float band = max(u_band, 1e-4);
    float bi = floor(c / band);
    int pat = int(u_pattern + 0.5);
    float o;
    if (pat == 0) {                       // Random per band
        o = hash2(vec2(bi, laneId) + tq, u_seed) * 2.0 - 1.0;
    } else if (pat == 1) {                // Wave
        o = sin(bi * 0.6 + u_time * u_speed);
    } else if (pat == 2) {                // Stair: monotone ramp -> shear / faux-italic
        float total = max(1.0, floor(1.0 / band));
        o = (bi / total) * 2.0 - 1.0;
    } else {                              // Ping-pong: alternate every band
        o = mod(bi, 2.0) * 2.0 - 1.0;
    }
    if (u_snap >= 1.0) o = floor(o * u_snap + 0.5) / u_snap;
    return o;
}

// Optional attenuation of the shift by position.
float falloff(vec2 uv) {
    int r = int(u_ramp + 0.5);
    if (r == 1) return 1.0 - uv.y;                                   // top clean -> bottom full
    if (r == 2) return max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0;  // edges full -> center clean
    if (r == 3) return clamp(length(uv - 0.5) * 2.0, 0.0, 1.0);      // radial
    return 1.0;                                                       // None
}

void main() {
    vec2 uv = v_texCoord;
    int axis = int(u_axis + 0.5);
    float jstep = max(1.0, u_step);
    float tq = floor(u_time * u_speed * jstep) / jstep;
    float f = falloff(uv);

    vec2 offVec = vec2(0.0);
    if (axis == 0 || axis == 2) {                 // Horizontal: bands on Y (yDown), shift X
        float o = bandOffset(1.0 - uv.y, 0.0, tq);
        offVec.x += o * u_amount * f;
    }
    if (axis == 1 || axis == 2) {                 // Vertical: bands on X, shift Y
        float o = bandOffset(uv.x, 1.0, tq);
        offVec.y += o * u_amount * f;
    }

    vec2 suv = uv + offVec;

    if (int(u_wrap + 0.5) == 0) {
        // Transparent: a band shifted out of bounds leaves a see-through gap.
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
            fragColor0 = vec4(0.0);
        } else {
            fragColor0 = texture(u_image0, suv);  // full rgba, alpha preserved
        }
    } else {
        // Wrap/clamp: smear the edge pixel outward, staying opaque.
        fragColor0 = texture(u_image0, clamp(suv, 0.0, 1.0));
    }
}
