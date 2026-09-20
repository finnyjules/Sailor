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

uniform float u_slices;   // which way the cuts run: 0 rows, 1 columns, 2 grid
uniform float u_shift;    // which way they move:    0 horizontal, 1 vertical, 2 both
uniform float u_band;     // band size (fraction of the perpendicular dim)
uniform float u_amount;   // how far each band shifts (fraction of dim)
uniform float u_pattern;  // 0 random, 1 wave, 2 stair, 3 ping-pong
uniform float u_snap;     // 0 continuous, else quantize offset onto N stops
uniform float u_wrap;     // 0 transparent gaps, 1 wrap/clamp edge
uniform float u_ramp;     // 0 none, 1 top->bottom, 2 edges->center, 3 radial
uniform float u_step;     // jitter steps/sec (snap-in-time vs. slide)

// Animation is driven by the fill's own clock (u_time, already scaled by the
// fill/studio "Speed"). A separate per-effect speed would be a second control on
// the same clock — and, defaulting to 0, would silently pin that global Speed to
// no-op — so this shader has none. Speed 0 on the fill = a static poster.

// Per-band signed offset in [-1, 1]. `c` is the perpendicular coord, `laneId`
// separates the X-band set from the Y-band set when both axes are active, `tick`
// is an INTEGER time-step counter (u_step steps per unit u_time).
float bandOffset(float c, float laneId, float tick) {
    float band = max(u_band, 1e-4);
    float bi = floor(c / band);
    int pat = int(u_pattern + 0.5);
    float o;
    if (pat == 0) {                       // Random per band
        // hash2 casts its vec2 arg through ivec2, so a fractional time added there
        // would be truncated away (the band would only reshuffle at whole u_time).
        // Feed the integer step counter through the SEED channel instead, so every
        // step decorrelates cleanly at the Step rate.
        o = hash2(vec2(bi, laneId), u_seed + tick) * 2.0 - 1.0;
    } else if (pat == 1) {                // Wave
        o = sin(bi * 0.6 + u_time);
    } else if (pat == 2) {                // Stair: monotone ramp -> shear / faux-italic
        float total = max(1.0, floor(1.0 / band));
        o = (bi / total) * 2.0 - 1.0;
    } else {                              // Ping-pong: alternate every band
        o = mod(bi, 2.0) * 2.0 - 1.0;
    }
    if (u_snap >= 1.0) o = floor(o * u_snap + 0.5) / u_snap;
    return o;
}

// Optional attenuation of the shift by position. Directional ramps read
// "<clean end> to <full end>": intensity rises from the clean end to the torn end.
// (uv.y = 1 is the visual TOP.) Existing values 1..3 are kept stable; new
// directions are appended so saved presets never remap.
float falloff(vec2 uv) {
    int r = int(u_ramp + 0.5);
    if (r == 1) return 1.0 - uv.y;                                   // Top to bottom
    if (r == 2) return max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0;  // Edges to center (center clean)
    if (r == 3) return clamp(length(uv - 0.5) * 2.0, 0.0, 1.0);      // Radial (center clean)
    if (r == 4) return uv.y;                                         // Bottom to top
    if (r == 5) return uv.x;                                         // Left to right
    if (r == 6) return 1.0 - uv.x;                                   // Right to left
    return 1.0;                                                       // None
}

void main() {
    vec2 uv = v_texCoord;
    // Slices (which way the cuts run) and Shift (which way they move) are
    // INDEPENDENT: a Columns slice can move Horizontally, etc. Each active slice
    // set's per-band offset is applied to each active shift axis.
    int sl = int(u_slices + 0.5);                 // 0 rows, 1 columns, 2 grid
    int sh = int(u_shift + 0.5);                  // 0 horizontal, 1 vertical, 2 both
    bool rows   = (sl == 0 || sl == 2);
    bool cols   = (sl == 1 || sl == 2);
    bool shiftX = (sh == 0 || sh == 2);
    bool shiftY = (sh == 1 || sh == 2);
    float jstep = max(1.0, u_step);
    float tick = floor(u_time * jstep);           // integer step counter -> Step snaps/sec
    float f = falloff(uv);

    vec2 offVec = vec2(0.0);
    if (rows) {                                   // row-bands indexed down Y (lane 0)
        float o = bandOffset(1.0 - uv.y, 0.0, tick) * u_amount * f;
        if (shiftX) offVec.x += o;
        if (shiftY) offVec.y += o;
    }
    if (cols) {                                   // column-bands indexed across X (lane 1)
        float o = bandOffset(uv.x, 1.0, tick) * u_amount * f;
        if (shiftX) offVec.x += o;
        if (shiftY) offVec.y += o;
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
